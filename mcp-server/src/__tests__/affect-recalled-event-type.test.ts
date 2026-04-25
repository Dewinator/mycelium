import { test } from "node:test";
import assert from "node:assert/strict";
import { RECALLED_EVENT_TYPE, MARK_USEFUL_EVENT_TYPE } from "../services/supabase.js";

// ---------------------------------------------------------------------------
// memory_events.event_type wire-literal contract — `recalled`
//
// Why this guard exists: compute_affect() (docs/affect-observables.md) reads
// memory_events filtered by `event_type='recalled'` to compute three of the
// six affect dimensions:
//
//   §curiosity   — empty_recalls    = … WHERE event_type='recalled'
//                                          AND (context->>'hits')::int = 0
//                  low_conf_recalls = … WHERE event_type='recalled'
//                                          AND (context->>'score')::float < 0.4
//   §frustration — zero_hit_ratio   = … WHERE event_type='recalled'
//                                          AND (context->>'hits')::int = 0
//
// That makes `recalled` the most heavily-read event-type literal in the
// whole spec — three independent formula terms collapse the moment the
// string drifts. The literal is emitted from a single producer
// (`MemoryService.emitRecalled` in services/supabase.ts) which routes both
// the `tools/recall.ts` and `tools/belief.ts` call sites through one
// place. A silent rename would not break compilation, would not break the
// JSONB-payload guard in affect-event-payloads.test.ts (those test the
// context shape, not the event_type literal), and would not surface in
// the FakeService accumulator in handlers.test.ts (which records function
// args, not the event_type). It would, however, zero out empty_recalls,
// low_conf_recalls AND zero_hit_ratio simultaneously — symptom: curiosity
// stuck near baseline AND frustration unable to detect zero-hit storms.
//
// Centralising the literal in `RECALLED_EVENT_TYPE` and pinning its value
// here makes a rename a single deliberate edit that also fails this test
// until the spec doc + SQL are updated to match. Same defensive pattern as
// `MARK_USEFUL_EVENT_TYPE` (see affect-event-types.test.ts).
// ---------------------------------------------------------------------------

test("RECALLED_EVENT_TYPE pins to the literal compute_affect §curiosity / §frustration read", () => {
  // The SQL formulas in docs/affect-observables.md filter memory_events by
  // exact-string equality (`event_type='recalled'`). If this assertion
  // fails, the formula and the producer have drifted — update both
  // together (constant + spec doc + any SQL function) rather than
  // weakening the test.
  assert.equal(RECALLED_EVENT_TYPE, "recalled");
});

test("RECALLED_EVENT_TYPE is a string (not coerced to a non-string sentinel)", () => {
  // Defensive: a future maintainer might be tempted to swap the string for
  // a Symbol or numeric enum. log_memory_event takes p_event_type as TEXT,
  // so anything but a string would either throw at the RPC boundary or get
  // serialised in a surprising way. Pin the runtime type.
  assert.equal(typeof RECALLED_EVENT_TYPE, "string");
});

test("RECALLED_EVENT_TYPE is non-empty (would otherwise match every row)", () => {
  // A `""` event_type would silently break compute_affect()'s filter
  // (`event_type=''` matches nothing in practice but inserts would still
  // succeed against the TEXT column). Pin a length floor so an empty
  // string can't slip in via a bad refactor.
  assert.ok(RECALLED_EVENT_TYPE.length > 0);
});

test("RECALLED_EVENT_TYPE is snake_case (matches SQL convention used in the spec)", () => {
  // The spec doc, SQL functions, and the Postgres column convention all
  // use snake_case event_type strings. A camelCase or kebab-case rename
  // (e.g. "recallHit" / "recalled-event") would silently miss the SQL
  // filter. This regex is intentionally narrow — it only allows
  // `[a-z0-9_]+` — to flag any drift toward another casing scheme.
  assert.match(RECALLED_EVENT_TYPE, /^[a-z][a-z0-9_]*$/);
});

test("RECALLED_EVENT_TYPE is distinct from MARK_USEFUL_EVENT_TYPE (no accidental aliasing)", () => {
  // Both constants live next to each other in services/supabase.ts and feed
  // different formula terms (§curiosity / §frustration vs §satisfaction).
  // A copy-paste edit that pointed both at the same literal would silently
  // collapse two independent signals into one — the formulas would still
  // run, but their output would be perfectly correlated, hiding the bug
  // until somebody noticed the dashboard always moves the two dials in
  // lock-step.
  assert.notEqual(RECALLED_EVENT_TYPE, MARK_USEFUL_EVENT_TYPE);
});
