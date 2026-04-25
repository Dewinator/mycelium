import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillRecordPayload } from "../services/skills.js";

// ---------------------------------------------------------------------------
// skill_record RPC payload contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §confidence) reads `skill_outcomes.outcome` as a literal-string filter:
//
//   numerator   = sum( n(outcome='success') * exp(-hours_since(last_at)/48) )
//   denominator = sum( n(*)                 * exp(-hours_since(last_at)/48) )
//
// The string `'success'` (and the other 3 outcome literals) is sourced from
// `digestSchema.outcome` (already pinned in affect-enum-contracts.test.ts)
// and flows verbatim through `digest.ts` line 142 into
// `SkillsService.record(...)` and from there into the `skill_record` RPC
// payload as `p_outcome`. The SQL function `skill_record()` then writes that
// value into `skill_outcomes.outcome`, where the confidence formula reads it.
//
// A silent rename of the RPC parameter key (e.g. `p_outcome` → `outcome`)
// or a normalising transform (`'success'` → `'ok'`) at the TS boundary
// would not break compilation, would still satisfy the `skill_record()`
// CHECK constraint (because the SQL falls back to `'unknown'` for any
// unrecognised value), and would silently zero out the confidence formula
// numerator — symptom: confidence stuck at baseline regardless of skill
// success rate, exactly the failure mode issue #11 fixes for valence.
//
// These tests pin the wire contract: the exact key set, the exact key
// names, the empty-string fallback to `'unknown'`, and value passthrough
// for every valid outcome literal compute_affect() reads.
// ---------------------------------------------------------------------------

test("buildSkillRecordPayload returns exactly the keys skill_record() declares", () => {
  // skill_record(p_skills TEXT[], p_task_type TEXT, p_outcome TEXT,
  //              p_difficulty DOUBLE PRECISION) — migration 021. Any drift
  // between the TS payload keys and the SQL parameter names produces a
  // PostgREST 400 at runtime, but compiles and unit-tests fine without
  // this assertion.
  const payload = buildSkillRecordPayload(["recall"], "implement", "success", 0.5);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["p_difficulty", "p_outcome", "p_skills", "p_task_type"],
  );
});

test("buildSkillRecordPayload pins p_outcome to the literal compute_affect §confidence reads", () => {
  // The confidence numerator filters on `outcome='success'`. If the TS
  // boundary rewrites the string (e.g. .toLowerCase() drift, locale
  // normalisation, alias map), the SQL filter silently misses every row.
  // Pin verbatim passthrough for the four canonical outcomes.
  for (const outcome of ["success", "partial", "failure", "unknown"]) {
    const payload = buildSkillRecordPayload(["x"], "t", outcome, 0.5);
    assert.equal(
      payload.p_outcome,
      outcome,
      `outcome '${outcome}' must pass through to p_outcome verbatim`,
    );
  }
});

test("buildSkillRecordPayload falls back to 'unknown' for empty outcome (matches SQL CHECK normalisation)", () => {
  // skill_record() in migration 021 normalises an empty/whitespace outcome
  // to 'unknown' before the CHECK runs. The TS wrapper does the same with
  // `outcome || 'unknown'` so a caller that passes "" doesn't hit a 500.
  // Pin the fallback because dropping it would surface as a CHECK-violation
  // 500 at runtime instead of the silent 'unknown' the SQL expects.
  const payload = buildSkillRecordPayload(["x"], "t", "", 0.5);
  assert.equal(payload.p_outcome, "unknown");
});

test("buildSkillRecordPayload falls back to 'unknown' for empty taskType (matches SQL default)", () => {
  // skill_outcomes.task_type column has DEFAULT 'unknown' (migration 021).
  // The TS wrapper mirrors that default for empty strings so the row's
  // task_type is never literally "" — which would split skill_recommend()
  // into a separate task-type bucket nobody queries.
  const payload = buildSkillRecordPayload(["x"], "", "success", 0.5);
  assert.equal(payload.p_task_type, "unknown");
});

test("buildSkillRecordPayload preserves explicit non-empty taskType verbatim", () => {
  // The fallback above is a `||`, not a normalisation. A real task_type
  // (e.g. 'implement') must reach the column unchanged so prime_context
  // can match it back later via skill_recommend(p_task_type=...).
  const payload = buildSkillRecordPayload(["x"], "implement", "success", 0.5);
  assert.equal(payload.p_task_type, "implement");
});

test("buildSkillRecordPayload passes p_skills through as-is (preserves order, case, duplicates)", () => {
  // skill_record() iterates p_skills with FOREACH and upserts one row per
  // distinct (skill, task_type, outcome) — duplicates collapse via the
  // ON CONFLICT clause, but case differences create separate rows. The TS
  // wrapper must not normalise here, otherwise skill_outcomes ends up with
  // a single 'recall' row when the caller wrote 'Recall' twice + 'recall'.
  const payload = buildSkillRecordPayload(["Recall", "Recall", "recall"], "t", "success", 0.5);
  assert.deepEqual(payload.p_skills, ["Recall", "Recall", "recall"]);
});

test("buildSkillRecordPayload passes p_difficulty through unclamped (SQL clamps to [0,1])", () => {
  // skill_record() clamps with GREATEST(0.0, LEAST(1.0, COALESCE(p_difficulty, 0.5))).
  // The TS wrapper deliberately does NOT pre-clamp: clamping in two places
  // creates two sources of truth and risks divergence (e.g. one side moves
  // to [-1,1] for a different formula and the other doesn't follow).
  // Pin that the TS layer is a transparent pipe.
  const payload = buildSkillRecordPayload(["x"], "t", "success", 1.5);
  assert.equal(payload.p_difficulty, 1.5);
  const negative = buildSkillRecordPayload(["x"], "t", "success", -0.2);
  assert.equal(negative.p_difficulty, -0.2);
});

test("buildSkillRecordPayload is pure (no aliasing across calls)", () => {
  // Future maintainers may be tempted to memoise the payload object. The
  // RPC client serialises to JSON so identity doesn't matter, but mutation
  // across calls would be a footgun if the helper grows.
  const a = buildSkillRecordPayload(["x"], "t1", "success", 0.5);
  const b = buildSkillRecordPayload(["y"], "t2", "failure", 0.6);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.p_skills, b.p_skills);
  assert.equal(a.p_task_type, "t1");
  assert.equal(b.p_task_type, "t2");
});
