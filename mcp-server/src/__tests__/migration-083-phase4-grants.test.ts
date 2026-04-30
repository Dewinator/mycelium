import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 083 — Phase 4 read-grant fixup (issue #134)
//
// Five of the Phase-4 swarm tables (nodes, swarm_lessons, trust_edge_log,
// lesson_evidence_origin, tier_promotion_log, lesson_diversity_log) ship
// without GRANT SELECT to anon / service_role, so PostgREST returns HTTP
// 403 on every read on a fresh install. 083 fixes that by adding the
// missing read grants in one place.
//
// Same defensive contract-pin pattern as the 070-082 tests: the autonomy
// loop cannot execute migrations against a real PG / PostgREST instance,
// so the fix is pinned at the SQL-text level. Stripping comments before
// keyword matching prevents an explanatory phrase from satisfying or
// violating a structural assertion below.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/083_phase4_grants.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace for keyword pins.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Every Phase-4 table the issue lists gets GRANT SELECT.
// ---------------------------------------------------------------------------

const TABLES = [
  "nodes",
  "swarm_lessons",
  "trust_edge_log",
  "lesson_evidence_origin",
  "tier_promotion_log",
  "swarm_lessons_broadcast_eligible",
  "swarm_lesson_contradictions",
  "lesson_diversity_log",
];

for (const table of TABLES) {
  test(`grants SELECT on ${table} to anon + service_role`, () => {
    // Pin the exact grant statement: SELECT only, both roles. The grant
    // pattern allows arbitrary whitespace between keywords but pins the
    // role list to anon + service_role (in either order — both are
    // equivalent at the SQL layer; matching the canonical "anon,
    // service_role" form documented in the issue).
    const pattern = new RegExp(
      `grant\\s+select\\s+on\\s+${table}\\s+to\\s+anon\\s*,\\s*service_role`,
    );
    assert.match(SQL, pattern);
  });
}

// ---------------------------------------------------------------------------
// (2) Read-only — no write privileges introduced by this migration.
// ---------------------------------------------------------------------------

test("migration 083 grants ONLY SELECT — no INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES", () => {
  // The issue's hard contract: "Write privileges stay locked — only
  // SELECT is granted; service-role still needs the existing trigger /
  // RPC / RLS path for any write." Pin the absence of every other DML
  // privilege keyword in any GRANT statement.
  assert.doesNotMatch(SQL, /grant[^;]*\binsert\b/);
  assert.doesNotMatch(SQL, /grant[^;]*\bupdate\b/);
  assert.doesNotMatch(SQL, /grant[^;]*\bdelete\b/);
  assert.doesNotMatch(SQL, /grant[^;]*\btruncate\b/);
  assert.doesNotMatch(SQL, /grant[^;]*\breferences\b/);
  assert.doesNotMatch(SQL, /grant[^;]*\btrigger\b/);
  // ALL would silently include INSERT/UPDATE/DELETE — pin its absence.
  assert.doesNotMatch(SQL, /grant\s+all\b/);
});

// ---------------------------------------------------------------------------
// (3) Additive only — no destructive DDL, matches 071 / 078 / 081 / 082.
// ---------------------------------------------------------------------------

test("migration 083 contains no DROP / DELETE / TRUNCATE / REVOKE statements", () => {
  // The autonomy loop must never authorise destructive migrations; the
  // grant fixup adds privilege, never removes any. A future REVOKE
  // would belong in a separately reviewed migration.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|view|function|constraint|trigger)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
  assert.doesNotMatch(SQL, /\brevoke\b/);
});

// ---------------------------------------------------------------------------
// (4) PostgREST hot-reload — pick up grants without a service restart.
// ---------------------------------------------------------------------------

test("migration 083 ends with NOTIFY pgrst, 'reload schema'", () => {
  // Without this, PostgREST keeps its cached schema until the next
  // service restart, so the grants apply at the SQL layer but reads
  // still 403 through the API. The trailing NOTIFY is what closes the
  // loop on existing deploys.
  assert.match(SQL, /notify\s+pgrst\s*,\s*'reload schema'/);
});

// ---------------------------------------------------------------------------
// (5) Idempotency — GRANT is idempotent in Postgres; pin that we don't
// guard with conditional logic that could mask a misspelled table name.
// ---------------------------------------------------------------------------

test("migration 083 issues plain GRANT statements — no DO / IF / EXISTS guards", () => {
  // GRANT is naturally idempotent: re-granting the same privilege is a
  // no-op. Wrapping a GRANT in DO $$ IF EXISTS ... END $$ would mask a
  // misspelled table name (the IF EXISTS would silently skip). Plain
  // GRANT statements fail loudly on the first apply if a table name is
  // wrong — exactly the behaviour we want at migration time.
  assert.doesNotMatch(SQL, /\bdo\s+\$\$/);
  assert.doesNotMatch(SQL, /\bgrant\b[^;]*\bif\s+exists\b/);
});
