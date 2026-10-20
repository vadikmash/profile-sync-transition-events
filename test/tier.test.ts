import { describe, expect, it } from 'vitest';
import {
  TIER_MIN_POINTS,
  TIER_ORDER,
  type Tier,
  getTierForMembership,
  getTierForPoints,
  isForwardTierTransition,
  isTier,
  parseTier,
} from '../src/tier';

describe('tier tables', () => {
  it('orders every tier distinctly and asks strictly more points for each step up', () => {
    const tiers = (Object.keys(TIER_ORDER) as Tier[]).sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b]);

    expect(tiers.map((tier) => TIER_ORDER[tier])).toEqual(tiers.map((_, index) => index));
    tiers.slice(1).forEach((tier, index) => {
      expect(TIER_MIN_POINTS[tier]).toBeGreaterThan(TIER_MIN_POINTS[tiers[index]!]);
    });
  });
});

describe('getTierForPoints', () => {
  it.each([
    [0, 'Bronze'],
    [999, 'Bronze'],
    [1_000, 'Silver'],
    [4_999, 'Silver'],
    [5_000, 'Gold'],
    [19_999, 'Gold'],
    [20_000, 'Platinum'],
    [1_000_000, 'Platinum'],
  ])('puts %p points in %s', (points, tier) => {
    expect(getTierForPoints(points)).toBe(tier);
  });

  it.each([-1, NaN, Infinity])('has no tier for %p points', (points) => {
    expect(getTierForPoints(points)).toBeNull();
  });
});

describe('getTierForMembership', () => {
  it('computes from the ledger and says so', () => {
    expect(getTierForMembership({ ledgerPoints: 5_000 })).toEqual({
      tier: 'Gold',
      pointsSource: 'ledger',
      estimated: false,
    });
  });

  it('uses migrated points when the ledger is empty, and marks the tier estimated', () => {
    expect(getTierForMembership({ migratedPoints: 1_500 })).toEqual({
      tier: 'Silver',
      pointsSource: 'migrated',
      estimated: true,
    });
  });

  it('trusts the ledger over migrated points when both exist', () => {
    expect(getTierForMembership({ ledgerPoints: 100, migratedPoints: 25_000 })).toEqual({
      tier: 'Bronze',
      pointsSource: 'ledger',
      estimated: false,
    });
  });

  it('returns null without any points', () => {
    expect(getTierForMembership({})).toBeNull();
  });

  it('returns null, instead of falling back, when the ledger value is unusable', () => {
    expect(getTierForMembership({ ledgerPoints: NaN, migratedPoints: 25_000 })).toBeNull();
  });
});

describe('isTier and parseTier', () => {
  it.each(['Bronze', 'Silver', 'Gold', 'Platinum'])('accepts %s', (tier) => {
    expect(isTier(tier)).toBe(true);
    expect(parseTier(tier)).toBe(tier);
  });

  it.each([null, undefined, '', 'bronze', 'GOLD', 'Plat', 42, {}])('maps %p to null', (value) => {
    expect(isTier(value)).toBe(false);
    expect(parseTier(value)).toBeNull();
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'rejects the inherited object property name %s',
    (name) => {
      expect(parseTier(name)).toBeNull();
    }
  );
});

describe('isForwardTierTransition', () => {
  it('is true one step up', () => {
    expect(isForwardTierTransition('Bronze', 'Silver')).toBe(true);
    expect(isForwardTierTransition('Gold', 'Platinum')).toBe(true);
  });

  it('is true when several tiers are skipped', () => {
    expect(isForwardTierTransition('Bronze', 'Platinum')).toBe(true);
  });

  it('is false going down', () => {
    expect(isForwardTierTransition('Gold', 'Silver')).toBe(false);
    expect(isForwardTierTransition('Platinum', 'Bronze')).toBe(false);
  });

  it('is false for the same tier', () => {
    expect(isForwardTierTransition('Gold', 'Gold')).toBe(false);
  });
});
