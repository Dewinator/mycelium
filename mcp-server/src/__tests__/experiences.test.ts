import { test } from "node:test";
import assert from "node:assert/strict";
import {
  outcomeToEventType,
  buildMarkUsefulFromExperienceContext,
  buildOutcomeEventContext,
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

// ---------------------------------------------------------------------------
// buildOutcomeEventContext — JSONB payload for `agent_completed` /
// `agent_error` memory_events emitted from ExperienceService.record().
//
// Why these tests matter: compute_affect() §frustration
// (docs/affect-observables.md) currently reads only the *count* of these
// events, but the payload keys are the natural inputs for the planned tuning
// pass (weighting retries by task_type / difficulty) and `experience_id`
// joins the event back to its episode for introspection tools (memory_history,
// memory_patterns). The SQL trigger reads JSONB via `(context->>'…')` casts,
// so a silent rename — say, dropping `task_type` to `taskType` — would not
// break compilation, would not break the existing outcomeToEventType
// guard, and would not break the FakeService accumulator in handlers.test.ts
// (which records function args, not JSONB shape). It would, however, zero
// out any future weighted frustration term and break dashboard joins. Pin
// the wire contract here.
// ---------------------------------------------------------------------------

const EXP_ID = "11111111-2222-3333-4444-555555555555";

test("buildOutcomeEventContext: returns exactly the documented key set", () => {
  // Pin the key set so adding fields is a deliberate contract change rather
  // than an accidental drift. Mirrors the buildRecalledContext guard.
  const ctx = buildOutcomeEventContext(EXP_ID, "success", "refactor", 0.4);
  assert.deepEqual(
    Object.keys(ctx).sort(),
    ["difficulty", "experience_id", "outcome", "task_type"],
  );
});

test("buildOutcomeEventContext: maps taskType arg → 'task_type' key (snake_case)", () => {
  // The TS arg is camelCase; the JSONB key MUST be 'task_type' because
  // compute_affect() reads JSONB via `(context->>'task_type')`. A silent
  // rename to camelCase would zero out the planned weighted retry term.
  const ctx = buildOutcomeEventContext(EXP_ID, "failure", "debug", null);
  assert.equal(ctx.task_type, "debug");
  assert.equal((ctx as unknown as Record<string, unknown>).taskType, undefined);
});

test("buildOutcomeEventContext: maps experienceId arg → 'experience_id' key (snake_case)", () => {
  // Snake_case is the SQL convention; introspection tools (memory_history)
  // join via this key. A camelCase rename would silently break the join.
  const ctx = buildOutcomeEventContext(EXP_ID, "partial", null, null);
  assert.equal(ctx.experience_id, EXP_ID);
  assert.equal(
    (ctx as unknown as Record<string, unknown>).experienceId,
    undefined,
  );
});

test("buildOutcomeEventContext: passes outcome through unchanged (used for filtering)", () => {
  // outcome is also already encoded in event_type ('success' → agent_completed,
  // etc.), but the payload still carries the raw string so a future
  // tuning pass can distinguish 'success' from 'partial' without reverse-
  // mapping the event_type. Pin the passthrough.
  const ctx = buildOutcomeEventContext(EXP_ID, "partial", "research", 0.3);
  assert.equal(ctx.outcome, "partial");
  assert.equal(typeof ctx.outcome, "string");
});

test("buildOutcomeEventContext: difficulty=0 round-trips as a number, not null", () => {
  // The trigger cast `(context->>'difficulty')::float` would coerce the JSON
  // null to SQL NULL but a literal 0 must stay a number. A naive
  // `?? null` chain that treats 0 as falsy would silently drop the value;
  // pin that 0 survives.
  const ctx = buildOutcomeEventContext(EXP_ID, "success", "refactor", 0);
  assert.equal(ctx.difficulty, 0);
  assert.equal(typeof ctx.difficulty, "number");
});

test("buildOutcomeEventContext: undefined optional inputs become JSON null", () => {
  // ExperienceService.record() passes input.task_type / input.difficulty
  // straight through; both are optional in RecordExperienceInput. The
  // helper must coerce undefined → null so the JSONB payload doesn't end
  // up with a missing key (Postgres would store the JSON value 'null',
  // not a missing key, but the runtime shape stays consistent for any
  // TypeScript consumer that downstream-reads the helper).
  const ctx = buildOutcomeEventContext(EXP_ID, "success", undefined, undefined);
  assert.equal(ctx.task_type, null);
  assert.equal(ctx.difficulty, null);
  assert.ok("task_type" in ctx);
  assert.ok("difficulty" in ctx);
});

test("buildOutcomeEventContext: null inputs stay null (no double-coercion)", () => {
  // Defensive: the caller may already pass null explicitly. The helper
  // must not coerce null → undefined or drop the key entirely.
  const ctx = buildOutcomeEventContext(EXP_ID, "failure", null, null);
  assert.equal(ctx.task_type, null);
  assert.equal(ctx.difficulty, null);
});

test("buildOutcomeEventContext: is pure (no aliasing across calls)", () => {
  // Mirrors the buildRecalledContext purity guard. Future maintainers may
  // be tempted to memoize; mutation across calls would be a footgun if
  // the helper grows.
  const a = buildOutcomeEventContext(EXP_ID, "success", "a", 0.1);
  const b = buildOutcomeEventContext(EXP_ID, "failure", "b", 0.9);
  assert.notStrictEqual(a, b);
  assert.equal(a.outcome, "success");
  assert.equal(b.outcome, "failure");
  assert.equal(a.task_type, "a");
  assert.equal(b.task_type, "b");
});
