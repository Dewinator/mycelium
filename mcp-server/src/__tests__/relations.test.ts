import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContradictionResolvedContext,
  findResolutionMatch,
  type ContradictionDetectedRow,
} from "../services/relations.js";

// ---------------------------------------------------------------------------
// findResolutionMatch — bidirectional pair matching for
// contradiction_detected → contradiction_resolved correlation.
//
// Why these tests matter: the frustration term of compute_affect()
// (docs/affect-observables.md §frustration) counts *open* conflicts by
// joining contradiction_detected events against their matching
// contradiction_resolved event via shared trace_id. If the lookup picks
// the wrong row (or misses the pair) supersede_memory would emit the
// wrong trace_id and the frustration term would drift. These tests pin
// the matching contract — both directions of the pair must find the row,
// unrelated rows must be skipped, and an empty input must return null.
// ---------------------------------------------------------------------------

const OLD_ID = "11111111-1111-1111-1111-111111111111";
const NEW_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";

function row(
  memory_id: string,
  contradicts_id: string | undefined,
  trace_id: string | null = "trace-abc",
): ContradictionDetectedRow {
  return { trace_id, memory_id, context: { contradicts_id } };
}

test("findResolutionMatch picks row where memory_id=newId and contradicts_id=oldId", () => {
  // ConscienceAgent stamps event on the new memory pointing back at the old.
  // supersede_memory(old, new) must find it.
  const rows = [row(NEW_ID, OLD_ID, "trace-1")];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.ok(match);
  assert.equal(match!.trace_id, "trace-1");
  assert.equal(match!.memory_id, NEW_ID);
});

test("findResolutionMatch picks row where memory_id=oldId and contradicts_id=newId (reverse direction)", () => {
  // The stamping direction is an implementation detail of conscience-agent;
  // the matcher must stay symmetric so future re-wirings don't break the
  // contradiction-resolved emission.
  const rows = [row(OLD_ID, NEW_ID, "trace-2")];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.ok(match);
  assert.equal(match!.trace_id, "trace-2");
  assert.equal(match!.memory_id, OLD_ID);
});

test("findResolutionMatch returns null when rows are empty", () => {
  const match = findResolutionMatch([], OLD_ID, NEW_ID);
  assert.equal(match, null);
});

test("findResolutionMatch returns null when candidate points at an unrelated id", () => {
  // A contradiction was detected between NEW_ID and OTHER_ID, not NEW_ID and OLD_ID.
  // Must not falsely close the (OLD_ID, NEW_ID) loop.
  const rows = [row(NEW_ID, OTHER_ID, "trace-wrong")];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.equal(match, null);
});

test("findResolutionMatch returns null when context.contradicts_id is missing", () => {
  // Defensive: malformed/legacy payloads must not match arbitrary rows by
  // memory_id alone.
  const rows: ContradictionDetectedRow[] = [
    { trace_id: "trace-x", memory_id: NEW_ID, context: null },
    { trace_id: "trace-y", memory_id: NEW_ID, context: {} },
  ];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.equal(match, null);
});

test("findResolutionMatch returns the first matching row (caller pre-orders by created_at DESC)", () => {
  // The service query orders by created_at DESC and limits to 20. The
  // matcher preserves that ordering so the most recent open-conflict event
  // wins, which is what compute_affect() expects.
  const rows = [
    row(NEW_ID, OLD_ID, "trace-newest"),
    row(NEW_ID, OLD_ID, "trace-older"),
  ];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.ok(match);
  assert.equal(match!.trace_id, "trace-newest");
});

test("findResolutionMatch ignores rows pointing at (OTHER_ID, NEW_ID) even in mixed batch", () => {
  // Real batches will contain events for sibling conflicts. The matcher
  // must pick the (OLD_ID, NEW_ID) row specifically.
  const rows = [
    row(NEW_ID, OTHER_ID, "trace-noise"),
    row(NEW_ID, OLD_ID, "trace-right"),
    row(OTHER_ID, OLD_ID, "trace-unrelated"),
  ];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.ok(match);
  assert.equal(match!.trace_id, "trace-right");
});

test("findResolutionMatch tolerates null trace_id on a matching row", () => {
  // Early events may lack a trace_id. The matcher must still find them;
  // supersede's RPC call then passes null through as p_trace_id. Downstream
  // log_memory_event is responsible for allocating a new one if needed.
  const rows = [row(NEW_ID, OLD_ID, null)];
  const match = findResolutionMatch(rows, OLD_ID, NEW_ID);
  assert.ok(match);
  assert.equal(match!.trace_id, null);
});

// ---------------------------------------------------------------------------
// buildContradictionResolvedContext — JSONB payload contract for the
// `contradiction_resolved` memory_event emitted by supersede_memory.
//
// Why these tests matter: the frustration term of compute_affect()
// (docs/affect-observables.md §frustration) closes the open-conflict loop
// via shared trace_id, but the JSONB body is still load-bearing for
// downstream consumers that need to know *how* a contradiction was
// resolved (resolution kind + the superseding memory id). Pinning the
// literal here guards the keys against silent drift across renames or
// refactors. Same defensive pattern as the prior ticks for
// buildRecalledContext / buildContradictionDetectedContext /
// buildOutcomeEventContext / buildMarkUsefulFromExperienceContext.
// ---------------------------------------------------------------------------

const SUPERSEDER_ID = "44444444-4444-4444-4444-444444444444";

test("buildContradictionResolvedContext returns exactly the documented key set", () => {
  // Catches a future maintainer adding/dropping keys without a test update.
  const ctx = buildContradictionResolvedContext(SUPERSEDER_ID);
  assert.deepEqual(Object.keys(ctx).sort(), ["resolution", "superseder_id"]);
});

test("buildContradictionResolvedContext maps supersederId arg → 'superseder_id' key (snake_case)", () => {
  // The DB-side columns and downstream tooling are snake_case; the helper
  // bridges the camelCase TS arg → snake_case JSONB key. Renaming the key
  // would break audit-trail consumers that already query for it.
  const ctx = buildContradictionResolvedContext(SUPERSEDER_ID);
  assert.equal(ctx.superseder_id, SUPERSEDER_ID);
  assert.ok(!("supersederId" in ctx));
});

test("buildContradictionResolvedContext pins resolution literal to 'superseded'", () => {
  // `resolution` is currently the only branch supersede_memory takes; if a
  // future change adds e.g. 'merged' or 'deprecated' it must update this
  // test deliberately rather than silently broaden the consumer contract.
  const ctx = buildContradictionResolvedContext(SUPERSEDER_ID);
  assert.equal(ctx.resolution, "superseded");
});

test("buildContradictionResolvedContext passes supersederId through unchanged (no normalisation)", () => {
  // The helper must not lowercase, trim, or coerce the id — supersede_memory
  // already validates the UUIDs upstream and downstream consumers join on
  // exact equality.
  const oddly = "  Mixed-CASE-ID  ";
  const ctx = buildContradictionResolvedContext(oddly);
  assert.equal(ctx.superseder_id, oddly);
});

test("buildContradictionResolvedContext preserves empty-string id (no implicit fallback)", () => {
  // Defensive: if a caller ever passes "" the helper must not silently
  // substitute null/undefined — that would mask a real upstream bug.
  const ctx = buildContradictionResolvedContext("");
  assert.equal(ctx.superseder_id, "");
});

test("buildContradictionResolvedContext is pure (no aliasing across calls)", () => {
  // Mirrors the buildRecalledContext / buildContradictionDetectedContext
  // purity guards. log_memory_event JSON-serializes the payload, so
  // accidental shared-state would not surface in production but would
  // bite future call-sites that mutate the returned object.
  const a = buildContradictionResolvedContext("id-a");
  const b = buildContradictionResolvedContext("id-b");
  assert.notEqual(a, b);
  assert.equal(a.superseder_id, "id-a");
  assert.equal(b.superseder_id, "id-b");
});
