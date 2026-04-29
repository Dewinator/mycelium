import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 073 — cluster diversity gating contract pin (closes part of #95)
//
// Why this guard exists: extending find_experience_clusters with two extra
// parameters AND an extra return column is a foot-gun in PostgreSQL.
// CREATE OR REPLACE does NOT replace across different parameter counts — it
// creates an overload — and the new return shape means the prior overloads
// would even resolve to a DIFFERENT body for the same call site. Without an
// explicit DROP of every prior overload AND a re-grant of EXECUTE, this
// migration silently regresses in two ways:
//
//   1. The 4-arg overload from migration 016 stays around as a sibling
//      function with the OLD return shape (no diversity_score). Existing
//      4-arg callers keep hitting the old body and never see the gate.
//   2. The DROP wipes the GRANT issued by migration 016 along with the
//      function; forgetting to re-grant breaks every authenticated client.
//
// Same defensive pattern as migration-070-node-identity.test.ts /
// migration-071-swarm-storage.test.ts / migration-072-lessons-pattern-name.
// test.ts — read the SQL, normalise it, regex-pin the structural contract.
// The autonomy loop cannot execute migrations (Reed runs them by hand after
// merge), so contract tests live at the SQL-text level.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/073_cluster_diversity.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so a phrase like
// "no DROP" inside a comment cannot accidentally satisfy a structural
// assertion below.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent or
// keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Both prior overloads must be dropped before the recreate
// ---------------------------------------------------------------------------

test("migration 073 drops the 4-arg find_experience_clusters overload (from 016)", () => {
  // Without this DROP, CREATE OR REPLACE creates a NEW overload sitting
  // alongside the 4-arg version — every existing 4-arg caller keeps hitting
  // the old body and never sees the diversity gate.
  assert.match(
    SQL,
    /drop function if exists find_experience_clusters\s*\(\s*float\s*,\s*int\s*,\s*int\s*,\s*float\s*\)/,
  );
});

test("migration 073 drops the legacy 3-arg find_experience_clusters overload (from 015)", () => {
  // Defensive: PG keeps every distinct-arity overload alive. The 3-arg
  // version was supposed to be dropped by migration 016, but pin the
  // additional DROP here so a future revert of 016 can't resurrect it.
  assert.match(
    SQL,
    /drop function if exists find_experience_clusters\s*\(\s*float\s*,\s*int\s*,\s*int\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) New 6-arg signature with parameter ORDER pinned
// ---------------------------------------------------------------------------

test("find_experience_clusters is recreated with 6 parameters in the documented order", () => {
  // Param order matters — clients call by name via supabase-js rpc(), but
  // the SQL function's positional grant signature depends on this order.
  // The two NEW parameters (time_spread_window_hours, min_diversity_score)
  // MUST be appended at the END so the existing 3-arg TS caller in
  // services/experiences.ts:findClusters keeps working without code changes.
  assert.match(
    SQL,
    /create or replace function find_experience_clusters\s*\(\s*similarity_threshold\s+float\s+default\s+0\.85\s*,\s*min_cluster_size\s+int\s+default\s+2\s*,\s*max_age_days\s+int\s+default\s+30\s*,\s*lesson_match_threshold\s+float\s+default\s+0\.78\s*,\s*time_spread_window_hours\s+int\s+default\s+72\s*,\s*min_diversity_score\s+float\s+default\s+0\.0\s*\)/,
  );
});

test("min_diversity_score defaults to 0.0 — backwards-compatible (no gate)", () => {
  // Issue #95 / migration header axiom: callers that don't pass the gate
  // get raw clusters, exactly as before. A non-zero default would silently
  // change the REM synthesiser's output for every existing caller.
  assert.match(SQL, /min_diversity_score\s+float\s+default\s+0\.0\b/);
});

// ---------------------------------------------------------------------------
// (3) Return shape includes the new diversity_score column
// ---------------------------------------------------------------------------

test("return table includes diversity_score FLOAT as the new column", () => {
  // The diversity score MUST surface in the result row so the REM
  // synthesiser (and dashboards) can show why a cluster was emitted or
  // suppressed. Without this column the gate is opaque and untestable
  // from the TS side.
  assert.match(SQL, /returns table[\s\S]*?diversity_score\s+float[\s\S]*?\)/);
});

// ---------------------------------------------------------------------------
// (4) Body actually computes the score with the documented weights
// ---------------------------------------------------------------------------

test("diversity_score uses the documented 0.50 / 0.25 / 0.25 weighting", () => {
  // The header axiom pins this weighting:
  //   0.50 · time_spread_norm + 0.25 · project_diversity + 0.25 · task_type
  // Drift in the constants would silently change which clusters survive
  // the gate. Pin the literal expression.
  assert.match(
    SQL,
    /diversity_score\s*:=\s*0\.50\s*\*\s*time_norm\s*\+\s*0\.25\s*\*\s*p_ratio\s*\+\s*0\.25\s*\*\s*t_ratio/,
  );
});

test("body honours the gate: clusters with diversity_score < min_diversity_score are skipped", () => {
  // The gate must be a strict `<` against `min_diversity_score` so a
  // caller passing min_diversity_score=0 (the default) keeps every cluster
  // (diversity_score is bounded ≥ 0). Pinning this also guards against
  // someone "fixing" the comparison to `<=` and accidentally dropping
  // every zero-diversity cluster even when no gate was requested.
  assert.match(SQL, /if\s+diversity_score\s*<\s*min_diversity_score\s+then/);
  // After the gate fires the loop must `continue` — emitting the row would
  // defeat the purpose. Pin the continue statement after the if-branch.
  assert.match(
    SQL,
    /if\s+diversity_score\s*<\s*min_diversity_score\s+then[\s\S]*?continue\s*;[\s\S]*?end if/,
  );
});

test("time_norm clips the elapsed span to [0, 1] using time_spread_window_hours", () => {
  // The clip is what makes time_spread_norm dimensionless. Without LEAST,
  // a 30-day cluster would score ~10 on the time axis and dwarf the
  // project / task axes — the weighted sum would no longer live in [0, 1]
  // and the gate semantics would silently break.
  assert.match(
    SQL,
    /time_norm\s*:=\s*least\s*\(\s*greatest\s*\(\s*time_span_hours\s*,\s*0\s*\)\s*\/\s*nullif\s*\(\s*time_spread_window_hours\s*,\s*0\s*\)::float\s*,\s*1\.0\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (5) GRANT EXECUTE — DROP wiped the original GRANT from migration 016
// ---------------------------------------------------------------------------

test("migration 073 re-grants EXECUTE on the new 6-arg signature", () => {
  // DROP FUNCTION above removed the GRANT issued by migration 016. Without
  // this re-grant, anon/service_role lose permission to call the RPC and
  // every authenticated client (including the REM nightly job) breaks at
  // runtime — exactly the latent bug PR #97 caught in the 072 stash variant.
  assert.match(
    SQL,
    /grant execute on function find_experience_clusters\s*\(\s*float\s*,\s*int\s*,\s*int\s*,\s*float\s*,\s*int\s*,\s*float\s*\)\s+to anon\s*,\s*service_role/,
  );
});
