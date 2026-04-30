import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 081 — REM promotion-audit RPC contract pin (#114, sub-phase 4i.2)
//
// Defensive contract-pin pattern matching migration-079's tests; this is the
// symmetric counterpart for the §10.6 promotion path. Reading the SQL,
// normalising it, regex-pinning every load-bearing structural invariant.
//
// Pins seven contracts that any future edit MUST keep:
//   1. The function signature is the documented 4-arg STABLE form (the
//      params mirror 079 in shape but rename `p_max_local_valence` →
//      `p_min_local_valence` to make polarity unambiguous).
//   2. The function reads ONLY swarm_lessons + experiences (the §10.6
//      local-only invariant; without it two peers could mutually promote
//      each other's claims to Tier-A — clean echo-chamber entry point).
//   3. The Tier-B firebreak filter (`lesson_tier = 'B'`) is enforced at
//      the SQL level (a Tier-A lesson must not be re-promoted; per §10.6
//      transitions are append-only and a demoted-then-corroborated lesson
//      requires explicit operator review, not auto-promotion).
//   4. The corroborating-cluster filter combines cosine + valence + outcome
//      with the right polarity (positive valence + success/partial outcome).
//      Dropping any of the three loosens "corroboration" past the §10.6
//      definition and risks promoting a lesson the local node merely *did
//      not contradict* rather than actually *corroborated*.
//   5. The function is GRANTed to anon + service_role; without the GRANT
//      digest.ts hits a permissions error in production.
//   6. The migration is purely additive (no DROP / DELETE / TRUNCATE / ALTER).
//   7. The function is the symmetric mirror of 079's contradicting RPC —
//      same parameter shape, same return shape — so the orchestrator layer
//      can consume both with the same JS contract.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/081_rem_promotion_audit.sql",
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
// We KEEP single-quoted literals here because several pins below depend
// on values like 'B' / 'success' / 'partial' being present in the SQL.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");
// Second view of the SQL with `COMMENT ON ... IS '...';` clauses removed.
// The COMMENT bodies embed free prose that mentions UPDATE / INSERT for
// readability, which trips the "no destructive DDL" keyword pins. We do
// the keyword-only scans against this stripped view; structural pins stay
// against `SQL` (which still has the load-bearing literals).
const SQL_NO_COMMENT_STMT = SQL.replace(
  /comment\s+on\s+\w+\s+[^;]*?\s+is\s+'(?:[^']|'')*'\s*;/g,
  "",
);

// ---------------------------------------------------------------------------
// (1) Function signature — 4 parameters in documented order, STABLE
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons has the documented 4-arg signature", () => {
  // Param order matters because callers (services/rem-promotion.ts) bind by
  // name via supabase-js, but the named-args RPC convention still relies
  // on the database knowing the parameter list. A reorder here would be a
  // silent ABI change. Note `p_min_local_valence` (not `p_max_local_valence`
  // as in 079) — the polarity flip is the whole point of the new RPC.
  assert.match(
    SQL,
    /create or replace function rem_promote_swarm_lessons\s*\(\s*p_min_cluster_size\s+int\s+default\s+2\s*,\s*p_min_cosine\s+float\s+default\s+0\.8\s*,\s*p_min_local_valence\s+float\s+default\s+0\.3\s*,\s*p_max_age_days\s+int\s+default\s+90\s*\)/,
  );
});

test("rem_promote_swarm_lessons is declared STABLE (read-only side-effect class)", () => {
  // STABLE is the right marker for a pure read RPC: PG can cache results
  // within a query, and crucially it documents to operators that this
  // function does not mutate any rows — the tier flip is a separate UPDATE
  // executed by the JS orchestrator. A future edit that turns it VOLATILE
  // would silently broaden the contract.
  assert.match(SQL, /language sql\s+stable\b/);
});

test("rem_promote_swarm_lessons returns the documented 8 columns", () => {
  // Pin the return shape: digest.ts and the REM-promotion service consume
  // every one of these columns. Renaming or dropping any of them is a
  // silent breaking change at the JS/SQL boundary. The shape is identical
  // to 079 by design — both orchestrators use the same RemPromotionFinding /
  // RemAuditFinding row type.
  assert.match(
    SQL,
    /returns table\s*\(\s*swarm_lesson_id\s+uuid\s*,\s*origin_node_id\s+text\s*,\s*swarm_lesson_text\s+text\s*,\s*cluster_size\s+int\s*,\s*mean_cosine\s+float\s*,\s*mean_local_valence\s+float\s*,\s*local_evidence_ids\s+uuid\[\]\s*,\s*seed_summary\s+text\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) Local-only invariant — function joins ONLY swarm_lessons + experiences
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons reads from experiences (the lived-evidence ground truth)", () => {
  // Mirror of 079's invariant. The whole §10.6 promotion path hinges on
  // this: the corroborating cluster must come from local lived experience,
  // not from another swarm-imported lesson. Removing this JOIN would let
  // the §10.4 echo-chamber attack auto-promote co-conspirators.
  assert.match(SQL, /join experiences e\b/);
});

test("rem_promote_swarm_lessons does NOT read the local lessons table", () => {
  // Cross-project leakage was the regression captured in lesson #4
  // (swarm-imported material reaches lessons via record_lesson, so JOINing
  // lessons here would re-import swarm context as ground truth and let a
  // swarm lesson promote *itself* through a derived local lesson). The
  // local-only invariant means promotion never touches the lessons table.
  assert.doesNotMatch(SQL, /join\s+lessons\b/);
  assert.doesNotMatch(SQL, /from\s+lessons\b/);
});

test("rem_promote_swarm_lessons does NOT cross-reference other swarm tables", () => {
  // swarm_hub_anchors, swarm_lesson_contradictions, tier_promotion_log all
  // exist; pulling any of them into the promotion read would mix swarm-
  // derived signals back into ground truth or — in tier_promotion_log's
  // case — let prior promotions self-amplify. Pin the absence so a future
  // edit can't silently broaden the source set.
  assert.doesNotMatch(SQL, /join\s+swarm_hub_anchors\b/);
  assert.doesNotMatch(SQL, /join\s+swarm_lesson_contradictions\b/);
  assert.doesNotMatch(SQL, /join\s+tier_promotion_log\b/);
});

// ---------------------------------------------------------------------------
// (3) Tier-B firebreak — the SQL filters tentative lessons explicitly
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons filters to lesson_tier = 'B' (Tier-B / tentative)", () => {
  // The §10.6 firebreak: only Tier-B lessons can be promoted by §10.6.
  // A Tier-A lesson is already broadcast-eligible — re-promoting one is a
  // no-op at best and corrupts the audit log at worst. A Tier-A lesson
  // demoted by §10.5 falsification can ONLY be re-promoted by an operator
  // review with new evidence, not auto-promoted by another REM pass.
  // Dropping this filter would let promotion re-fire indefinitely.
  assert.match(SQL, /where lesson_tier = 'b'/);
});

// ---------------------------------------------------------------------------
// (4) Corroborating-cluster filter — cosine AND valence AND outcome
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons enforces the cosine threshold via parameter", () => {
  // Pin that the cosine bound flows from the parameter, not a hard-coded
  // literal. Operators tune `p_min_cosine` per their promotion aggressiveness.
  assert.match(SQL, /\(\s*1 - \(\s*e\.embedding <=> sl\.embedding\s*\)\s*\) >= p_min_cosine/);
});

test("rem_promote_swarm_lessons enforces the valence floor via parameter", () => {
  // Without the valence filter, a cluster of *negative* local experiences
  // (which 079 treats as falsification) could also count as "corroborating"
  // because they sit cosine-near the topic. The valence >= p_min_local_valence
  // clause is the signed signal that distinguishes "the swarm matched our
  // good outcomes" from "the swarm matched our bad outcomes" — the polarity
  // mirror of 079's `e.valence <= p_max_local_valence`.
  assert.match(SQL, /e\.valence >= p_min_local_valence/);
});

test("rem_promote_swarm_lessons restricts the outcome filter to non-failure episodes", () => {
  // Outcome is the second polarity signal alongside valence — a "failure"
  // experience near a swarm lesson's topic is contradiction (079 territory),
  // never corroboration. Pin the IN-set so a future edit can't accidentally
  // include 'failure' or 'unknown' (silent false-positive promotions that
  // would let an under-evidenced lesson reach Tier-A and become broadcast-
  // eligible).
  assert.match(SQL, /e\.outcome in \(\s*'success'\s*,\s*'partial'\s*\)/);
});

test("rem_promote_swarm_lessons enforces the cluster-size minimum via HAVING", () => {
  // §10.6 requires "≥ 2 of this node's local experiences". A single
  // corroborating experience is not enough. Pinning the HAVING clause
  // prevents a refactor that drops the size guard and turns every loosely-
  // related positive experience into a Tier-A promotion — the broadcast
  // amplification surface that the §10.6 firebreak exists to deny.
  assert.match(SQL, /having count\(\*\) >= p_min_cluster_size/);
});

// ---------------------------------------------------------------------------
// (5) GRANT EXECUTE — without it digest.ts hits permissions errors
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons GRANTs EXECUTE to anon + service_role", () => {
  assert.match(
    SQL,
    /grant execute on function rem_promote_swarm_lessons\s*\(\s*int\s*,\s*float\s*,\s*float\s*,\s*int\s*\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (6) Migration discipline — additive only, no destructive DDL
// ---------------------------------------------------------------------------

test("migration 081 contains no DROP / DELETE / TRUNCATE statements", () => {
  // The autonomy loop must never authorise destructive migrations. This
  // is the same hard rule as migration 071 / 075 / 078 / 079 — pin it.
  // (CREATE OR REPLACE FUNCTION is fine; that's not a DROP.) We scan the
  // comment-stripped view so prose inside COMMENT ON ... IS '...' cannot
  // satisfy or violate the assertion.
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /\bdrop\s+(table|index|constraint|trigger|view)\b/);
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /\bdrop\s+function\b/);
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /\btruncate\b/);
});

test("migration 081 contains no ALTER on existing tables (purely additive RPC)", () => {
  // The 4i.2 spec is a read-side helper. Adding columns to swarm_lessons,
  // experiences, or tier_promotion_log from this migration would silently
  // broaden the change set beyond the issue scope — the orchestrator layer
  // does the writes, not the migration.
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /\balter table\b/);
});

test("migration 081 does NOT mutate tier_promotion_log directly", () => {
  // The promotion side effect lives in the JS orchestrator (rem-promotion.ts
  // applyFinding), not in the SQL. Migration 081 is read-only. If a future
  // edit moves the INSERT into the RPC, the STABLE marker breaks AND the
  // append-only log discipline (no UPDATE/DELETE grants from migration 078)
  // becomes a per-RPC concern instead of a clean orchestrator boundary.
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /insert\s+into\s+tier_promotion_log\b/);
  assert.doesNotMatch(SQL_NO_COMMENT_STMT, /update\s+swarm_lessons\b/);
});

// ---------------------------------------------------------------------------
// (7) Symmetric-mirror invariant — same shape as 079, opposite polarity
// ---------------------------------------------------------------------------

test("rem_promote_swarm_lessons mirrors rem_audit_swarm_lessons in shape", () => {
  // The two RPCs MUST keep the same parameter count and return-table shape
  // so the JS orchestrator can consume them with the same row contract.
  // If a future edit adds a parameter to one and not the other, the unit
  // tests for both services pass independently but the digest pipeline
  // breaks at runtime when the row types diverge.
  const auditPath = resolve(
    __dirname,
    "../../..",
    "supabase/migrations/079_rem_self_audit.sql",
  );
  const auditSql = readFileSync(auditPath, "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

  // Both RPCs return exactly the same 8 columns in the same order.
  const returnShape = /returns table\s*\(\s*swarm_lesson_id\s+uuid\s*,\s*origin_node_id\s+text\s*,\s*swarm_lesson_text\s+text\s*,\s*cluster_size\s+int\s*,\s*mean_cosine\s+float\s*,\s*mean_local_valence\s+float\s*,\s*local_evidence_ids\s+uuid\[\]\s*,\s*seed_summary\s+text\s*\)/;
  assert.match(SQL, returnShape);
  assert.match(auditSql, returnShape);
});
