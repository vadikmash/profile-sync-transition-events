import { type MembershipRecord, type UserRecord, buildProfileWithTransitions, markNotified } from './buildProfile';
import { getPreviousMembershipStates } from './previousState';
import { sendTransitionEvents } from './sendTransitionEvents';
import { TIER_TRANSITIONED_EVENT_NAME } from './transition';
import type { EngagementClient, Logger, Metrics } from './types';

export type SyncDeps = {
  client: EngagementClient;
  log: Logger;
  /** The sending switch. Events stay off (a dark launch) unless this says otherwise. */
  isTransitionEventsEnabled?: () => boolean;
  metrics?: Metrics;
  sendConcurrency?: number;
};

// Log pipelines truncate big events and some accounts hold thousands of memberships, so the logged
// list is capped. `darkLaunchedTransitions` beside it is exact.
const MAX_LOGGED_DARK_TRANSITIONS = 50;

export async function syncProfile(deps: SyncDeps, user: UserRecord, memberships: MembershipRecord[]): Promise<void> {
  const { client, log } = deps;
  const isEnabled = deps.isTransitionEventsEnabled ?? (() => false);

  // Zero is skipped, so a sync with nothing to report emits nothing.
  const count = (name: string, value: number): void => {
    if (value > 0) {
      deps.metrics?.increment(`tierTransition.${name}`, value);
    }
  };

  try {
    const previousStates = await getPreviousMembershipStates(log, client, user.email);
    const { profile, transitions, suppressed } = buildProfileWithTransitions(user, memberships, previousStates);
    const hasTransitions = transitions.length > 0;
    const willSend = hasTransitions && isEnabled();
    const isDarkLaunch = hasTransitions && !willSend;

    // A dark launch consumes what it detects. Nothing is sent, so notifiedTier moves now: holding
    // the moves instead would release all of them the moment someone flips the switch.
    const profileToWrite = isDarkLaunch ? markNotified(profile, transitions) : profile;

    // Profile first, so a journey never reads a field that contradicts the event it just got. If
    // this write fails nothing was recorded, and the next sync detects the move again.
    const profileUpdateResult = await client.upsertProfile(profileToWrite);

    if (profileUpdateResult !== 'sent') {
      // 'skipped' (tracking off) is a silent no-op. Only a real failure with something at stake warns.
      if (profileUpdateResult === 'failed' && hasTransitions) {
        log.warn(
          { userId: user.id, heldTransitions: transitions.length },
          `${TIER_TRANSITIONED_EVENT_NAME} profile update failed; transitions stay held for the next sync`
        );
      }

      return;
    }

    count('suppressed', suppressed);

    if (isDarkLaunch) {
      count('darkLaunched', transitions.length);
      log.info(
        {
          userId: user.id,
          darkLaunchedTransitions: transitions.length,
          transitions: transitions.slice(0, MAX_LOGGED_DARK_TRANSITIONS).map((transition) => ({
            membershipId: transition.membershipId,
            previousTier: transition.previousTier,
            newTier: transition.newTier,
          })),
        },
        `${TIER_TRANSITIONED_EVENT_NAME} events are off; consuming without sending`
      );

      return;
    }

    if (!willSend) {
      return;
    }

    const summary = await sendTransitionEvents(log, client, user, transitions, {
      concurrency: deps.sendConcurrency,
    });

    count('sent', summary.sent.length);
    count('failed', summary.failed);
    count('skipped', summary.skipped);
    count('notAttempted', summary.notAttempted);

    // Only now does notifiedTier move, and only for confirmed sends. If this write fails, the next
    // sync sends again under the same event id.
    if (summary.sent.length > 0) {
      const recorded = await client.upsertProfile(markNotified(profile, summary.sent));

      if (recorded === 'failed') {
        log.warn(
          { userId: user.id, sentTransitions: summary.sent.length },
          'Could not record notified tiers; the next sync will re-send, deduplicated by event id'
        );
      }
    }
  } catch (err) {
    log.error({ err }, 'syncProfile error syncing user');
  }
}
