import type { PointsSource, Tier } from './tier';

// Shared by detection and sending, so it sits in its own module with no imports back into either.
export const TIER_TRANSITIONED_EVENT_NAME = 'tierTransitioned';

export type TierTransition = {
  membershipId: string;
  membershipName: string;
  previousTier: Tier;
  newTier: Tier;
  /** True when the tier rests on migrated points, so it may be off. */
  tierEstimated: boolean;
  pointsSource: PointsSource;
};
