import { TIER_TRANSITIONED_EVENT_NAME, type TierTransition } from './transition';
import type { EngagementClient, Logger } from './types';

export const DEFAULT_SEND_CONCURRENCY = 5;

export type SendSummary = {
  /** Confirmed sent. Only these are safe to mark as notified. */
  sent: TierTransition[];
  /** Includes unexpected throws. */
  failed: number;
  skipped: number;
  /** Never started, because an earlier send failed. */
  notAttempted: number;
};

/**
 * Sends one tierTransitioned event per transition, a few at a time.
 *
 * 'failed' means the client already used up its retries, so the platform is likely down: stop
 * starting sends instead of paying a retry budget per remaining membership. Whatever isn't
 * confirmed sent stays held for the next sync. 'skipped' (tracking off) is silent. A throw is a bug
 * in one send, so the others carry on.
 *
 * postEvent reports trouble through its result, so the catch below only covers surprises.
 */
export async function sendTransitionEvents(
  log: Logger,
  client: EngagementClient,
  user: { id: string; email: string },
  transitions: TierTransition[],
  { concurrency = DEFAULT_SEND_CONCURRENCY }: { concurrency?: number } = {}
): Promise<SendSummary> {
  const sent: TierTransition[] = [];
  let failed = 0;
  let skipped = 0;
  let attempted = 0;
  let platformDown = false;

  const sendOne = async (transition: TierTransition): Promise<void> => {
    const logFields = {
      userId: user.id,
      membershipId: transition.membershipId,
      previousTier: transition.previousTier,
      newTier: transition.newTier,
    };

    try {
      const result = await client.postEvent({
        // Email only, see EngagementEvent.email.
        email: user.email,
        eventName: TIER_TRANSITIONED_EVENT_NAME,
        // One id per (user, membership, tier). Racing syncs, and a re-send after a success that was
        // never recorded, then upsert a single event, while a membership shared by two users still
        // yields one each. notifiedTier keeps a re-entered tier quiet over time, so dedupe only has
        // to cover those short windows.
        id: [TIER_TRANSITIONED_EVENT_NAME, user.id, transition.membershipId, transition.newTier].join(':'),
        dataFields: transition,
      });

      if (result === 'sent') {
        sent.push(transition);
        log.info(logFields, `Sent ${TIER_TRANSITIONED_EVENT_NAME} event`);
      } else if (result === 'failed') {
        failed += 1;
        platformDown = true;
        log.warn(logFields, `${TIER_TRANSITIONED_EVENT_NAME} event failed to send; held for the next sync`);
      } else {
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      log.error({ err, ...logFields }, `Error sending ${TIER_TRANSITIONED_EVENT_NAME} event`);
    }
  };

  const worker = async (): Promise<void> => {
    while (!platformDown) {
      const transition = transitions[attempted];
      if (!transition) {
        return;
      }

      attempted += 1;
      await sendOne(transition);
    }
  };

  const workers = Math.min(Math.max(1, Math.floor(concurrency)), transitions.length);
  await Promise.all(Array.from({ length: workers }, worker));

  const notAttempted = transitions.length - attempted;

  if (notAttempted > 0) {
    log.warn(
      { userId: user.id, notAttempted },
      `Stopped sending ${TIER_TRANSITIONED_EVENT_NAME} events after a failed send; the rest are held for the next sync`
    );
  }

  return { sent, failed, skipped, notAttempted };
}
