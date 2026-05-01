import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 084 — get_lesson_evidence position-quote fixup (issue #135)
//
// 077 declared `RETURNS TABLE (position INT, ...)` which PG16 rejects:
// `position` is a reserved keyword in the RETURNS TABLE parameter slot
// (built-in `position(string IN string)` function). 077 aborts at that
// line on a fresh PG16 install and `get_lesson_evidence` never gets
// created — leaving the §4.6 inclusion-proof endpoint with a missing
// dependency. 084 re-creates the function with the column quoted.
//
// Same shape-pin discipline as the 070-082 contract tests: the autonomy
// loop cannot execute migrations against a real PG16 instance, so the
// fix is pinned at the SQL-text level. Stripping comments before keyword
// matching prevents an explanatory phrase from satisfying a structural
// assertion.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/084_get_lesson_evidence_position_quote.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Preserve case for the quoted-identifier pin; lowercase for keyword pins.
const SQL_LC = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");
const SQL = SQL_NO_COMMENTS.replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) The fix itself: column name in RETURNS TABLE is double-quoted
// ---------------------------------------------------------------------------

test("RETURNS TABLE quotes the position column — works around PG16 reserved-word collision", () => {
  // The single load-bearing change: "position" in double quotes inside
  // the RETURNS TABLE parameter list. Without this PG16 raises a syntax
  // error at this exact spot.
  assert.match(
    SQL,
    /RETURNS TABLE \(\s*"position"\s+INT\s*,\s*hashed_experience_id\s+TEXT\s*\)/i,
  );
});

test("function uses CREATE OR REPLACE — idempotent fix-forward", () => {
  // The fix-forward discipline: re-running the migration on a DB that
  // already has the function (via hand-patch or a previous run of 084)
  // is a safe no-op. CREATE OR REPLACE FUNCTION is idempotent at the
  // SQL level; CREATE FUNCTION (without OR REPLACE) would error on
  // re-run.
  assert.match(
    SQL_LC,
    /create or replace function get_lesson_evidence\(\s*p_lesson_id\s+uuid\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) Function body and contract preserved from 077
// ---------------------------------------------------------------------------

test("function body returns ordered (position, hashed_experience_id) pairs by lesson_id", () => {
  // Body unchanged from 077: position and hashed_experience_id are
  // selected from lesson_evidence_origin, filtered by lesson_id, ordered
  // by position ASC. The §3.7.1 leaf-order contract is preserved. The
  // unqualified `position` inside the SELECT body is unambiguous (it
  // resolves to the column on lesson_evidence_origin); only the RETURNS
  // TABLE slot triggered the reserved-word collision.
  assert.match(
    SQL_LC,
    /select position, hashed_experience_id\s+from lesson_evidence_origin\s+where lesson_id = p_lesson_id\s+order by position asc/,
  );
});

test("function is LANGUAGE sql STABLE — same volatility class as 077 declared", () => {
  assert.match(SQL_LC, /language sql stable/);
});

// ---------------------------------------------------------------------------
// (3) Grants preserved — anon + service_role still receive EXECUTE
// ---------------------------------------------------------------------------

test("grant execute to anon and service_role is preserved", () => {
  // Without re-granting after CREATE OR REPLACE, an existing grant
  // survives a function redefinition — but pinning the GRANT here keeps
  // the migration self-contained, so a DB that never had 077 (e.g. a
  // restored-from-broken-state) still gets the grants this slot needs.
  assert.match(
    SQL_LC,
    /grant execute on function get_lesson_evidence\(uuid\) to anon, service_role/,
  );
});

// ---------------------------------------------------------------------------
// (4) PostgREST schema reload — endpoint sees the fixed RPC immediately
// ---------------------------------------------------------------------------

test("migration ends with NOTIFY pgrst, 'reload schema' so PostgREST picks up the fix without a restart", () => {
  // Same discipline as issue #134's grant fixup: the RPC is exposed via
  // PostgREST, and PostgREST caches its schema until told to reload.
  // Without NOTIFY, the §4.6 endpoint stays broken until the next
  // service restart.
  assert.match(SQL_LC, /notify pgrst, 'reload schema'/);
});

// ---------------------------------------------------------------------------
// (5) Migration discipline — fixup-only, no DROP/DELETE/TRUNCATE
// ---------------------------------------------------------------------------

test("migration is fixup-only: no DROP, DELETE, or TRUNCATE", () => {
  // 084 must not destroy any data. The 077 substrate (table, triggers,
  // record_lesson_evidence, any existing rows) is preserved as-is —
  // 084 only re-creates the read-side helper. A defensive DROP FUNCTION
  // would also be wrong because it would fail if the function never
  // got created (the actual fresh-PG16 case): CREATE OR REPLACE handles
  // both branches in one statement.
  assert.doesNotMatch(SQL_LC, /drop\s+table/);
  assert.doesNotMatch(SQL_LC, /drop\s+function/);
  assert.doesNotMatch(SQL_LC, /delete\s+from/);
  assert.doesNotMatch(SQL_LC, /truncate/);
  assert.doesNotMatch(SQL_LC, /alter\s+table/);
});
