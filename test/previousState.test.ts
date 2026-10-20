import { beforeEach, describe, expect, it } from 'vitest';
import { getPreviousMembershipStates } from '../src/previousState';
import { FakeEngagementClient, type MockLogger, createMockLogger } from './fakes';

describe('getPreviousMembershipStates', () => {
  let log: MockLogger;
  let client: FakeEngagementClient;

  beforeEach(() => {
    log = createMockLogger() as MockLogger;
    client = new FakeEngagementClient();
  });

  it('gives an empty map for a user the platform has never seen', async () => {
    expect(await getPreviousMembershipStates(log, client, 'new@example.com')).toEqual(new Map());
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads both stored tiers', async () => {
    client.profiles.set('ada@example.com', {
      memberships: [{ membershipId: 'm-1', tier: 'Gold', notifiedTier: 'Silver' }],
    });

    expect(await getPreviousMembershipStates(log, client, 'ada@example.com')).toEqual(
      new Map([['m-1', { tier: 'Gold', notifiedTier: 'Silver' }]])
    );
  });

  it.each([
    ['tier', { tier: 'Diamond', notifiedTier: 'Gold' }, { tier: null, notifiedTier: 'Gold' }],
    ['notifiedTier', { tier: 'Gold', notifiedTier: 'Diamond' }, { tier: 'Gold', notifiedTier: null }],
  ])('nulls and warns about an unrecognized %s', async (_field, storedMembership, expected) => {
    client.profiles.set('ada@example.com', { memberships: [{ membershipId: 'm-1', ...storedMembership }] });

    const states = await getPreviousMembershipStates(log, client, 'ada@example.com');

    expect(states.get('m-1')).toEqual(expected);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: 'm-1' }),
      expect.stringContaining('Unrecognized tier')
    );
  });

  it.each([undefined, null])('stays quiet about a membership whose fields are missing (%p)', async (value) => {
    client.profiles.set('ada@example.com', {
      memberships: [{ membershipId: 'm-1', tier: value, notifiedTier: value }],
    });

    const states = await getPreviousMembershipStates(log, client, 'ada@example.com');

    expect(states.get('m-1')).toEqual({ tier: null, notifiedTier: null });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('passes a real lookup failure on instead of reading it as a first sync', async () => {
    client.getProfileError = new Error('platform is down');

    await expect(getPreviousMembershipStates(log, client, 'ada@example.com')).rejects.toThrow('platform is down');
  });
});
