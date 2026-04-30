import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 075 — TrustEdge dynamics + quarantine state machine (#107, 4f)
//
// Same defensive contract-pin pattern as migration-070 / -071 / -072 / -073 /
// -074: read the SQL, normalise it, regex-pin every load-bearing structural
// invariant. The autonomy loop cannot execute migrations (Reed runs them by
// hand after merge), so contract tests live at the SQL-text level. Tight
// pins here are deliberately worth their drift cost: reputation arithmetic
// and quarantine semantics are the swarm's anti-adversarial substrate.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/075_trust_edge_dynamics.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so any phrasing
// inside a comment cannot accidentally satisfy a structural assertion.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent or
// keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) `nodes` is extended with the §10.1 + §10.2 bookkeeping columns
// ---------------------------------------------------------------------------

test("nodes gets successful_inclusion_proof_rate_30d (REAL, nullable)", () => {
  // §10.1 input signal. Nullable so a fresh peer with no proof history
  // doesn't violate NOT NULL on insert; the formula collapses NULL → 1.0
  // (no decay applied).
  assert.match(
    SQL,
    /alter table nodes add column if not exists successful_inclusion_proof_rate_30d\s+real\s*;/,
  );
});

test("nodes gets avg_local_useful_count (REAL, nullable)", () => {
  assert.match(
    SQL,
    /alter table nodes add column if not exists avg_local_useful_count\s+real\s*;/,
  );
});

test("nodes gets age_factor (REAL, NOT NULL, default 1.0)", () => {
  // Default 1.0 means "fully aged-in" so existing rows aren't penalised
  // until the REM cycle computes a real value.
  assert.match(
    SQL,
    /alter table nodes add column if not exists age_factor\s+real\s+not null\s+default\s+1\.0\s*;/,
  );
});

test("nodes gets quarantined_until (TIMESTAMPTZ, nullable)", () => {
  // NULL == not quarantined. is_quarantined() depends on this nullability
  // semantic — a NOT NULL default would force every row into "quarantined
  // until 1970-01-01" land and break the polling-side filter.
  assert.match(
    SQL,
    /alter table nodes add column if not exists quarantined_until\s+timestamptz\s*;/,
  );
});

test("nodes gets last_decay_at (TIMESTAMPTZ, nullable)", () => {
  assert.match(
    SQL,
    /alter table nodes add column if not exists last_decay_at\s+timestamptz\s*;/,
  );
});

test("nodes gets decay_reason (TEXT, nullable)", () => {
  assert.match(
    SQL,
    /alter table nodes add column if not exists decay_reason\s+text\s*;/,
  );
});

test("nodes gets consecutive_rejections (INT, NOT NULL, default 0)", () => {
  // §10.2 N-counter. Default 0 + NOT NULL is the only sane invariant —
  // a NULL counter in the rejection state machine would be a foot-gun
  // (NULL > 5 is NULL, the threshold check would silently fail open).
  assert.match(
    SQL,
    /alter table nodes add column if not exists consecutive_rejections\s+int\s+not null\s+default\s+0\s*;/,
  );
});

// ---------------------------------------------------------------------------
// (2) Range constraints — proof rate ∈ [0, 1], age_factor ∈ [0, 1], counts ≥ 0
// ---------------------------------------------------------------------------

test("proof rate is constrained to [0, 1] when not NULL", () => {
  // The formula multiplies by this factor; values outside [0, 1] would
  // either overflow the [0, 1] clamp on the upper side (no harm) or push
  // the product negative on the lower side (the GREATEST clamps it back
  // to 0, but a negative input is a bug not a normal state). Pin the
  // CHECK so a future migration can't drop it silently.
  assert.match(
    SQL,
    /constraint nodes_proof_rate_range\s+check\s*\(\s*successful_inclusion_proof_rate_30d is null\s+or\s*\(\s*successful_inclusion_proof_rate_30d\s*>=\s*0\s+and\s+successful_inclusion_proof_rate_30d\s*<=\s*1\s*\)\s*\)/,
  );
});

test("age_factor is constrained to [0, 1]", () => {
  assert.match(
    SQL,
    /constraint nodes_age_factor_range\s+check\s*\(\s*age_factor\s*>=\s*0\s+and\s+age_factor\s*<=\s*1\s*\)/,
  );
});

test("avg_local_useful_count is constrained to >= 0", () => {
  assert.match(
    SQL,
    /constraint nodes_useful_count_nonneg\s+check\s*\(\s*avg_local_useful_count is null\s+or\s+avg_local_useful_count\s*>=\s*0\s*\)/,
  );
});

test("consecutive_rejections is constrained to >= 0", () => {
  assert.match(
    SQL,
    /constraint nodes_consecutive_rejections_nonneg\s+check\s*\(\s*consecutive_rejections\s*>=\s*0\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) trust_edge_log — append-only audit table
// ---------------------------------------------------------------------------

test("trust_edge_log table exists with the audit columns", () => {
  assert.match(
    SQL,
    /create table if not exists trust_edge_log[\s\S]*?node_id\s+text\s+not null references nodes\s*\(\s*node_id\s*\)/,
  );
  assert.match(SQL, /weight_before\s+real\s+not null/);
  assert.match(SQL, /weight_after\s+real\s+not null/);
  assert.match(SQL, /reason\s+text\s+not null/);
  assert.match(SQL, /at\s+timestamptz\s+not null\s+default now\(\)/);
});

test("trust_edge_log weight_before / weight_after are clamped to [0, 1]", () => {
  // The audit log mirrors the trust_weight column's [0, 1] domain; a row
  // with a value outside the domain would either be a producer bug or a
  // direct INSERT bypass and is worth rejecting at the DB level.
  assert.match(
    SQL,
    /check\s*\(\s*weight_before\s*>=\s*0\s+and\s+weight_before\s*<=\s*1\s*\)/,
  );
  assert.match(
    SQL,
    /check\s*\(\s*weight_after\s*>=\s*0\s+and\s+weight_after\s*<=\s*1\s*\)/,
  );
});

test("trust_edge_log has a (node_id, at DESC) index for operator queries", () => {
  assert.match(
    SQL,
    /create index if not exists trust_edge_log_node_at_idx\s+on trust_edge_log\s*\(\s*node_id\s*,\s*at desc\s*\)/,
  );
});

test("trust_edge_log is append-only (UPDATE and DELETE triggers)", () => {
  // Defense in depth — even an operator with table-owner privileges
  // shouldn't be able to silently rewrite reputation history. Same
  // pattern as lesson_chain (074).
  assert.match(SQL, /create or replace function trust_edge_log_no_mutate\s*\(\s*\)\s+returns trigger/);
  assert.match(SQL, /raise exception\s+'trust_edge_log is append-only/);
  assert.match(
    SQL,
    /create trigger trust_edge_log_no_update\s+before update on trust_edge_log/,
  );
  assert.match(
    SQL,
    /create trigger trust_edge_log_no_delete\s+before delete on trust_edge_log/,
  );
});

// ---------------------------------------------------------------------------
// (4) compute_trust_weight — the §10.1 formula, pure SQL, IMMUTABLE
// ---------------------------------------------------------------------------

test("compute_trust_weight has the documented 5-arg signature", () => {
  // Signature drift would silently break the REM-cycle caller. Pin the
  // parameter ORDER explicitly because the GRANT EXECUTE below references
  // the positional signature.
  assert.match(
    SQL,
    /create or replace function compute_trust_weight\s*\(\s*base_weight\s+real\s*,\s*proof_rate_30d\s+real\s*,\s*avg_useful_count\s+real\s*,\s*useful_count_threshold\s+real\s*,\s*age_factor\s+real\s*\)\s+returns real/,
  );
});

test("compute_trust_weight is IMMUTABLE (cacheable, deterministic)", () => {
  // Must be IMMUTABLE so the planner can fold constant calls and so the
  // function passes contract-test assertions about determinism. Marking it
  // STABLE or VOLATILE would silently change query plans and re-run the
  // formula on every row when used as a generated-column expression.
  assert.match(SQL, /language sql immutable/);
});

test("compute_trust_weight clamps the product to [0, 1]", () => {
  // The clamp is the §10.1 "weight ∈ [0, 1]" guarantee. Without it, a
  // base_weight of 1.0 (operator-pinned origin) combined with a proof
  // rate near 1 and a high useful_count could produce > 1 and unbalance
  // every downstream weighting calculation.
  assert.match(
    SQL,
    /greatest\s*\(\s*0\.0::real\s*,\s*least\s*\(\s*1\.0::real\s*,/,
  );
});

test("compute_trust_weight uses NULLIF on threshold to avoid div-by-zero", () => {
  // useful_count_threshold = 0 is a config-time mistake but should not
  // crash the nightly REM job. NULLIF(threshold, 0) makes the division
  // produce NULL, which COALESCE folds to 1.0 (no decay). Surprising
  // behaviour, but the safer of the two — pin it.
  assert.match(SQL, /nullif\s*\(\s*useful_count_threshold\s*,\s*0\s*\)/);
});

test("compute_trust_weight has GRANT EXECUTE to anon and service_role", () => {
  assert.match(
    SQL,
    /grant execute on function compute_trust_weight\s*\(\s*real\s*,\s*real\s*,\s*real\s*,\s*real\s*,\s*real\s*\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (5) record_trust_edge_change — atomic weight update + audit log
// ---------------------------------------------------------------------------

test("record_trust_edge_change requires a non-empty reason", () => {
  // §10.1 says weight changes MUST be recorded with a reason. A NULL or
  // empty reason would defeat the audit surface — fail loud at the DB.
  assert.match(
    SQL,
    /raise exception 'record_trust_edge_change: reason is required/,
  );
});

test("record_trust_edge_change rejects out-of-range weights", () => {
  assert.match(
    SQL,
    /raise exception 'record_trust_edge_change: weight must be in \[0, 1\], got %'/,
  );
});

test("record_trust_edge_change short-circuits on no-op weight changes", () => {
  // If the new weight equals the existing one, no log row is written.
  // This keeps the audit log signal-to-noise high — only real changes
  // appear. Pin the comparison so a future "always log" refactor can't
  // silently flood the log.
  assert.match(SQL, /if v_before = p_new_weight then\s+return\s*;/);
});

test("record_trust_edge_change writes the log row BEFORE updating nodes", () => {
  // Order matters for audit invariants: if the UPDATE went first and the
  // INSERT crashed, the audit log would lose the {before, after} pair
  // forever. Doing INSERT first means a crash leaves the system with a
  // log entry but no nodes update — recoverable. Pin the order.
  assert.match(
    SQL,
    /insert into trust_edge_log[\s\S]*?values\s*\([\s\S]*?\)\s*;\s*update nodes/,
  );
});

test("record_trust_edge_change updates last_decay_at, decay_reason, trust_reason", () => {
  // All three columns get touched in the same UPDATE so the operator's
  // "what changed and when" view is consistent.
  assert.match(
    SQL,
    /update nodes\s+set\s+trust_weight\s*=\s*p_new_weight\s*,\s*trust_reason\s*=\s*p_reason\s*,\s*last_decay_at\s*=\s*now\(\)\s*,\s*decay_reason\s*=\s*p_reason/,
  );
});

// ---------------------------------------------------------------------------
// (6) is_quarantined — single-column read used by /swarm/lessons polling
// ---------------------------------------------------------------------------

test("is_quarantined returns FALSE for unknown or non-quarantined nodes", () => {
  // COALESCE pattern: SELECT returns NULL for unknown id, AND
  // (NULL > NOW()) is NULL — wrap in COALESCE(..., FALSE) so callers get
  // a definite boolean. Pin this because changing the default to TRUE
  // would silently quarantine every unknown peer (foot-gun: silent
  // denial of /swarm/lessons polling for fresh peers).
  assert.match(
    SQL,
    /create or replace function is_quarantined\s*\(\s*p_node_id\s+text\s*\)\s+returns boolean[\s\S]*?coalesce\s*\(\s*\(\s*select quarantined_until from nodes where node_id = p_node_id\s*\)\s*>\s*now\(\)\s*,\s*false\s*\)/,
  );
});

test("is_quarantined is STABLE (depends on now() but no writes)", () => {
  assert.match(
    SQL,
    /create or replace function is_quarantined[\s\S]*?language sql stable/,
  );
});

// ---------------------------------------------------------------------------
// (7) quarantine_origin — set §10.2 hold for K days
// ---------------------------------------------------------------------------

test("quarantine_origin rejects days <= 0", () => {
  assert.match(
    SQL,
    /raise exception 'quarantine_origin: days must be > 0, got %'/,
  );
});

test("quarantine_origin requires a non-empty reason", () => {
  assert.match(SQL, /raise exception 'quarantine_origin: reason is required'/);
});

test("quarantine_origin sets quarantined_until = NOW() + p_days days", () => {
  // Pin the interval-construction form — string concatenation is the
  // only portable way to build a parametrised INTERVAL in plpgsql, but
  // it's also a SQL-injection attractor. Cast to INT happens at call
  // sites; the parameter is typed INT here so concat is safe.
  assert.match(
    SQL,
    /quarantined_until\s*=\s*now\(\)\s*\+\s*\(\s*p_days\s*\|\|\s*' days'\s*\)::interval/,
  );
});

test("quarantine_origin resets consecutive_rejections to 0", () => {
  // The streak has been consumed by the quarantine. If the origin
  // re-offends after the hold expires, the count starts fresh. Without
  // this reset, the very next rejection (post-thaw) would fire another
  // quarantine — the origin would be permanently locked out by a single
  // late-arriving rejection.
  assert.match(SQL, /consecutive_rejections\s*=\s*0/);
});

test("quarantine_origin raises on unknown node_id", () => {
  assert.match(SQL, /raise exception 'quarantine_origin: unknown node_id %'/);
});

// ---------------------------------------------------------------------------
// (8) record_origin_rejection — encodes the §10.2 state machine
// ---------------------------------------------------------------------------

test("record_origin_rejection has defaults N=5, K=30 per SWARM_SPEC §10.2", () => {
  assert.match(
    SQL,
    /create or replace function record_origin_rejection\s*\(\s*p_node_id\s+text\s*,\s*p_rule_number\s+int\s*,\s*p_n_threshold\s+int\s+default\s+5\s*,\s*p_k_days\s+int\s+default\s+30\s*\)\s+returns boolean/,
  );
});

test("record_origin_rejection rejects rule_number outside [1, 20]", () => {
  // §5 has rules 1–20 in v1.1. A rule_number outside this range is a
  // caller bug; fail loud rather than silently increment the counter.
  assert.match(
    SQL,
    /raise exception 'record_origin_rejection: rule_number must be in \[1, 20\], got %'/,
  );
});

test("rule 19 is single-strike — immediate quarantine regardless of N", () => {
  // Per §10.2: chain rewriting is a definitionally adversarial act. The
  // single-strike branch must short-circuit BEFORE the cumulative
  // counter increments — pin the if-block placement.
  assert.match(
    SQL,
    /if p_rule_number = 19 then\s+perform quarantine_origin\s*\(\s*p_node_id\s*,\s*p_k_days\s*,\s*'single-strike: rule 19[^']*'\s*\)\s*;\s*return true\s*;\s*end if\s*;/,
  );
});

test("cumulative branch increments and quarantines at N", () => {
  // Pin the >= comparison (not >) so the very Nth rejection triggers
  // quarantine, not the (N+1)th. Off-by-one here would let the origin
  // get away with one extra rejection per cycle — exactly the kind of
  // drift §10.2 is meant to prevent.
  assert.match(
    SQL,
    /update nodes\s+set\s+consecutive_rejections\s*=\s*consecutive_rejections\s*\+\s*1\s+where\s+node_id\s*=\s*p_node_id\s+returning consecutive_rejections into v_new_count/,
  );
  assert.match(SQL, /if v_new_count\s*>=\s*p_n_threshold then/);
});

test("record_origin_rejection raises on unknown node_id", () => {
  assert.match(
    SQL,
    /raise exception 'record_origin_rejection: unknown node_id %'/,
  );
});

// ---------------------------------------------------------------------------
// (9) reset_origin_rejection_streak — break the §10.2 streak on clean ingest
// ---------------------------------------------------------------------------

test("reset_origin_rejection_streak only writes when the counter is > 0", () => {
  // Common path is a clean ingest from a peer with counter already 0;
  // the conditional WHERE avoids producing a needless WAL entry every
  // poll cycle. Pin it because without the AND-clause the function
  // becomes a hot-path UPDATE on every successful ingest.
  assert.match(
    SQL,
    /update nodes\s+set\s+consecutive_rejections\s*=\s*0\s+where\s+node_id\s*=\s*p_node_id\s+and\s+consecutive_rejections\s*>\s*0/,
  );
});

// ---------------------------------------------------------------------------
// (10) GRANT EXECUTE — every helper is callable by anon + service_role
// ---------------------------------------------------------------------------

test("record_trust_edge_change has GRANT EXECUTE", () => {
  assert.match(
    SQL,
    /grant execute on function record_trust_edge_change\s*\(\s*text\s*,\s*real\s*,\s*text\s*\)\s+to anon\s*,\s*service_role/,
  );
});

test("is_quarantined has GRANT EXECUTE", () => {
  assert.match(
    SQL,
    /grant execute on function is_quarantined\s*\(\s*text\s*\)\s+to anon\s*,\s*service_role/,
  );
});

test("quarantine_origin has GRANT EXECUTE", () => {
  assert.match(
    SQL,
    /grant execute on function quarantine_origin\s*\(\s*text\s*,\s*int\s*,\s*text\s*\)\s+to anon\s*,\s*service_role/,
  );
});

test("record_origin_rejection has GRANT EXECUTE", () => {
  assert.match(
    SQL,
    /grant execute on function record_origin_rejection\s*\(\s*text\s*,\s*int\s*,\s*int\s*,\s*int\s*\)\s+to anon\s*,\s*service_role/,
  );
});

test("reset_origin_rejection_streak has GRANT EXECUTE", () => {
  assert.match(
    SQL,
    /grant execute on function reset_origin_rejection_streak\s*\(\s*text\s*\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (11) No DROP / DELETE / TRUNCATE on existing data — substrate migration
// ---------------------------------------------------------------------------

test("migration 075 contains no DROP TABLE / DELETE / TRUNCATE", () => {
  // Substrate-only — same discipline as 070-074. The autonomy loop is
  // forbidden from running migrations; even so, a stray DROP would be a
  // foot-gun if Reed runs the migration on a populated DB.
  assert.doesNotMatch(SQL, /\bdrop table\b/);
  assert.doesNotMatch(SQL, /\bdelete from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
});
