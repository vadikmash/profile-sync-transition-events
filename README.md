# profile-sync-transition-events

Detect forward state transitions while syncing a user profile to an engagement platform (Iterable, Braze, Customer.io, ...), and emit one idempotent event per transition.

## Background

This is a clean-room rewrite of a feature I built at work: emit an event when a customer's pet moves to a new life stage, so marketing can send relevant emails. The original code is private, so this repo uses loyalty tiers as a stand-in. The pattern is the same.

| At work | Here |
|---|---|
| A customer's pet | A membership |
| Life stage, calculated from the pet's birthday and weight | Tier, calculated from points |
| Saved on the customer's Iterable profile | Saved on the profile in any engagement platform (`EngagementClient`) |
| `lifeStageTransitioned` event | `tierTransitioned` event |

Beyond what shipped at work, this version records an event as done only after it is confirmed sent, so a failed send is retried on the next sync.

## The problem

Journeys in most engagement platforms start from **events**, not from profile-field changes. A derived value (a tier here, a life stage at work) changes without anyone announcing it, so nothing fires. Something has to notice and say so.

The pattern fits any value that is derived on the fly and that a campaign wants to react to: a life stage, a plan level, a risk band.

## How tiers work

Every membership has a tier, worked out from its points. The tiers have a fixed order, lowest to highest:

| Tier | Points needed |
|---|---|
| Bronze | 0 |
| Silver | 1,000 |
| Gold | 5,000 |
| Platinum | 20,000 |

Points come from the ledger. If a membership has no ledger value, imported (migrated) points are used instead, and the tier is marked as estimated. A tier moves up when points cross a threshold, and it can move down if points are corrected. Only moves up fire an event.

At work, the equivalent was a pet's life stage. It depended on the pet's birthday and weight, so it moved up on its own as the pet got older, with nobody doing anything. That is why a derived value needs something to notice the change.

## How it works

```
sync(user)
  ├─ read the profile back from the platform        stored tier + notifiedTier per membership
  ├─ compute tiers, diff against notifiedTier       buildProfileWithTransitions (pure)
  ├─ write the profile                              tier advances, notifiedTier holds
  ├─ send events, a few at a time                   only if the switch is on
  └─ write the profile again                        notifiedTier advances for what was confirmed sent
```

The platform is the "previous value" store, so there is no table to own. Each membership carries `tier`, the latest computed one, and `notifiedTier`, the last tier a journey was told about.

## Decisions worth a look

Each is explained in a comment where it lives.

- **Diff against `notifiedTier`, not the last computed tier.** It moves forward only, and only after the event is confirmed sent. A failed send, a skipped send or a crash all leave the move held, so the next sync retries it. A dip and a return to a tier you already announced is quiet.
- **Forward only.** Drops and first-ever tiers are silent, and a jump over several tiers is one move. The order table is keyed by `Tier`, so a new tier won't compile until it is placed, and a type test pins that.
- **Stored values are parsed, not trusted.** They come back from a system you don't own, so anything unrecognized becomes `null` with a warning. A missing user is a first sync, but any other lookup failure aborts, so an outage can't pass as "nothing stored yet".
- **Safe to repeat.** The profile is written before the events, so a journey never reads a field that contradicts its event. Each event has one deterministic id per user, membership and tier, so racing syncs and re-sends upsert the same event.
- **Dark launch.** Detection always runs, and sending stays off unless you wire a switch. While it's off, the first full run only updates every stored tier, so flipping it on announces only moves made afterwards. Closed, deleted and opted-out memberships are consumed the same way.
- **Bounded sends.** Five at a time. The first `'failed'` result means the client already used up its retries, so no new sends start and the rest stay held.

Also in there: a pure detection core, an estimate flag that can't disagree with its source, a tri-state send result (`sent`, `skipped`, `failed`) and an optional `Metrics` port.

## Known limits

- The platform has no compare-and-set, so interleaved syncs can move `notifiedTier` back. The re-send that follows relies on the platform's dedupe-by-id window.
- A move held through a long outage fires late. Add a maximum age if a late event is worse than none.

## Run it

```bash
pnpm install
pnpm test
pnpm typecheck
```

Node 20+. There is no real HTTP client here, only the `EngagementClient` interface and an in-memory fake in `test/fakes.ts`.

## Layout

```
src/
  tier.ts                  tiers, order, thresholds, parsing, forward check
  transition.ts            event name and payload type
  previousState.ts         read the stored tiers back
  buildProfile.ts          pure: profile payload + transitions, and markNotified
  sendTransitionEvents.ts  bounded sends, isolated failures, stop on outage
  syncProfile.ts           orchestration, dark launch, metrics
  types.ts                 the EngagementClient and Metrics ports and the shared types
  index.ts                 public exports
test/                      vitest, with an in-memory EngagementClient
```

## License

MIT
