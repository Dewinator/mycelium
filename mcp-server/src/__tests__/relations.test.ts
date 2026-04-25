import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
