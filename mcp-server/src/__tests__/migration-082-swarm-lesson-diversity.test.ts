import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 082 — §10.4 anti-echo-chamber substrate (#114, sub-phase 4i.3)
//
// Same defensive contract-pin pattern as migration-070..081 tests: read
// the SQL, normalise it, regex-pin every load-bearing structural invariant.
// The autonomy loop cannot execute migrations (Reed runs them by hand
// after merge) so contract tests live at the SQL-text level.
//
// Pins three groups of contracts that any future edit MUST keep:
//   1. swarm_lessons.local_weight column (DEFAULT 1.0, CHECK 0..1, indexed).
//   2. lesson_diversity_log append-only audit table — including the
//      (new_weight <= prev_weight) CHECK that encodes §10.4's "decrease
//      ... rather than increase" wording at the SQL layer.
//   3. rem_diversity_check_lessons RPC — 6-arg STABLE signature, 7-col
//      return shape, local-only invariant (only swarm_lessons), all six
//      thresholds parameterised, GRANTed to anon + service_role.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/082_swarm_lesson_diversity.sql",
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
// (1) swarm_lessons.local_weight column
// ---------------------------------------------------------------------------

test("swarm_lessons gets local_weight column with DEFAULT 1.0 and 0..1 CHECK", () => {
  // The DEFAULT 1.0 is the no-op anchor: every existing row keeps full
  // weight until §10.4 ratchets it down. Without it, the existing
  // swarm_lessons rows would be NULL on a column declared NOT NULL — the
  // ALTER would fail on the first node that runs the migration with data.
  assert.match(
    SQL,
    /alter table swarm_lessons\s+add column if not exists local_weight real not null default 1\.0\s+check\s*\(\s*local_weight >= 0 and local_weight <= 1\s*\)/,
  );
});

test("swarm_lessons gets a btree index on local_weight", () => {
  // Future recall queries that filter / order by local_weight (§10.4 says
  // the lesson's influence is reduced — the natural query is "give me
  // lessons with local_weight above some floor") need an index to avoid
  // a sequential scan on a growing swarm_lessons table.
  assert.match(SQL, /create index if not exists swarm_lessons_local_weight_idx\s+on swarm_lessons \(local_weight\)/);
});

// ---------------------------------------------------------------------------
// (2) lesson_diversity_log append-only audit table
// ---------------------------------------------------------------------------

test("lesson_diversity_log table has the required columns + types", () => {
  // Pin the column shape — the rem-diversity service writes against this
  // exact set. Renaming or dropping any column is a silent contract break.
  assert.match(SQL, /create table if not exists lesson_diversity_log\b/);
  assert.match(SQL, /lesson_id\s+uuid\s+not null references swarm_lessons\(id\) on delete cascade/);
  assert.match(SQL, /prev_weight\s+real\s+not null check\s*\(\s*prev_weight >= 0 and prev_weight <= 1\s*\)/);
  assert.match(SQL, /new_weight\s+real\s+not null check\s*\(\s*new_weight\s+>= 0 and new_weight\s+<= 1\s*\)/);
  assert.match(SQL, /topic_cohort_size\s+int\s+not null check\s*\(\s*topic_cohort_size >= 1\s*\)/);
  assert.match(SQL, /near_dup_origin_count\s+int\s+not null check\s*\(\s*near_dup_origin_count >= 1\s*\)/);
  assert.match(SQL, /over_concentration\s+float\s+not null check\s*\(\s*over_concentration >= 0 and over_concentration <= 1\s*\)/);
  assert.match(SQL, /reason\s+text\s+not null check\s*\(\s*octet_length\(reason\) <= 512\s*\)/);
  assert.match(SQL, /near_dup_lesson_ids\s+uuid\[\]\s+not null default '\{\}'/);
});

test("lesson_diversity_log enforces (new_weight <= prev_weight) at the SQL layer", () => {
  // The §10.4 spec wording is "decrease its local weight ... rather than
  // increase". This CHECK is the single most important contract on this
  // migration: it makes accidental amplification structurally impossible,
  // not application-discipline-dependent.
  assert.match(SQL, /check \(new_weight <= prev_weight\)/);
});

test("lesson_diversity_log has an index on (lesson_id, at DESC) for audit lookups", () => {
  // The natural operator query is "what's the audit history for THIS
  // lesson?" — a (lesson_id, at DESC) index supports the most recent-first
  // scan without a sort step.
  assert.match(SQL, /create index if not exists lesson_diversity_log_lesson_idx\s+on lesson_diversity_log \(lesson_id, at desc\)/);
});

// ---------------------------------------------------------------------------
// (3) rem_diversity_check_lessons signature + parameters
// ---------------------------------------------------------------------------

test("rem_diversity_check_lessons has the documented 6-arg signature", () => {
  // Param order matters because callers (services/rem-diversity.ts) bind
  // by name via supabase-js, but the named-args RPC convention still
  // relies on the database knowing the parameter list. A reorder here
  // would be a silent ABI change.
  assert.match(
    SQL,
    /create or replace function rem_diversity_check_lessons\s*\(\s*p_topic_cosine\s+float\s+default\s+0\.85\s*,\s*p_duplicate_cosine\s+float\s+default\s+0\.95\s*,\s*p_evidence_count_band\s+int\s+default\s+1\s*,\s*p_signed_at_window_d\s+int\s+default\s+7\s*,\s*p_min_cohort_size\s+int\s+default\s+3\s*,\s*p_over_concentration\s+float\s+default\s+0\.8\s*\)/,
  );
});

test("rem_diversity_check_lessons is declared STABLE (read-only side-effect class)", () => {
  // STABLE marks a pure read RPC: PG can cache results within a query, and
  // crucially it documents to operators that this function does not mutate
  // any rows. A future edit that turns it VOLATILE would silently broaden
  // the contract.
  assert.match(SQL, /language sql\s+stable\b/);
});

test("rem_diversity_check_lessons returns the documented 7 columns", () => {
  // Pin the return shape: the rem-diversity service consumes every one of
  // these columns. Renaming or dropping any of them is a silent breaking
  // change at the JS/SQL boundary.
  assert.match(
    SQL,
    /returns table\s*\(\s*swarm_lesson_id\s+uuid\s*,\s*origin_node_id\s+text\s*,\s*swarm_lesson_text\s+text\s*,\s*topic_cohort_size\s+int\s*,\s*near_dup_origin_count\s+int\s*,\s*over_concentration\s+float\s*,\s*near_dup_lesson_ids\s+uuid\[\]\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (4) Local-only invariant — function reads ONLY swarm_lessons
// ---------------------------------------------------------------------------

test("rem_diversity_check_lessons reads from swarm_lessons", () => {
  // The receiver-side per-peer concentration signal is a swarm-table-only
  // signal. Pin the FROM clause so a future edit can't silently broaden
  // the source set.
  assert.match(SQL, /from swarm_lessons\b/);
});

test("rem_diversity_check_lessons does NOT read experiences or local lessons", () => {
  // §10.4 is explicitly about peer concentration — joining `experiences`
  // or `lessons` would mix lived-evidence signal into a diversity check
  // that is supposed to operate on inter-peer over-concentration. Pin the
  // absence so a future edit can't accidentally widen the source set.
  assert.doesNotMatch(SQL, /\bjoin\s+experiences\b/);
  assert.doesNotMatch(SQL, /\bfrom\s+experiences\b/);
  assert.doesNotMatch(SQL, /\bjoin\s+lessons\b/);
  assert.doesNotMatch(SQL, /\bfrom\s+lessons\b/);
});

test("rem_diversity_check_lessons does NOT cross-reference other swarm tables", () => {
  // swarm_hub_anchors, swarm_lesson_contradictions, tier_promotion_log,
  // trust_edge_log all exist; pulling them into the diversity pass would
  // mix in tier / contradiction / trust signals that are not part of §10.4.
  // Pin the absence.
  assert.doesNotMatch(SQL, /\bjoin\s+swarm_hub_anchors\b/);
  assert.doesNotMatch(SQL, /\bjoin\s+swarm_lesson_contradictions\b/);
  assert.doesNotMatch(SQL, /\bjoin\s+tier_promotion_log\b/);
  assert.doesNotMatch(SQL, /\bjoin\s+trust_edge_log\b/);
  assert.doesNotMatch(SQL, /\bjoin\s+nodes\b/);
});

// ---------------------------------------------------------------------------
// (5) Threshold parameters — every gate flows from a parameter, not a literal
// ---------------------------------------------------------------------------

test("rem_diversity_check_lessons uses p_topic_cosine for the topic-cohort cosine bound", () => {
  // Operators tune topic coverage per their audit aggressiveness.
  assert.match(SQL, /\(\s*1 - \(\s*other\.embedding <=> l\.embedding\s*\)\s*\) >= p_topic_cosine/);
});

test("rem_diversity_check_lessons uses p_duplicate_cosine for the near-duplicate cosine bound", () => {
  // §10.4 spec text: "cosine_similarity > 0.95" — pin that the bound is
  // the parameter, defaulted to that value, not a hard-coded literal.
  assert.match(SQL, /\(\s*1 - \(\s*other\.embedding <=> tc\.center_emb\s*\)\s*\) >= p_duplicate_cosine/);
});

test("rem_diversity_check_lessons uses p_evidence_count_band for the evidence-count similarity gate", () => {
  // §10.4 spec text: "evidence_count similar" — implementation-defined.
  // We use |Δ| <= band and surface the band as a parameter so a future
  // operator can loosen / tighten without a migration.
  assert.match(SQL, /abs\(\s*other\.evidence_count - tc\.center_evidence\s*\) <= p_evidence_count_band/);
});

test("rem_diversity_check_lessons uses p_signed_at_window_d for the signed_at proximity gate", () => {
  // §10.4 spec text: "signed_at within 7 days" — pin parameter binding.
  assert.match(SQL, /abs\(\s*extract\(epoch from \(\s*other\.signed_at - tc\.center_signed_at\s*\)\)\s*\) <= \(\s*p_signed_at_window_d \* 86400\s*\)/);
});

test("rem_diversity_check_lessons enforces p_min_cohort_size as a statistical floor", () => {
  // A 1-peer cohort cannot meaningfully be over-concentrated; the floor
  // exists so a brand-new node with one peer doesn't decrement every
  // single import on day one. Pin the floor as a parameter so the
  // operator can lower it for testing without a migration.
  assert.match(SQL, /tc\.topic_cohort_size >= p_min_cohort_size/);
});

test("rem_diversity_check_lessons enforces over_concentration via the parameter", () => {
  // §10.4 threshold flows from the parameter, not a hard-coded 0.8.
  // The implementation uses >= (not >) to match the issue's "4 of 5 →
  // trigger" acceptance test, which is exactly 80%.
  assert.match(
    SQL,
    /\(\s*nd\.near_dup_origin_count::float \/ nullif\(\s*tc\.topic_cohort_size\s*,\s*0\s*\)\s*\) >= p_over_concentration/,
  );
});

// ---------------------------------------------------------------------------
// (6) GRANT EXECUTE — without it the digest pipeline hits permissions errors
// ---------------------------------------------------------------------------

test("rem_diversity_check_lessons GRANTs EXECUTE to anon + service_role", () => {
  assert.match(
    SQL,
    /grant execute on function rem_diversity_check_lessons\s*\(\s*float\s*,\s*float\s*,\s*int\s*,\s*int\s*,\s*int\s*,\s*float\s*\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (7) Migration discipline — additive only, no destructive DDL
// ---------------------------------------------------------------------------

test("migration 082 contains no DROP / DELETE / TRUNCATE statements", () => {
  // The autonomy loop must never authorise destructive migrations. Same
  // hard rule as 071 / 075 / 078 / 079 / 081 — pin it.
  // (CREATE OR REPLACE FUNCTION is fine; that's not a DROP.)
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|constraint|trigger|view)\b/);
  assert.doesNotMatch(SQL, /\bdrop\s+function\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
});

test("migration 082 does NOT grant UPDATE/DELETE on lesson_diversity_log (append-only)", () => {
  // The append-only contract is enforced by withholding UPDATE/DELETE
  // grants. The migration must not introduce them; if a future operator
  // needs to redact a row, that's a separate, manually-reviewed migration.
  assert.doesNotMatch(SQL, /grant\s+update[^;]*\bon\s+lesson_diversity_log\b/);
  assert.doesNotMatch(SQL, /grant\s+delete[^;]*\bon\s+lesson_diversity_log\b/);
});
