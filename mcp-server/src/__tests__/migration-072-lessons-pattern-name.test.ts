import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 072 — lessons.pattern_name + record_lesson 6-arg signature pin
// (closes part of issue #95)
//
// Why this guard exists: extending record_lesson with an extra parameter is a
// foot-gun in PostgreSQL. CREATE OR REPLACE does NOT replace across different
// parameter counts — it creates an overload — so without an explicit DROP of
// the 5-arg version, every existing caller would silently keep hitting the
// old body and never write `pattern_name`. The migration depends on three
// brittle structural details that future edits could quietly weaken:
//
//   1. The `pattern_name` column actually gets added to `lessons`.
//   2. The 5-arg overload is explicitly dropped before the new function is
//      created. Removing the DROP turns the migration into a silent no-op.
//   3. The new 6-arg signature is GRANT-ed to anon/service_role. The DROP
//      removes the original GRANT from migration 015 along with the function;
//      forgetting to re-grant breaks every authenticated client.
//
// Same defensive pattern as migration-070-node-identity.test.ts and
// migration-071-swarm-storage.test.ts — read the SQL, normalise it,
// regex-pin the structural contract. The autonomy loop cannot execute
// migrations (Reed runs them by hand after merge), so contract tests live at
// the SQL-text level.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/072_lessons_pattern_name.sql",
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
// (1) lessons.pattern_name column + partial index
// ---------------------------------------------------------------------------

test("migration 072 adds `pattern_name` text column to lessons", () => {
  assert.match(
    SQL,
    /alter table lessons\s+add column if not exists pattern_name\s+text\b/,
  );
});

test("migration 072 creates a partial index on lessons.pattern_name", () => {
  // Partial WHERE clause: keeps the index small — most legacy lessons have
  // NULL pattern_name and lookups only ever filter on named clusters.
  assert.match(
    SQL,
    /create index if not exists lessons_pattern_name_idx\s+on lessons\s*\(\s*pattern_name\s*\)\s+where pattern_name is not null/,
  );
});

// ---------------------------------------------------------------------------
// (2) record_lesson — old 5-arg overload must be dropped before recreate
// ---------------------------------------------------------------------------

test("migration 072 explicitly drops the 5-arg record_lesson overload", () => {
  // Without this DROP, CREATE OR REPLACE creates a NEW overload instead of
  // replacing — every existing 5-arg caller would silently keep hitting the
  // old body and never write `pattern_name`.
  assert.match(
    SQL,
    /drop function if exists record_lesson\s*\(\s*text\s*,\s*vector\s*\(\s*768\s*\)\s*,\s*uuid\[\]\s*,\s*text\s*,\s*float\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) New 6-arg record_lesson signature
// ---------------------------------------------------------------------------

test("record_lesson is recreated with p_pattern_name as 6th parameter (DEFAULT NULL)", () => {
  // Param order matters — clients call by position via supabase-js rpc().
  // p_pattern_name MUST be last so existing 5-arg callers (services/
  // experiences.ts: recordLesson) keep working without code changes.
  assert.match(
    SQL,
    /create or replace function record_lesson\s*\(\s*p_lesson\s+text\s*,\s*p_embedding\s+vector\s*\(\s*768\s*\)\s*,\s*p_source_ids\s+uuid\[\]\s*,\s*p_category\s+text\s+default\s+'general'\s*,\s*p_confidence\s+float\s+default\s+0\.6\s*,\s*p_pattern_name\s+text\s+default\s+null\s*\)/,
  );
});

test("record_lesson body persists pattern_name into the lessons row", () => {
  // The INSERT column list must include pattern_name AND the values list
  // must reference p_pattern_name (NULLIF/trim normalisation is fine).
  // If either drift apart, the column exists but stays permanently NULL.
  // Anchored at "returning" because the VALUES clause has nested parens
  // (coalesce, nullif, trim, greatest) so a [^)]*-style bound would stop
  // at the first inner `)`.
  assert.match(
    SQL,
    /insert into lessons \([^)]*\bpattern_name\b[^)]*\) values \([\s\S]*?p_pattern_name[\s\S]*?returning id into new_id/,
  );
});

// ---------------------------------------------------------------------------
// (4) GRANT EXECUTE — DROP wiped the original GRANT from migration 015
// ---------------------------------------------------------------------------

test("migration 072 re-grants EXECUTE on the 6-arg record_lesson", () => {
  // DROP FUNCTION removed the GRANT issued by migration 015. Without this
  // re-grant, anon/service_role lose permission to call record_lesson and
  // every authenticated client breaks at runtime.
  assert.match(
    SQL,
    /grant execute on function record_lesson\s*\(\s*text\s*,\s*vector\s*\(\s*768\s*\)\s*,\s*uuid\[\]\s*,\s*text\s*,\s*float\s*,\s*text\s*\)\s+to anon\s*,\s*service_role/,
  );
});
