import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTransitionEvents } from '../src/sendTransitionEvents';
import type { TierTransition } from '../src/transition';
import { FakeEngagementClient, type MockLogger, createMockLogger } from './fakes';

describe('sendTransitionEvents', () => {
  let log: MockLogger;
  let client: FakeEngagementClient;
  let postEvent: MockInstance<FakeEngagementClient['postEvent']>;

  const ADA = { id: 'u-100', email: 'ada@example.com' };

  const transitionFor = (membershipId: string): TierTransition => ({
    membershipId,
    membershipName: 'Book Club',
    previousTier: 'Silver',
    newTier: 'Gold',
    tierEstimated: false,
    pointsSource: 'ledger',
  });

  const transitionsFor = (count: number) =>
    Array.from({ length: count }, (_, index) => transitionFor(`m-${index + 1}`));

  beforeEach(() => {
    log = createMockLogger() as MockLogger;
    client = new FakeEngagementClient();
    postEvent = vi.spyOn(client, 'postEvent');
  });

  it('posts one tierTransitioned event per transition', async () => {
    const transitions = transitionsFor(2);

    const summary = await sendTransitionEvents(log, client, ADA, transitions);

    expect(postEvent).toHaveBeenCalledTimes(2);
    expect(postEvent).toHaveBeenCalledWith({
      email: ADA.email,
      eventName: 'tierTransitioned',
      id: 'tierTransitioned:u-100:m-1:Gold',
      dataFields: transitions[0],
    });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ membershipId: 'm-1' }), 'Sent tierTransitioned event');
    expect(summary).toEqual({ sent: transitions, failed: 0, skipped: 0, notAttempted: 0 });
  });

  it('keeps going after one membership throws, and does not count it as sent', async () => {
    const thrown = new Error('unexpected');
    postEvent.mockRejectedValueOnce(thrown);
    const transitions = transitionsFor(2);

    const summary = await sendTransitionEvents(log, client, ADA, transitions);

    expect(postEvent).toHaveBeenCalledTimes(2);
    expect(postEvent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tierTransitioned:u-100:m-2:Gold' }));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: thrown, membershipId: 'm-1', previousTier: 'Silver', newTier: 'Gold' }),
      'Error sending tierTransitioned event'
    );
    expect(summary).toEqual({ sent: [transitions[1]], failed: 1, skipped: 0, notAttempted: 0 });
  });

  it('sends nothing for an empty list', async () => {
    const summary = await sendTransitionEvents(log, client, ADA, []);

    expect(postEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ sent: [], failed: 0, skipped: 0, notAttempted: 0 });
  });

  it('warns instead of logging success when the send comes back failed', async () => {
    client.postEventResult = 'failed';

    const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(1));

    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Sent tierTransitioned event');
    expect(log.warn).toHaveBeenCalledWith(
      { userId: 'u-100', membershipId: 'm-1', previousTier: 'Silver', newTier: 'Gold' },
      expect.stringContaining('held for the next sync')
    );
    expect(summary).toMatchObject({ sent: [], failed: 1 });
  });

  it('logs nothing about a skipped send beyond the count', async () => {
    client.postEventResult = 'skipped';

    const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(1));

    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Sent tierTransitioned event');
    expect(log.warn).not.toHaveBeenCalled();
    expect(summary).toEqual({ sent: [], failed: 0, skipped: 1, notAttempted: 0 });
  });

  it('gives two users who share a membership and a tier different event ids', async () => {
    const grace = { id: 'u-200', email: 'grace@example.com' };
    const shared = transitionFor('shared');

    await sendTransitionEvents(log, client, ADA, [shared]);
    await sendTransitionEvents(log, client, grace, [shared]);

    const ids = postEvent.mock.calls.map(([event]) => event.id);

    expect(ids).toEqual(['tierTransitioned:u-100:shared:Gold', 'tierTransitioned:u-200:shared:Gold']);
  });

  it('leaves a single event on the platform when the same transition is sent twice', async () => {
    const transitions = transitionsFor(1);

    await sendTransitionEvents(log, client, ADA, transitions);
    await sendTransitionEvents(log, client, ADA, transitions);

    expect(postEvent).toHaveBeenCalledTimes(2);
    expect(client.eventsById.size).toBe(1);
  });

  describe('concurrency', () => {
    it('never has more sends in flight than the limit', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      postEvent.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return 'sent';
      });

      const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(10), { concurrency: 3 });

      expect(maxInFlight).toBe(3);
      expect(summary.sent).toHaveLength(10);
    });

    it.each([0, -2, 0.4])('falls back to one at a time for a limit of %p', async (concurrency) => {
      const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(3), { concurrency });

      expect(summary.sent).toHaveLength(3);
    });
  });

  describe('after a failed send', () => {
    it('starts no new sends and reports how many were held', async () => {
      client.postEventResult = 'failed';

      const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(6), { concurrency: 2 });

      expect(postEvent).toHaveBeenCalledTimes(2);
      expect(summary).toEqual({ sent: [], failed: 2, skipped: 0, notAttempted: 4 });
      expect(log.warn).toHaveBeenCalledWith(
        { userId: 'u-100', notAttempted: 4 },
        expect.stringContaining('Stopped sending')
      );
    });

    it('still reports what was confirmed sent before it', async () => {
      postEvent.mockResolvedValueOnce('sent').mockResolvedValue('failed');
      const transitions = transitionsFor(4);

      const summary = await sendTransitionEvents(log, client, ADA, transitions, { concurrency: 1 });

      expect(summary).toEqual({ sent: [transitions[0]], failed: 1, skipped: 0, notAttempted: 2 });
    });

    it('keeps going after a throw, which is not a failed result', async () => {
      postEvent.mockRejectedValueOnce(new Error('unexpected'));

      const summary = await sendTransitionEvents(log, client, ADA, transitionsFor(3), { concurrency: 1 });

      expect(postEvent).toHaveBeenCalledTimes(3);
      expect(summary.notAttempted).toBe(0);
    });
  });
});
