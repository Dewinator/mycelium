import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 079 — REM self-audit RPC contract pin (#109, sub-phase 4h)
//
// Same defensive contract-pin pattern as migration-070..078 tests: read
// the SQL, normalise it, regex-pin every load-bearing structural invariant.
// The autonomy loop cannot execute migrations (Reed runs them by hand
// after merge) so contract tests live at the SQL-text level.
//
// Pins five contracts that any future edit MUST keep:
//   1. The function signature is the documented 4-arg STABLE form.
//   2. The function reads ONLY swarm_lessons + experiences (the §10.5
//      local-only invariant — no `lessons`, no `swarm_*` cross-references).
//   3. The Tier-B firebreak filter (`lesson_tier = 'B'`) is enforced at
//      the SQL level (not in application code) so a future caller that
//      forgets to scope cannot accidentally falsify a Tier-A lesson.
//   4. The contradicting-cluster filter combines cosine + valence + outcome
//      — dropping any of the three loosens "contradiction" past the §10.5
//      definition and risks deleting a lesson the local node merely *did
//      not love* rather than actually *falsified*.
//   5. The function is GRANTed to anon + service_role; without the GRANT
//      digest.ts hits a permissions error in production.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/079_rem_self_audit.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so prose like
// "no DROP" inside a comment cannot accidentally satisfy or violate a
// structural assertion below.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent
// or keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Function signature — 4 parameters in documented order, STABLE
// ---------------------------------------------------------------------------

test("rem_audit_swarm_lessons has the documented 4-arg signature", () => {
  // Param order matters because callers (services/rem-audit.ts) bind by
  // name via supabase-js, but the named-args RPC convention still relies
  // on the database knowing the parameter list. A reorder here would be a
  // silent ABI change.
  assert.match(
    SQL,
    /create or replace function rem_audit_swarm_lessons\s*\(\s*p_min_cluster_size\s+int\s+default\s+2\s*,\s*p_min_cosine\s+float\s+default\s+0\.8\s*,\s*p_max_local_valence\s+float\s+default\s+-?0\.3\s*,\s*p_max_age_days\s+int\s+default\s+90\s*\)/,
  );
});

test("rem_audit_swarm_lessons is declared STABLE (read-only side-effect class)", () => {
  // STABLE is the right marker for a pure read RPC: PG can cache results
  // within a query, and crucially it documents to operators that this
  // function does not mutate any rows. A future edit that turns it
  // VOLATILE would silently broaden the contract.
  assert.match(SQL, /language sql\s+stable\b/);
});

test("rem_audit_swarm_lessons returns the documented 8 columns", () => {
  // Pin the return shape: digest.ts and the REM-audit service consume
  // every one of these columns. Renaming or dropping any of them is a
  // silent breaking change at the JS/SQL boundary.
  assert.match(
    SQL,
    /returns table\s*\(\s*swarm_lesson_id\s+uuid\s*,\s*origin_node_id\s+text\s*,\s*swarm_lesson_text\s+text\s*,\s*cluster_size\s+int\s*,\s*mean_cosine\s+float\s*,\s*mean_local_valence\s+float\s*,\s*local_evidence_ids\s+uuid\[\]\s*,\s*seed_summary\s+text\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) Local-only invariant — function joins ONLY swarm_lessons + experiences
// ---------------------------------------------------------------------------

test("rem_audit_swarm_lessons reads from experiences (the lived-evidence ground truth)", () => {
  // The whole §10.5 self-audit hinges on this: the contradicting cluster
  // must come from local lived experience, not from another swarm-imported
  // lesson. Removing this JOIN would degrade the audit to a no-op or, worse,
  // a different (wrong) source of "ground truth".
  assert.match(SQL, /join experiences e\b/);
});

test("rem_audit_swarm_lessons does NOT read the local lessons table", () => {
  // Cross-project leakage was the regression captured in lesson #4
  // (swarm-imported material reaches lessons via record_lesson, so JOINing
  // lessons here would re-import swarm context as ground truth). The
  // local-only invariant means the audit never touches the lessons table.
  assert.doesNotMatch(SQL, /join\s+lessons\b/);
  assert.doesNotMatch(SQL, /from\s+lessons\b/);
});

test("rem_audit_swarm_lessons does NOT cross-reference other swarm tables", () => {
  // swarm_hub_anchors and swarm_lesson_contradictions exist; pulling them
  // into the audit would mix swarm-derived signals back into ground truth.
  // Pin the absence so a future edit can't silently broaden the source set.
  assert.doesNotMatch(SQL, /join\s+swarm_hub_anchors\b/);
  assert.doesNotMatch(SQL, /join\s+swarm_lesson_contradictions\b/);
});

// ---------------------------------------------------------------------------
// (3) Tier-B firebreak — the SQL filters tentative lessons explicitly
// ---------------------------------------------------------------------------

test("rem_audit_swarm_lessons filters to lesson_tier = 'B' (Tier-B / tentative)", () => {
  // The §10.6 firebreak: only Tier-B lessons can be falsified by §10.5.
  // A Tier-A lesson reached its tier by independent local corroboration
  // and can only be demoted by a separate operator-reviewed flow (§10.6).
  // Dropping this filter would let a single audit pass demote Tier-A.
  assert.match(SQL, /where lesson_tier = 'b'/);
});

// ---------------------------------------------------------------------------
// (4) Contradicting-cluster filter — cosine AND valence AND outcome
// ---------------------------------------------------------------------------

test("rem_audit_swarm_lessons enforces the cosine threshold via parameter", () => {
  // Pin that the cosine bound flows from the parameter, not a hard-coded
  // literal. Operators tune `p_min_cosine` per their audit aggressiveness.
  assert.match(SQL, /\(\s*1 - \(\s*e\.embedding <=> sl\.embedding\s*\)\s*\) >= p_min_cosine/);
});

test("rem_audit_swarm_lessons enforces the valence ceiling via parameter", () => {
  // Without the valence filter, a cluster of *positive* local experiences
  // (corroboration) would also count as "contradicting" and falsely
  // trigger forget. The valence ≤ p_max_local_valence clause is the
  // signed signal that distinguishes "the swarm was wrong about this"
  // from "the swarm agreed with us".
  assert.match(SQL, /e\.valence <= p_max_local_valence/);
});

test("rem_audit_swarm_lessons restricts the outcome filter to non-success episodes", () => {
  // Outcome is the second polarity signal alongside valence — a "success"
  // experience near a swarm lesson's topic is corroboration, never
  // contradiction. Pin the IN-set so a future edit can't accidentally
  // include 'success' or 'unknown' (silent false-positive falsifications).
  assert.match(SQL, /e\.outcome in \(\s*'failure'\s*,\s*'partial'\s*\)/);
});

test("rem_audit_swarm_lessons enforces the cluster-size minimum via HAVING", () => {
  // A single contradicting experience is not enough — §10.5 requires a
  // *cluster*. Pinning the HAVING clause prevents a refactor that drops
  // the size guard and turns every loosely-related negative experience
  // into a falsification.
  assert.match(SQL, /having count\(\*\) >= p_min_cluster_size/);
});

// ---------------------------------------------------------------------------
// (5) GRANT EXECUTE — without it digest.ts hits permissions errors
// ---------------------------------------------------------------------------

test("rem_audit_swarm_lessons GRANTs EXECUTE to anon + service_role", () => {
  assert.match(
    SQL,
    /grant execute on function rem_audit_swarm_lessons\s*\(\s*int\s*,\s*float\s*,\s*float\s*,\s*int\s*\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (6) Migration discipline — additive only, no destructive DDL
// ---------------------------------------------------------------------------

test("migration 079 contains no DROP / DELETE / TRUNCATE statements", () => {
  // The autonomy loop must never authorise destructive migrations. This
  // is the same hard rule as migration 071 / 075 / 078 — pin it.
  // (CREATE OR REPLACE FUNCTION is fine; that's not a DROP.)
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|constraint|trigger|view)\b/);
  assert.doesNotMatch(SQL, /\bdrop\s+function\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
});

test("migration 079 contains no ALTER on existing tables (purely additive RPC)", () => {
  // The 4h spec is a read-side helper. Adding columns to swarm_lessons or
  // experiences from this migration would silently broaden the change set
  // beyond the issue scope.
  assert.doesNotMatch(SQL, /\balter table\b/);
});
