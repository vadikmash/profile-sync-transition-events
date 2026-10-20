import { vi } from 'vitest';
import type {
  EngagementClient,
  EngagementEvent,
  Logger,
  Metrics,
  Profile,
  SendResult,
  StoredProfile,
} from '../src/types';

export const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

export type MockLogger = ReturnType<typeof createMockLogger> & Logger;

export class FakeMetrics implements Metrics {
  counters: Record<string, number> = {};

  increment(name: string, value: number): void {
    this.counters[name] = (this.counters[name] ?? 0) + value;
  }
}

/**
 * In-memory stand-in for the engagement platform. It behaves like the real thing where it
 * matters here: events are upserted by id (a repeated id does not add a second event), and the
 * stored profile is whatever was last written.
 */
export class FakeEngagementClient implements EngagementClient {
  profiles = new Map<string, StoredProfile>();
  eventsById = new Map<string, EngagementEvent>();
  /** Every call in order, so tests can assert what happens before what. */
  calls: string[] = [];
  /** Every profile written, in order. */
  upserts: Profile[] = [];

  upsertProfileResult: SendResult = 'sent';
  /** Results for the next upserts, consumed first-in first-out before falling back to the default. */
  upsertProfileResultQueue: SendResult[] = [];
  postEventResult: SendResult = 'sent';
  getProfileError: Error | null = null;

  async getProfile(email: string): Promise<StoredProfile | null> {
    this.calls.push('getProfile');
    if (this.getProfileError) {
      throw this.getProfileError;
    }
    return this.profiles.get(email) ?? null;
  }

  async upsertProfile(profile: Profile): Promise<SendResult> {
    this.calls.push('upsertProfile');
    this.upserts.push(profile);
    const result = this.upsertProfileResultQueue.shift() ?? this.upsertProfileResult;
    if (result === 'sent') {
      this.profiles.set(profile.email, { memberships: profile.memberships });
    }
    return result;
  }

  async postEvent(event: EngagementEvent): Promise<SendResult> {
    this.calls.push('postEvent');
    if (this.postEventResult === 'sent') {
      this.eventsById.set(event.id, event);
    }
    return this.postEventResult;
  }
}
