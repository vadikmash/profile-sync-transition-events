import { type Tier, parseTier } from './tier';
import type { EngagementClient, Logger } from './types';

export type PreviousMembershipState = {
  tier: Tier | null;
  notifiedTier: Tier | null;
};

/**
 * Reads each membership's stored tiers back in one lookup. The platform doubles as the "previous
 * value" store, so there is no table to own.
 *
 * Lookup errors propagate on purpose. `client.getProfile` returns null for a new user, which gives
 * an empty map (a first sync). Any real failure aborts the sync: treating it as "nothing stored"
 * would quietly re-baseline every membership.
 *
 * @returns a map of membershipId to the state the platform currently holds for it
 */
export async function getPreviousMembershipStates(
  log: Logger,
  client: EngagementClient,
  email: string
): Promise<Map<string, PreviousMembershipState>> {
  const storedProfile = await client.getProfile(email);
  const memberships = storedProfile?.memberships ?? [];

  const previousStates = new Map<string, PreviousMembershipState>();
  memberships.forEach((membership) => {
    const tier = parseTier(membership.tier);
    const notifiedTier = parseTier(membership.notifiedTier);

    // Warn on values we don't recognize, since that is bad data. Missing values stay quiet: null,
    // or undefined for profiles that predate the field.
    if ((!tier && membership.tier != null) || (!notifiedTier && membership.notifiedTier != null)) {
      log.warn(
        {
          membershipId: membership.membershipId,
          storedTier: membership.tier,
          storedNotifiedTier: membership.notifiedTier,
        },
        'Unrecognized tier stored in the profile; ignoring the unrecognized value'
      );
    }

    previousStates.set(membership.membershipId, { tier, notifiedTier });
  });

  return previousStates;
}
