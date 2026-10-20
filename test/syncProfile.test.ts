import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipRecord, UserRecord } from '../src/buildProfile';
import { type SyncDeps, syncProfile } from '../src/syncProfile';
import { FakeEngagementClient, FakeMetrics, type MockLogger, createMockLogger } from './fakes';

describe('syncProfile', () => {
  let log: MockLogger;
  let client: FakeEngagementClient;
  let metrics: FakeMetrics;
  let eventsEnabled: boolean;
  let deps: SyncDeps;

  const ADA: UserRecord = { id: 'u-100', email: 'ada@example.com' };
  const membershipsWith = (ledgerPoints: number): MembershipRecord[] => [
    { id: 'm-1', name: 'Book Club', ledgerPoints },
  ];
  const postEventCalls = () => client.calls.filter((call) => call === 'postEvent').length;

  // The platform already holds the membership as Silver, so 5,000 points is a Silver -> Gold move.
  const seedSilver = () =>
    client.profiles.set(ADA.email, { memberships: [{ membershipId: 'm-1', tier: 'Silver', notifiedTier: 'Silver' }] });

  const storedMembership = () => client.profiles.get(ADA.email)?.memberships?.[0];

  const seedMany = (count: number) => {
    client.profiles.set(ADA.email, {
      memberships: Array.from({ length: count }, (_, i) => ({
        membershipId: `m-${i}`,
        tier: 'Silver',
        notifiedTier: 'Silver',
      })),
    });
    return Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, name: 'Club', ledgerPoints: 5_000 }));
  };

  beforeEach(() => {
    log = createMockLogger() as MockLogger;
    client = new FakeEngagementClient();
    metrics = new FakeMetrics();
    eventsEnabled = true;
    deps = { client, log, metrics, isTransitionEventsEnabled: () => eventsEnabled };
  });

  it('writes the profile, then sends the event, then records it as notified', async () => {
    seedSilver();

    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(client.calls).toEqual(['getProfile', 'upsertProfile', 'postEvent', 'upsertProfile']);
    expect([...client.eventsById.keys()]).toEqual(['tierTransitioned:u-100:m-1:Gold']);
    expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('holds the move in the first write, so a crash before the send can be retried', async () => {
    seedSilver();

    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(client.upserts[0]?.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Silver' });
    expect(client.upserts[1]?.memberships[0]).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('records a baseline quietly on a first-ever sync', async () => {
    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(client.calls).toEqual(['getProfile', 'upsertProfile']);
    expect(client.eventsById.size).toBe(0);
    expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('sends nothing on a repeat sync once the move is recorded', async () => {
    seedSilver();

    await syncProfile(deps, ADA, membershipsWith(5_000));
    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(postEventCalls()).toBe(1);
  });

  it('sends once for a profile stored before notifiedTier existed', async () => {
    client.profiles.set(ADA.email, { memberships: [{ membershipId: 'm-1', tier: 'Silver' }] });

    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(client.eventsById.size).toBe(1);
    expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  it('falls back to the stored tier, and warns, when notifiedTier is unrecognized', async () => {
    client.profiles.set(ADA.email, {
      memberships: [{ membershipId: 'm-1', tier: 'Silver', notifiedTier: 'Diamond' }],
    });

    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ storedNotifiedTier: 'Diamond' }),
      expect.stringContaining('Unrecognized tier')
    );
    expect([...client.eventsById.keys()]).toEqual(['tierTransitioned:u-100:m-1:Gold']);
  });

  it('announces a tier once, even if the membership drops and later returns to it', async () => {
    seedSilver();

    await syncProfile(deps, ADA, membershipsWith(5_000));
    await syncProfile(deps, ADA, membershipsWith(1_200));
    expect(storedMembership()).toMatchObject({ tier: 'Silver', notifiedTier: 'Gold' });
    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(postEventCalls()).toBe(1);
  });

  it('is off unless a switch is wired, which makes it a dark launch', async () => {
    seedSilver();

    await syncProfile({ client, log }, ADA, membershipsWith(5_000));

    expect(client.calls).toEqual(['getProfile', 'upsertProfile']);
    expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
  });

  describe('when the profile write does not go through', () => {
    it('sends no events and warns if it failed', async () => {
      seedSilver();
      client.upsertProfileResult = 'failed';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.calls).toEqual(['getProfile', 'upsertProfile']);
      expect(log.warn).toHaveBeenCalledWith(
        { userId: 'u-100', heldTransitions: 1 },
        expect.stringContaining('profile update failed')
      );
    });

    it('also warns if it failed during a dark launch, because the move stays held', async () => {
      seedSilver();
      eventsEnabled = false;
      client.upsertProfileResult = 'failed';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(log.warn).toHaveBeenCalledWith(
        { userId: 'u-100', heldTransitions: 1 },
        expect.stringContaining('profile update failed')
      );
      expect(log.info).not.toHaveBeenCalled();
    });

    it('detects the move again on the next sync and sends it once', async () => {
      seedSilver();
      client.upsertProfileResult = 'failed';
      await syncProfile(deps, ADA, membershipsWith(5_000));

      client.upsertProfileResult = 'sent';
      await syncProfile(deps, ADA, membershipsWith(5_000));
      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.eventsById.size).toBe(1);
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Gold' });
    });

    it('says nothing when the write was skipped', async () => {
      seedSilver();
      client.upsertProfileResult = 'skipped';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.calls).not.toContain('postEvent');
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('says nothing when it failed but there was nothing at stake', async () => {
      client.upsertProfileResult = 'failed';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('when the event does not go out', () => {
    it('holds the move after a failed send, and sends it once the platform is back', async () => {
      seedSilver();
      client.postEventResult = 'failed';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      // The tier moved but notifiedTier did not, and nothing was recorded afterwards.
      expect(client.calls).toEqual(['getProfile', 'upsertProfile', 'postEvent']);
      expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Silver' });

      client.postEventResult = 'sent';
      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.eventsById.size).toBe(1);
      expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
    });

    it('keeps the move held after a skipped send', async () => {
      seedSilver();
      client.postEventResult = 'skipped';

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.calls).toEqual(['getProfile', 'upsertProfile', 'postEvent']);
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Silver' });
    });

    it('records only the memberships whose event was confirmed sent', async () => {
      client.profiles.set(ADA.email, {
        memberships: ['a', 'b', 'c'].map((id) => ({ membershipId: id, tier: 'Silver', notifiedTier: 'Silver' })),
      });
      const three = ['a', 'b', 'c'].map((id) => ({ id, name: 'Club', ledgerPoints: 5_000 }));
      vi.spyOn(client, 'postEvent').mockResolvedValueOnce('sent').mockResolvedValue('failed');

      await syncProfile({ ...deps, sendConcurrency: 1 }, ADA, three);

      expect(client.profiles.get(ADA.email)?.memberships?.map((m) => [m.membershipId, m.notifiedTier])).toEqual([
        ['a', 'Gold'],
        ['b', 'Silver'],
        ['c', 'Silver'],
      ]);
    });

    it('sends again under the same event id when the recording write fails', async () => {
      seedSilver();
      client.upsertProfileResultQueue = ['sent', 'failed'];

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(log.warn).toHaveBeenCalledWith(
        { userId: 'u-100', sentTransitions: 1 },
        expect.stringContaining('Could not record')
      );
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Silver' });

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(postEventCalls()).toBe(2);
      expect(client.eventsById.size).toBe(1);
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Gold' });
    });

    it('upserts a single event when two syncs race, though both attempt the send', async () => {
      seedSilver();

      await Promise.all([syncProfile(deps, ADA, membershipsWith(5_000)), syncProfile(deps, ADA, membershipsWith(5_000))]);

      expect(postEventCalls()).toBe(2);
      expect(client.eventsById.size).toBe(1);
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Gold' });
    });

    it('absorbs the re-send when a racing sync overwrites the record with an older write', async () => {
      seedSilver();
      await syncProfile(deps, ADA, membershipsWith(5_000));

      // A sync that read the profile before the first one finished lands its held write last.
      client.profiles.set(ADA.email, { memberships: [{ membershipId: 'm-1', tier: 'Gold', notifiedTier: 'Silver' }] });
      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(postEventCalls()).toBe(2);
      expect(client.eventsById.size).toBe(1);
      expect(storedMembership()).toMatchObject({ notifiedTier: 'Gold' });
    });

    it('stops after the first failed send during an outage instead of trying every membership', async () => {
      const many = seedMany(80);
      client.postEventResult = 'failed';

      await syncProfile({ ...deps, sendConcurrency: 1 }, ADA, many);

      expect(postEventCalls()).toBe(1);
      expect(metrics.counters).toMatchObject({ 'tierTransition.failed': 1, 'tierTransition.notAttempted': 79 });
    });
  });

  describe('dark launch', () => {
    beforeEach(() => {
      eventsEnabled = false;
    });

    it('writes the profile once, sends nothing, and consumes the move', async () => {
      seedSilver();

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.calls).toEqual(['getProfile', 'upsertProfile']);
      expect(storedMembership()).toMatchObject({ tier: 'Gold', notifiedTier: 'Gold' });
      expect(log.info).toHaveBeenCalledWith(
        {
          userId: 'u-100',
          darkLaunchedTransitions: 1,
          transitions: [{ membershipId: 'm-1', previousTier: 'Silver', newTier: 'Gold' }],
        },
        expect.stringContaining('are off')
      );
    });

    it('does not release what it consumed once the switch is flipped on', async () => {
      seedSilver();
      await syncProfile(deps, ADA, membershipsWith(5_000));

      eventsEnabled = true;
      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(client.calls).not.toContain('postEvent');
    });

    it('announces only the moves made after the switch is flipped on', async () => {
      seedSilver();
      await syncProfile(deps, ADA, membershipsWith(5_000));

      eventsEnabled = true;
      await syncProfile(deps, ADA, membershipsWith(5_000));
      expect(client.eventsById.size).toBe(0);

      await syncProfile(deps, ADA, membershipsWith(25_000));
      expect([...client.eventsById.keys()]).toEqual(['tierTransitioned:u-100:m-1:Platinum']);
    });

    it('caps the logged list but keeps the exact count', async () => {
      const many = seedMany(80);

      await syncProfile(deps, ADA, many);

      const [fields] = log.info.mock.calls[0] ?? [];
      expect(fields.darkLaunchedTransitions).toBe(80);
      expect(fields.transitions).toHaveLength(50);
    });

    it('logs nothing when there is nothing to consume', async () => {
      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(log.info).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('counts what was sent', async () => {
      seedSilver();

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(metrics.counters).toEqual({ 'tierTransition.sent': 1 });
    });

    it('counts what a suppression rule consumed', async () => {
      seedSilver();
      const closed = [{ id: 'm-1', name: 'Book Club', ledgerPoints: 5_000, closedAt: new Date() }];

      await syncProfile(deps, ADA, closed);

      expect(metrics.counters).toEqual({ 'tierTransition.suppressed': 1 });
    });

    it('counts what the dark launch consumed', async () => {
      seedSilver();
      eventsEnabled = false;

      await syncProfile(deps, ADA, membershipsWith(5_000));

      expect(metrics.counters).toEqual({ 'tierTransition.darkLaunched': 1 });
    });

    it('counts failed and skipped sends, and emits nothing on a quiet sync', async () => {
      seedSilver();
      client.postEventResult = 'failed';
      await syncProfile(deps, ADA, membershipsWith(5_000));
      expect(metrics.counters).toEqual({ 'tierTransition.failed': 1 });

      metrics.counters = {};
      client.postEventResult = 'skipped';
      await syncProfile(deps, ADA, membershipsWith(5_000));
      expect(metrics.counters).toEqual({ 'tierTransition.skipped': 1 });

      metrics.counters = {};
      client.postEventResult = 'sent';
      await syncProfile(deps, ADA, membershipsWith(5_000));
      await syncProfile(deps, ADA, membershipsWith(5_000));
      expect(metrics.counters).toEqual({ 'tierTransition.sent': 1 });
    });

    it('is optional', async () => {
      seedSilver();

      await expect(
        syncProfile({ client, log, isTransitionEventsEnabled: () => true }, ADA, membershipsWith(5_000))
      ).resolves.toBeUndefined();
    });
  });

  it('writes nothing when reading the previous state failed', async () => {
    seedSilver();
    const thrown = new Error('platform is down');
    client.getProfileError = thrown;

    await syncProfile(deps, ADA, membershipsWith(5_000));

    expect(client.calls).toEqual(['getProfile']);
    expect(log.error).toHaveBeenCalledWith({ err: thrown }, expect.stringContaining('error syncing user'));
  });
});
