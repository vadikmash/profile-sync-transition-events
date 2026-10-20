import type { PreviousMembershipState } from './previousState';
import { type MembershipPoints, getTierForMembership, isForwardTierTransition } from './tier';
import type { TierTransition } from './transition';
import type { Profile } from './types';

export type UserRecord = {
  id: string;
  email: string;
  deletedAt?: Date | null;
};

export type MembershipRecord = MembershipPoints & {
  id: string;
  name: string;
  closedAt?: Date | null;
  communicationsOptOutAt?: Date | null;
  deletedAt?: Date | null;
};

export type ProfileWithTransitions = {
  /** Holds every transition back: `notifiedTier` stays put until {@link markNotified} moves it. */
  profile: Profile;
  /** Memberships that moved up since the last tier a journey was told about. */
  transitions: TierTransition[];
  /** How many moves a rule consumed without sending (closed, deleted, opted out, deleted user). */
  suppressed: number;
};

/**
 * Closed, deleted and opted-out memberships, and every membership of a deleted user (backfill jobs
 * load those too), stay in the profile but never fire. The opt-out is handled here, not in the
 * journey, which would have to look the membership up by id to honor it.
 */
function isSuppressed(user: UserRecord, membership: MembershipRecord): boolean {
  return [user.deletedAt, membership.closedAt, membership.deletedAt, membership.communicationsOptOutAt].some(Boolean);
}

/** Pure, no I/O: whatever the platform currently holds comes in as `previousStates`. */
export function buildProfileWithTransitions(
  user: UserRecord,
  memberships: MembershipRecord[],
  previousStates: Map<string, PreviousMembershipState>
): ProfileWithTransitions {
  const transitions: TierTransition[] = [];
  let suppressed = 0;

  const profileMemberships = memberships.map((membership) => {
    const previousState = previousStates.get(membership.id);
    // Profiles stored before notifiedTier existed fall back to their stored tier.
    const baseline = previousState?.notifiedTier ?? previousState?.tier ?? null;
    const tierResult = getTierForMembership(membership);

    // Only moves up, so a corrected lower tier doesn't rewind it and re-entering a tier is quiet.
    let notifiedTier = baseline;

    if (tierResult) {
      if (!baseline) {
        // First sync, or nothing readable stored: record where we are, there is nothing to announce.
        notifiedTier = tierResult.tier;
      } else if (isForwardTierTransition(baseline, tierResult.tier)) {
        if (isSuppressed(user, membership)) {
          // Consumed, not held: after an opt-in or a reopen it would be old news.
          notifiedTier = tierResult.tier;
          suppressed += 1;
        } else {
          // Held at the baseline until the event is confirmed sent. One transition per membership,
          // however many tiers it jumped.
          transitions.push({
            membershipId: membership.id,
            membershipName: membership.name,
            previousTier: baseline,
            newTier: tierResult.tier,
            tierEstimated: tierResult.estimated,
            pointsSource: tierResult.pointsSource,
          });
        }
      }
    }

    return { membershipId: membership.id, name: membership.name, tier: tierResult?.tier ?? null, notifiedTier };
  });

  return {
    profile: { id: user.id, email: user.email, memberships: profileMemberships },
    transitions,
    suppressed,
  };
}

/** Moves `notifiedTier` for the given transitions, and only those. */
export function markNotified(profile: Profile, transitions: TierTransition[]): Profile {
  const newTierByMembershipId = new Map(transitions.map((transition) => [transition.membershipId, transition.newTier]));

  return {
    ...profile,
    memberships: profile.memberships.map((membership) => {
      const newTier = newTierByMembershipId.get(membership.membershipId);

      return newTier ? { ...membership, notifiedTier: newTier } : membership;
    }),
  };
}
