import { expectTypeOf, test } from 'vitest';
import { TIER_MIN_POINTS, TIER_ORDER, type Tier } from '../src/tier';

// Run by vitest's typecheck mode (see vitest.config.ts). If either table is loosened or loses a
// key, this stops compiling and `pnpm test` fails.
test('both tier tables are keyed by exactly Tier', () => {
  expectTypeOf(TIER_ORDER).toEqualTypeOf<Readonly<Record<Tier, number>>>();
  expectTypeOf(TIER_MIN_POINTS).toEqualTypeOf<Readonly<Record<Tier, number>>>();
});
