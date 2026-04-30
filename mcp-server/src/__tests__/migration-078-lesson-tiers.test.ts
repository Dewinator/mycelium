import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 078 — swarm lesson tiers contract pin (Swarm Phase 4i.1, #114)
//
// docs/SWARM_SPEC.md §10.6 promises a hard firebreak: a Tier-B lesson
// MUST NOT be re-broadcast on /swarm/lessons. The acceptance criterion in
// issue #114 spells out that this firebreak lives at the SQL layer, not in
// application code.  This test pins five contracts that any future edit
// MUST keep:
//
//   1. swarm_lessons.lesson_tier exists with TEXT + CHECK ('A','B') and
//      DEFAULT 'B' — the firebreak default for fresh inserts.
//   2. tier_promotion_log table exists with from_tier/to_tier checks AND a
//      table-level CHECK forbidding from_tier = to_tier (no-op spam guard).
//   3. swarm_lessons_broadcast_eligible view exists and filters
//      lesson_tier = 'A' — this is the only object the /swarm/lessons
//      handler is allowed to read from.
//   4. The migration is create-only (no DROP, no DELETE) — same hard rule
//      as migration 071, never permit silent destructive edits.
//   5. The audit log is structurally append-only: no UPDATE / DELETE GRANT
//      lines exist in the migration. Application code path enforces the
//      rest, but the SQL must not hand out the privilege.
//
// Same defensive pattern as migration-070-node-identity.test.ts and
// migration-071-swarm-storage.test.ts — read the SQL, normalise it, regex-
// pin the structural contract. We can't run the migration here; the
// autonomy loop is forbidden from executing migrations and Reed runs them
// by hand after merge.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/078_lesson_tiers.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so prose like
// "no DROP" inside a comment cannot accidentally satisfy or violate a
// structural assertion.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent
// or keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) swarm_lessons.lesson_tier — the firebreak column
// ---------------------------------------------------------------------------

test("swarm_lessons.lesson_tier exists with TEXT + DEFAULT 'B' + CHECK ('A','B')", () => {
  // The whole §10.6 firebreak depends on these three properties co-existing:
  //   - column type TEXT (matches the IN-CHECK convention used elsewhere)
  //   - DEFAULT 'B' (fresh inserts are never broadcast-eligible)
  //   - CHECK (lesson_tier IN ('A','B')) (no third tier sneaks in)
  // We pin all three in one assertion so a future edit can't drop the
  // DEFAULT while keeping the CHECK (or vice versa) and still pass.
  assert.match(
    SQL,
    /alter table swarm_lessons\s+add column if not exists lesson_tier\s+text\s+not null\s+default\s+'b'\s+check\s*\(\s*lesson_tier\s+in\s*\(\s*'a'\s*,\s*'b'\s*\)\s*\)/,
  );
});

test("swarm_lessons has a tier index for tier-filtered lookups", () => {
  // The broadcast view + the operator-side "show me Tier-B intake" view
  // both filter on lesson_tier. A plain btree on (lesson_tier) supports
  // both directions; a partial index on 'A' would only help broadcast.
  assert.match(
    SQL,
    /create index if not exists swarm_lessons_tier_idx\s+on swarm_lessons\s*\(\s*lesson_tier\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) tier_promotion_log — append-only audit
// ---------------------------------------------------------------------------

test("tier_promotion_log table exists with every required §10.6 column", () => {
  assert.match(SQL, /create table if not exists tier_promotion_log\b/);
  // BIGSERIAL primary key — append-only ordering by id matches the
  // append-only semantics of the spec.
  assert.match(SQL, /id\s+bigserial\s+primary key\b/);
  // FK to swarm_lessons(id) so a purged lesson cleans up its log; CASCADE
  // is the right choice because a forgotten lesson's log loses meaning.
  assert.match(
    SQL,
    /lesson_id\s+uuid\s+not null\s+references\s+swarm_lessons\s*\(\s*id\s*\)\s+on delete cascade/,
  );
  // from_tier / to_tier mirror the CHECK on the column they describe.
  assert.match(
    SQL,
    /from_tier\s+text\s+not null\s+check\s*\(\s*from_tier\s+in\s*\(\s*'a'\s*,\s*'b'\s*\)\s*\)/,
  );
  assert.match(
    SQL,
    /to_tier\s+text\s+not null\s+check\s*\(\s*to_tier\s+in\s*\(\s*'a'\s*,\s*'b'\s*\)\s*\)/,
  );
  // reason: bounded TEXT — same defense-in-depth pattern as the §5 size
  // caps in migration 071. 512 octets is plenty for a free-form audit
  // note without inviting a TEXT-storage abuse vector.
  assert.match(
    SQL,
    /reason\s+text\s+not null\s+check\s*\(\s*octet_length\s*\(\s*reason\s*\)\s*<=\s*512\s*\)/,
  );
  // evidence_ids: UUID[] (links to local experiences). DEFAULT '{}' so
  // INSERT can omit it for cases where the audit reason is sufficient
  // (e.g. operator-overrides), but the §10.5 promotion path MUST set it.
  assert.match(SQL, /evidence_ids\s+uuid\[\]\s+not null\s+default\s+'\{\}'/);
  assert.match(SQL, /at\s+timestamptz\s+not null\s+default\s+now\s*\(\s*\)/);
});

test("tier_promotion_log forbids no-op transitions (from_tier <> to_tier)", () => {
  // Without this CHECK an actor could spam the log with B->B "promotions"
  // and bury a real A->B falsification. The CHECK is a structural guard
  // against log noise; a real transition by definition has from <> to.
  assert.match(
    SQL,
    /check\s*\(\s*from_tier\s*<>\s*to_tier\s*\)/,
  );
});

test("tier_promotion_log has an index for per-lesson chronological lookup", () => {
  // The dominant query is "show me the audit trail for lesson X", ordered
  // by `at DESC`. (lesson_id, at DESC) is the matching composite index.
  assert.match(
    SQL,
    /create index if not exists tier_promotion_log_lesson_idx\s+on tier_promotion_log\s*\(\s*lesson_id\s*,\s*at\s+desc\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) swarm_lessons_broadcast_eligible — the SQL-layer firewall view
// ---------------------------------------------------------------------------

test("swarm_lessons_broadcast_eligible view exists and filters tier='A'", () => {
  // This view IS the firebreak. The /swarm/lessons HTTP handler reads
  // from this view, never from the raw table. The filter MUST be on
  // lesson_tier = 'A' (not <> 'B', not anything else) — equality is the
  // only safe predicate when a future Tier-C is added.
  assert.match(
    SQL,
    /create or replace view swarm_lessons_broadcast_eligible as\s+select\s+\*\s+from swarm_lessons\s+where lesson_tier\s*=\s*'a'/,
  );
});

test("swarm_lessons_broadcast_eligible grants SELECT to anon and service_role", () => {
  // Without GRANT SELECT, the existing /swarm/lessons callers (running
  // under the anon or service_role roles per the supabase-js client)
  // would get a permissions error. Mirrors the GRANT pattern in 073.
  assert.match(
    SQL,
    /grant select on swarm_lessons_broadcast_eligible to anon, service_role\b/,
  );
});

// ---------------------------------------------------------------------------
// (4) Hard-rule guards — same as migration 071
// ---------------------------------------------------------------------------

test("migration is create-only (no DROP / DELETE statements)", () => {
  // Same rule as migration 071 / 074 / 075. Append-only, additive schema
  // changes only. A stray DROP or DELETE here would either pre-empt later
  // schema work, wipe the broadcast firewall, or destroy an audit trail.
  // Comments are stripped above so prose like "no DROP" cannot trigger.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|column|constraint|view|schema|function)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
});

test("migration does not grant UPDATE or DELETE on tier_promotion_log", () => {
  // Append-only is enforced at the privilege layer: anon and service_role
  // get only the implicit INSERT + SELECT they inherit from migration 071's
  // table-level grants on swarm_lessons. Re-issuing UPDATE or DELETE here
  // would silently break the §10.6 append-only contract. The negative
  // assertion catches a future edit that adds the wrong grant.
  assert.doesNotMatch(SQL, /grant\s+(update|delete)[^;]*tier_promotion_log/);
  assert.doesNotMatch(SQL, /grant\s+all[^;]*tier_promotion_log/);
});

test("migration references docs/SWARM_SPEC.md §10.6 in a COMMENT", () => {
  // Drift between SQL and spec is the failure mode this catches. At least
  // one COMMENT clause must point a future reader at the spec section.
  assert.match(SQL, /comment on (column|table|view)[^;]+\$\$|comment on (column|table|view)[^;]+'/);
  // The §10.6 reference appears in raw (un-lowercased) SQL — search there.
  assert.match(SQL_RAW, /§10\.6/);
});
