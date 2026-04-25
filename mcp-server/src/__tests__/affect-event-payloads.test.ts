import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecalledContext } from "../services/supabase.js";

// ---------------------------------------------------------------------------
// recalled memory_event JSONB payload contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §curiosity, §frustration) reads `recalled` events via JSON pointer:
//
//   empty_recalls    = … WHERE (context->>'hits')::int  = 0
//   low_conf_recalls = … WHERE (context->>'score')::float < 0.4
//   zero_hit_ratio   = … WHERE (context->>'hits')::int  = 0
//
// The TypeScript signature of MemoryService.emitRecalled (hits, topScore,
// queryLength) does NOT match the JSONB key names the SQL reads — `topScore`
// is renamed to `score` on the way into the payload. A silent refactor that
// renames the JSONB key (e.g. to `topScore`) would not break compilation,
// would not break the existing handlers.test.ts FakeService accumulator
// (which records the function args, not the JSONB shape), but would
// silently zero out the curiosity / frustration dimensions.
//
// These tests pin the wire contract: the exact key set, the exact key
// names, and the value-passthrough.
// ---------------------------------------------------------------------------

test("buildRecalledContext returns exactly the keys compute_affect() reads", () => {
  const ctx = buildRecalledContext(2, 0.812, 10);
  assert.deepEqual(Object.keys(ctx).sort(), ["hits", "query_length", "score"]);
});

test("buildRecalledContext maps topScore arg → 'score' key (not 'topScore')", () => {
  // The function arg is named topScore but the JSONB key MUST be 'score'
  // because the SQL formula is `(context->>'score')::float`.
  const ctx = buildRecalledContext(0, 0.31, 5);
  assert.equal(ctx.score, 0.31);
  assert.equal((ctx as unknown as Record<string, unknown>).topScore, undefined);
});

test("buildRecalledContext maps queryLength arg → 'query_length' key (snake_case)", () => {
  // The SQL convention is snake_case; the TS arg is camelCase. Pin the
  // boundary so a future "consistency" rename doesn't break the trigger.
  const ctx = buildRecalledContext(0, 0, 42);
  assert.equal(ctx.query_length, 42);
  assert.equal((ctx as unknown as Record<string, unknown>).queryLength, undefined);
});

test("buildRecalledContext passes hits through unchanged (used by empty_recalls)", () => {
  // empty_recalls counts rows WHERE (context->>'hits')::int = 0, so a 0
  // hit count must round-trip as the integer 0 — not null, not undefined.
  const ctx = buildRecalledContext(0, 0, 0);
  assert.equal(ctx.hits, 0);
  assert.equal(typeof ctx.hits, "number");
});

test("buildRecalledContext preserves score=0 as a real number for low_conf_recalls", () => {
  // The empty-result branch in MemoryService.search emits topScore=0; the
  // JSON pointer cast `(context->>'score')::float` would coerce '0' → 0.
  // Pin that the wire shape is still a number, not null.
  const ctx = buildRecalledContext(0, 0, 4);
  assert.equal(ctx.score, 0);
  assert.equal(typeof ctx.score, "number");
});

test("buildRecalledContext is pure (no aliasing across calls)", () => {
  // Future maintainers may be tempted to memoize. The downstream RPC call
  // serializes the object to JSONB so identity doesn't matter, but
  // mutation across calls would be a footgun if the helper grows.
  const a = buildRecalledContext(1, 0.5, 3);
  const b = buildRecalledContext(2, 0.6, 4);
  assert.notStrictEqual(a, b);
  assert.equal(a.hits, 1);
  assert.equal(b.hits, 2);
});
