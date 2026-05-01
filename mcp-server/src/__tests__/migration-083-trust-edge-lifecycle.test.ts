import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 083 — §10 lifecycle sweeps (issue #141)
//
// Same defensive contract-pin pattern as migration-070..082 tests: read the
// SQL, normalise it, regex-pin every load-bearing structural invariant.
// Reed runs migrations manually after merge — the autonomy loop is forbidden
// from executing them — so the contract tests live at the SQL-text level.
//
// Pins two groups of contracts that any future edit MUST keep:
//   1. trust_edge_decay_step(p_silence_days, p_step, p_min_gap_hours)
//      — three-arg signature, neutral-deadband no-op, calls
//        record_trust_edge_change with the canonical reason string,
//        guards on is_self / last_seen_at / last_decay_at cooldown,
//        GRANTed to anon + service_role.
//   2. quarantine_release_step()
//      — zero-arg signature, INSERTs into trust_edge_log with reason
//        'quarantine-expired' (direct INSERT bypasses the no-op short-
//        circuit in record_trust_edge_change), clears quarantined_until
//        + consecutive_rejections, GRANTed to anon + service_role.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/083_trust_edge_lifecycle.sql",
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
// (1) trust_edge_decay_step — silence decay toward neutral
// ---------------------------------------------------------------------------

test("trust_edge_decay_step has the canonical 3-arg signature with documented defaults", () => {
  // Signature pin: (silence_days INT default 7, step REAL default 0.05,
  // min_gap_hours INT default 24). Renaming a param or changing a default
  // would silently change the §10.1 cadence — pin all three.
  assert.match(
    SQL,
    /create or replace function trust_edge_decay_step\(\s*p_silence_days\s+int\s+default\s+7\s*,\s*p_step\s+real\s+default\s+0\.05\s*,\s*p_min_gap_hours\s+int\s+default\s+24\s*\)\s+returns\s+int/,
  );
});

test("trust_edge_decay_step rejects out-of-range parameter values", () => {
  // Defensive validation. silence_days >= 1 prevents "decay every peer
  // every tick"; step in (0, 0.5] prevents trust collapse / negative steps;
  // min_gap_hours >= 1 prevents the per-peer cooldown from going subzero.
  assert.match(SQL, /silence_days must be >= 1/);
  assert.match(SQL, /step must be in \(0, 0\.5\]/);
  assert.match(SQL, /min_gap_hours must be >= 1/);
});

test("trust_edge_decay_step skips self and applies the cooldown gate", () => {
  // Two contracts that protect against runaway behaviour:
  //   * is_self = TRUE rows are explicitly excluded (we never decay our
  //     own trust toward neutral; self trust is operator-set).
  //   * last_decay_at cooldown gate prevents a fast scheduler from
  //     hammering the same peer N times per cycle. A future refactor that
  //     drops the COALESCE-NULL allowance would silently freeze every
  //     peer that hasn't decayed yet — pin both halves.
  assert.match(SQL, /coalesce\(is_self,\s*false\) = false/);
  assert.match(SQL, /last_seen_at is not null/);
  assert.match(SQL, /last_seen_at < now\(\) - \(p_silence_days \|\| ' days'\)::interval/);
  assert.match(SQL, /last_decay_at is null\s+or\s+last_decay_at < now\(\) - \(p_min_gap_hours \|\| ' hours'\)::interval/);
});

test("trust_edge_decay_step has a neutral deadband around 0.5", () => {
  // The 0.495..0.505 deadband prevents oscillation: without it, a peer at
  // 0.504 would be dragged to 0.454 by the > branch, then bounced back to
  // 0.504 by the < branch on the next tick. The deadband collapses both
  // branches to the no-op exit. Pin both the range and the explicit
  // 'silence-decay-neutral-deadband' reason — the dashboard reads
  // decay_reason and a renamed reason would silently break the UI.
  assert.match(SQL, /v_row\.trust_weight between 0\.495 and 0\.505/);
  assert.match(SQL, /'silence-decay-neutral-deadband'/);
});

test("trust_edge_decay_step clamps both decay branches at 0.5", () => {
  // GREATEST(0.5, w-step) on the > branch and LEAST(0.5, w+step) on the
  // < branch. Without the clamps a peer at 0.51 dragged by step=0.05
  // would land at 0.46, crossing the neutral mid-line — defeating the
  // "drift toward 0.5" intent and creating a sign-flip the audit log
  // can't easily explain.
  assert.match(SQL, /v_new := greatest\(0\.5::real, v_row\.trust_weight - p_step\)/);
  assert.match(SQL, /v_new := least\(0\.5::real, v_row\.trust_weight \+ p_step\)/);
});

test("trust_edge_decay_step routes through record_trust_edge_change with the canonical reason", () => {
  // Persistence MUST go through migration 075's record_trust_edge_change
  // so the audit row + last_decay_at stamp + no-op short-circuit all
  // happen in one transaction. A direct UPDATE on nodes.trust_weight
  // here would skip the audit log — that's exactly the foot-gun §10.1
  // forbids ("operator audit surface"). The reason string is also pinned
  // because the dashboard groups decay events by reason text.
  assert.match(
    SQL,
    /perform record_trust_edge_change\(\s*v_row\.node_id\s*,\s*v_new\s*,\s*'silence-decay-toward-neutral'\s*\)/,
  );
});

test("trust_edge_decay_step is GRANTed to anon and service_role", () => {
  assert.match(
    SQL,
    /grant execute on function trust_edge_decay_step\(int,\s*real,\s*int\)\s+to anon,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (2) quarantine_release_step — §10.2 expiry-based release
// ---------------------------------------------------------------------------

test("quarantine_release_step has the canonical zero-arg signature", () => {
  // Zero args — the function selects only rows where quarantined_until is
  // already in the past, so the operator never has to pass a "now" or
  // "lookback window". Adding parameters later is a compatible change;
  // adding REQUIRED parameters is a contract break.
  assert.match(
    SQL,
    /create or replace function quarantine_release_step\(\s*\)\s+returns\s+int/,
  );
});

test("quarantine_release_step selects only expired quarantines", () => {
  // The WHERE clause is the entire safety surface of this function:
  // selecting too widely would release peers who are actively quarantined,
  // and selecting too narrowly would leave released peers stuck with
  // stale quarantined_until values forever. Pin both halves.
  assert.match(SQL, /quarantined_until is not null/);
  assert.match(SQL, /quarantined_until < now\(\)/);
});

test("quarantine_release_step writes a release audit row directly into trust_edge_log", () => {
  // Direct INSERT (not via record_trust_edge_change) is intentional:
  // weight_before == weight_after on a release would trigger
  // record_trust_edge_change's no-op short-circuit and silently drop the
  // audit row. Migration 075's append-only trigger only blocks UPDATE +
  // DELETE, so a bare INSERT is a legal append.
  assert.match(
    SQL,
    /insert into trust_edge_log \(node_id,\s*weight_before,\s*weight_after,\s*reason\)\s+values \(v_row\.node_id,\s*v_row\.trust_weight,\s*v_row\.trust_weight,\s*'quarantine-expired'\)/,
  );
});

test("quarantine_release_step clears the §10.2 state-machine fields", () => {
  // The release MUST clear quarantined_until + reset consecutive_rejections.
  // Without the rejections reset, a peer that comes back online after a
  // 30-day quarantine starts already 5/5 rejections deep — the next §5
  // rule failure would re-quarantine immediately. last_decay_at gets
  // stamped so the operator UI shows a real "last lifecycle event".
  assert.match(SQL, /quarantined_until\s*=\s*null/);
  assert.match(SQL, /consecutive_rejections\s*=\s*0/);
  assert.match(SQL, /decay_reason\s*=\s*'quarantine-expired'/);
  assert.match(SQL, /last_decay_at\s*=\s*now\(\)/);
});

test("quarantine_release_step is GRANTed to anon and service_role", () => {
  assert.match(
    SQL,
    /grant execute on function quarantine_release_step\(\)\s+to anon,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (3) Migration discipline (mirrors 070..082 tests)
// ---------------------------------------------------------------------------

test("migration is purely additive — no DROP / DELETE / TRUNCATE", () => {
  // §10.1 audit log integrity AND §10.2 state-machine integrity both
  // depend on the migration NEVER tearing down existing structure. A
  // future edit that adds a DROP TABLE / DELETE FROM / TRUNCATE here
  // would be a silent contract break — pin the absence at the SQL-text
  // level so the agent loop catches it before the migration ships.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|function|index|trigger|view)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
});

test("migration uses CREATE OR REPLACE for both functions (re-run safe)", () => {
  // Reed re-runs migrate.sh on every merge — both functions must support
  // re-creation without errors. CREATE OR REPLACE is the established
  // pattern (see 075's compute_trust_weight, record_trust_edge_change,
  // quarantine_origin, record_origin_rejection, reset_origin_rejection_streak).
  const replaceCount = (SQL.match(/create or replace function/g) ?? []).length;
  assert.equal(replaceCount, 2, "expected exactly two CREATE OR REPLACE FUNCTION blocks");
});
