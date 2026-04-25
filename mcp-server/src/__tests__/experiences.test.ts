import { test } from "node:test";
import assert from "node:assert/strict";
import {
  outcomeToEventType,
  buildMarkUsefulFromExperienceContext,
} from "../services/experiences.js";

// These tests pin the mapping used by ExperienceService.record() to emit
// `agent_completed` / `agent_error` memory_events after each episode. The
// mapping is a compute_affect() input — see docs/affect-observables.md
// §frustration (retry_rate = agent_error / agent_completed).
// Breaking the mapping silently would skew the frustration dimension; this
// test is the guard.

test("outcomeToEventType: 'failure' → agent_error", () => {
  assert.equal(outcomeToEventType("failure"), "agent_error");
});

test("outcomeToEventType: 'success' → agent_completed", () => {
  assert.equal(outcomeToEventType("success"), "agent_completed");
});

test("outcomeToEventType: 'partial' → agent_completed", () => {
  assert.equal(outcomeToEventType("partial"), "agent_completed");
});

test("outcomeToEventType: 'unknown' → null (no event emitted)", () => {
  assert.equal(outcomeToEventType("unknown"), null);
});

test("outcomeToEventType: null/undefined → null", () => {
  assert.equal(outcomeToEventType(null), null);
  assert.equal(outcomeToEventType(undefined), null);
});

test("outcomeToEventType: unrecognized string → null", () => {
  assert.equal(outcomeToEventType("in_progress"), null);
  assert.equal(outcomeToEventType(""), null);
});

// ---------------------------------------------------------------------------
// buildMarkUsefulFromExperienceContext — JSONB payload for `mark_useful`
// memory_events emitted from ExperienceService.markUseful (experience-subject
// path; the memory-subject path lives in MemoryService.emitMarkUseful).
//
// Why these tests matter: compute_affect() §satisfaction
// (docs/affect-observables.md) computes useful_delta as a count of
// `mark_useful` events regardless of source, so the experience emission has
// to reach memory_events too — otherwise satisfaction undercounts whenever
// the user marks an episode useful instead of a memory. The JSONB context
// itself isn't read by the satisfaction formula, but downstream introspection
// tools (memory_history, memory_patterns) join events back to their
// experience via context.experience_id; renaming or dropping the key would
// silently break that link.
// ---------------------------------------------------------------------------

test("buildMarkUsefulFromExperienceContext: emits experience_id key", () => {
  const ctx = buildMarkUsefulFromExperienceContext(
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(ctx.experience_id, "11111111-2222-3333-4444-555555555555");
});

test("buildMarkUsefulFromExperienceContext: payload has exactly one key", () => {
  // Pin the key set so adding fields is a deliberate contract change rather
  // than an accidental drift that downstream JSONB consumers wouldn't catch.
  const ctx = buildMarkUsefulFromExperienceContext(
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.deepEqual(Object.keys(ctx).sort(), ["experience_id"]);
});

test("buildMarkUsefulFromExperienceContext: experience_id is typed as string", () => {
  // The SQL trigger does no JSON-pointer read of this key today, but the
  // emission still must round-trip a string through Postgres's JSONB without
  // accidental coercion to a different type.
  const ctx = buildMarkUsefulFromExperienceContext("not-strictly-a-uuid");
  assert.equal(typeof ctx.experience_id, "string");
});

test("buildMarkUsefulFromExperienceContext: passes empty-string id through unchanged", () => {
  // Defensive: caller must not pre-validate; the helper is a pure shaper.
  const ctx = buildMarkUsefulFromExperienceContext("");
  assert.equal(ctx.experience_id, "");
});
