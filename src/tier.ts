export type Tier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum';

/**
 * Progression order. The type is keyed by Tier, so a new tier won't compile until it is placed
 * here, instead of quietly never triggering an event.
 */
export const TIER_ORDER: Readonly<Record<Tier, number>> = {
  Bronze: 0,
  Silver: 1,
  Gold: 2,
  Platinum: 3,
};

/** Keyed by Tier for the same reason. */
export const TIER_MIN_POINTS: Readonly<Record<Tier, number>> = {
  Bronze: 0,
  Silver: 1_000,
  Gold: 5_000,
  Platinum: 20_000,
};

const TIERS_HIGHEST_FIRST = (Object.keys(TIER_ORDER) as Tier[]).sort((a, b) => TIER_ORDER[b] - TIER_ORDER[a]);
const KNOWN_TIERS: ReadonlySet<string> = new Set(Object.keys(TIER_ORDER));

export type PointsSource = 'ledger' | 'migrated';

export type MembershipPoints = {
  ledgerPoints?: number | undefined;
  migratedPoints?: number | undefined;
};

export type TierResult = {
  tier: Tier;
  pointsSource: PointsSource;
  /** True when the tier rests on migrated points, so campaigns can leave out tiers that may be off. */
  estimated: boolean;
};

export function getTierForPoints(points: number): Tier | null {
  if (!Number.isFinite(points) || points < 0) {
    return null;
  }

  return TIERS_HIGHEST_FIRST.find((tier) => points >= TIER_MIN_POINTS[tier]) ?? null;
}

/**
 * Chooses the points and the tier in one place, so `pointsSource` and `estimated` always describe
 * the points the tier was really computed from. Worked out separately they can drift, and a
 * campaign that filters on "not estimated" would then include exactly the tiers built on imported
 * numbers.
 *
 * The ledger wins over migrated points. A ledger value that is present but unusable gives null
 * instead of falling back, so bad data in one source can't pass as good data from the other.
 */
export function getTierForMembership(membership: MembershipPoints): TierResult | null {
  const hasLedger = membership.ledgerPoints != null;
  const points = hasLedger ? membership.ledgerPoints : membership.migratedPoints;

  if (points == null) {
    return null;
  }

  const tier = getTierForPoints(points);

  return tier ? { tier, pointsSource: hasLedger ? 'ledger' : 'migrated', estimated: !hasLedger } : null;
}

/** Set membership, not `in`: inherited names like 'toString' must not count as tiers. */
export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && KNOWN_TIERS.has(value);
}

/**
 * Stored values may be out of date or edited by hand. Anything unrecognized comes back as null,
 * and the caller treats that as "nothing stored" instead of acting on it.
 */
export function parseTier(value: unknown): Tier | null {
  return isTier(value) ? value : null;
}

/** Only the order matters, not the distance, so a multi-tier jump counts as one forward move. */
export function isForwardTierTransition(previousTier: Tier, newTier: Tier): boolean {
  return TIER_ORDER[newTier] > TIER_ORDER[previousTier];
}
