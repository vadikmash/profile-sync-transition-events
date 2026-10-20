import { describe, expect, it } from 'vitest';
import {
  type MembershipRecord,
  type UserRecord,
  buildProfileWithTransitions,
  markNotified,
} from '../src/buildProfile';
import type { PreviousMembershipState } from '../src/previousState';
import type { Tier } from '../src/tier';
import type { TierTransition } from '../src/transition';

const USER: UserRecord = { id: 'u-100', email: 'ada@example.com' };

const membership = (overrides: Partial<MembershipRecord> = {}): MembershipRecord => ({
  id: 'm-1',
  name: 'Book Club',
  ledgerPoints: 5_000,
  ...overrides,
});

const stored = (tier: Tier | null, notifiedTier: Tier | null = tier): PreviousMembershipState => ({
  tier,
  notifiedTier,
});

const previous = (states: Record<string, PreviousMembershipState>) => new Map(Object.entries(states));

describe('buildProfileWithTransitions', () => {
  it('reports a move up, advances the tier, and holds notifiedTier at the baseline', () => {
    const { profile, transitions, suppressed } = buildProfileWithTransitions(
      USER,
      [membership()],
      previous({ 'm-1': stored('Silver') })
    );

    expect(transitions).toEqual([
      {
        membershipId: 'm-1',
        membershipName: 'Book Club',
        previousTier: 'Silver',
        newTier: 'Gold',
        tierEstimated: false,
        pointsSource: 'ledger',
      },
    ]);
    expect(profile).toEqual({
      id: 'u-100',
      email: 'ada@example.com',
      memberships: [{ membershipId: 'm-1', name: 'Book Club', tier: 'Gold', notifiedTier: 'Silver' }],
    });
    expect(suppressed).toBe(0);
  });

  it('reports a jump over several tiers once', () => {
    const { transitions } = buildProfileWithTransitions(
      USER,
      [membership({ ledgerPoints: 25_000 })],
      previous({ 'm-1': stored('Bronze') })
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ previousTier: 'Bronze', newTier: 'Platinum' });
  });

  it('records the baseline quietly on a first sync', () => {
    const { profile, transitions } = buildProfileWithTransitions(USER, [membership()], new Map());

    expect(transitions).toEqual([]);
    expect(profile.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('records the baseline quietly when no stored tier could be read', () => {
    const { profile, transitions } = buildProfileWithTransitions(
      USER,
      [membership()],
      previous({ 'm-1': stored(null, null) })
    );

    expect(transitions).toEqual([]);
    expect(profile.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('detects a move that an earlier sync left held (tier advanced, notifiedTier did not)', () => {
    const { transitions } = buildProfileWithTransitions(
      USER,
      [membership()],
      previous({ 'm-1': stored('Gold', 'Silver') })
    );

    expect(transitions).toEqual([expect.objectContaining({ previousTier: 'Silver', newTier: 'Gold' })]);
  });

  it('takes the stored tier as the baseline for profiles that predate notifiedTier', () => {
    const { transitions } = buildProfileWithTransitions(
      USER,
      [membership()],
      previous({ 'm-1': stored('Silver', null) })
    );

    expect(transitions).toEqual([expect.objectContaining({ previousTier: 'Silver', newTier: 'Gold' })]);
  });

  it('stays quiet when the tier has not changed', () => {
    const { transitions } = buildProfileWithTransitions(USER, [membership()], previous({ 'm-1': stored('Gold') }));

    expect(transitions).toEqual([]);
  });

  it('stays quiet on a drop, writes the lower tier, and leaves notifiedTier where it was', () => {
    const { profile, transitions } = buildProfileWithTransitions(
      USER,
      [membership({ ledgerPoints: 1_200 })],
      previous({ 'm-1': stored('Gold') })
    );

    expect(transitions).toEqual([]);
    expect(profile.memberships[0]).toMatchObject({ tier: 'Silver', notifiedTier: 'Gold' });
  });

  it('stays quiet when a membership returns to a tier it already announced', () => {
    const { profile, transitions } = buildProfileWithTransitions(
      USER,
      [membership({ ledgerPoints: 5_000 })],
      previous({ 'm-1': stored('Silver', 'Gold') })
    );

    expect(transitions).toEqual([]);
    expect(profile.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('writes a null tier and keeps notifiedTier when there are no usable points', () => {
    const { profile, transitions } = buildProfileWithTransitions(
      USER,
      [membership({ ledgerPoints: undefined })],
      previous({ 'm-1': stored('Silver') })
    );

    expect(transitions).toEqual([]);
    expect(profile.memberships[0]).toMatchObject({ tier: null, notifiedTier: 'Silver' });
  });

  it('reports only the memberships that moved', () => {
    const { transitions } = buildProfileWithTransitions(
      USER,
      [membership({ id: 'a', ledgerPoints: 5_000 }), membership({ id: 'b', ledgerPoints: 5_000 })],
      previous({ a: stored('Silver'), b: stored('Gold') })
    );

    expect(transitions.map((transition) => transition.membershipId)).toEqual(['a']);
  });

  describe('estimate flags', () => {
    it('flags a tier that rests on migrated points as estimated', () => {
      const { transitions } = buildProfileWithTransitions(
        USER,
        [membership({ ledgerPoints: undefined, migratedPoints: 5_000 })],
        previous({ 'm-1': stored('Silver') })
      );

      expect(transitions[0]).toMatchObject({ tierEstimated: true, pointsSource: 'migrated' });
    });

    it('reports the points the tier was really computed from when two sources exist', () => {
      const { transitions } = buildProfileWithTransitions(
        USER,
        [membership({ ledgerPoints: 5_000, migratedPoints: 100 })],
        previous({ 'm-1': stored('Silver') })
      );

      expect(transitions[0]).toMatchObject({ tierEstimated: false, pointsSource: 'ledger' });
    });
  });

  describe('suppression', () => {
    const NOW = new Date('2026-01-01T00:00:00Z');

    it.each([
      ['closed', { closedAt: NOW }],
      ['deleted', { deletedAt: NOW }],
      ['opted-out', { communicationsOptOutAt: NOW }],
    ] as const)('sends nothing for a %s membership, keeps it in the profile and consumes the move', (_label, overrides) => {
      const { profile, transitions, suppressed } = buildProfileWithTransitions(
        USER,
        [membership(overrides)],
        previous({ 'm-1': stored('Silver') })
      );

      expect(transitions).toEqual([]);
      expect(suppressed).toBe(1);
      expect(profile.memberships).toHaveLength(1);
      // Consumed, not held: notifiedTier moves, so the move never fires later either.
      expect(profile.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
    });

    it('consumes every move of a deleted user', () => {
      const { profile, transitions, suppressed } = buildProfileWithTransitions(
        { ...USER, deletedAt: NOW },
        [membership({ id: 'a' }), membership({ id: 'b' })],
        previous({ a: stored('Silver'), b: stored('Silver') })
      );

      expect(transitions).toEqual([]);
      expect(suppressed).toBe(2);
      expect(profile.memberships.map((m) => m.notifiedTier)).toEqual(['Gold', 'Gold']);
    });

    it('does not count a suppressed membership that did not move up', () => {
      const { suppressed } = buildProfileWithTransitions(
        USER,
        [membership({ closedAt: NOW })],
        previous({ 'm-1': stored('Gold') })
      );

      expect(suppressed).toBe(0);
    });
  });
});

describe('markNotified', () => {
  const transition = (membershipId: string): TierTransition => ({
    membershipId,
    membershipName: 'Book Club',
    previousTier: 'Silver',
    newTier: 'Gold',
    tierEstimated: false,
    pointsSource: 'ledger',
  });

  const heldProfile = () =>
    buildProfileWithTransitions(
      USER,
      [membership({ id: 'a' }), membership({ id: 'b' }), membership({ id: 'c', ledgerPoints: 100 })],
      previous({ a: stored('Silver'), b: stored('Silver'), c: stored('Bronze') })
    ).profile;

  it('moves notifiedTier for the listed transitions only', () => {
    const updated = markNotified(heldProfile(), [transition('a')]);

    expect(updated.memberships.map((m) => [m.membershipId, m.tier, m.notifiedTier])).toEqual([
      ['a', 'Gold', 'Gold'],
      ['b', 'Gold', 'Silver'],
      ['c', 'Bronze', 'Bronze'],
    ]);
  });

  it('leaves the profile it was given untouched', () => {
    const profile = heldProfile();

    markNotified(profile, [transition('a')]);

    expect(profile.memberships[0]?.notifiedTier).toBe('Silver');
  });
});
