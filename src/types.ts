import type { Tier } from './tier';

export type SendResult = 'sent' | 'skipped' | 'failed';

/** Structured logger, fields first and message second (the pino / bunyan shape). */
export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Counter sink (StatsD, CloudWatch EMF, OpenTelemetry, ...). */
export interface Metrics {
  increment(name: string, value: number): void;
}

/** The tiers are `unknown`: they come back from a system we don't control. */
export type StoredProfile = {
  memberships?: Array<{ membershipId: string; tier?: unknown; notifiedTier?: unknown }>;
};

export type ProfileMembership = {
  membershipId: string;
  name: string;
  /** The tier computed on this sync. */
  tier: Tier | null;
  /**
   * The last tier a journey was told about, or consumed without sending (suppressed, dark launch).
   * It only moves forward, and only after an event is confirmed sent, so an unsent transition can
   * be retried.
   */
  notifiedTier: Tier | null;
};

export type Profile = {
  id: string;
  email: string;
  memberships: ProfileMembership[];
};

export type EngagementEvent = {
  /** Email only. With both an email and a user id, the platform can split one user's events across two records. */
  email: string;
  eventName: string;
  /** Idempotency key: the platform upserts on it instead of appending. */
  id: string;
  dataFields: Record<string, unknown>;
};

/**
 * Everything this feature needs from the engagement platform (Iterable, Braze, Customer.io, ...).
 * Narrow on purpose, so tests can fake it.
 */
export interface EngagementClient {
  /**
   * Resolves `null` for a user that doesn't exist (the first-ever sync). Rejects on any other
   * failure, so an outage can't pass as "nothing stored yet".
   */
  getProfile(email: string): Promise<StoredProfile | null>;

  /**
   * 'skipped' when tracking is off, 'failed' once the client has given up retrying transient errors.
   * The client logs errors instead of throwing, so callers must check the result.
   */
  upsertProfile(profile: Profile): Promise<SendResult>;

  /** Same contract as {@link EngagementClient.upsertProfile}. */
  postEvent(event: EngagementEvent): Promise<SendResult>;
}
