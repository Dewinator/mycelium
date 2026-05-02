import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MIN_LOCAL_WEIGHT_FOR_BROADCAST } from "../swarm/endpoints/lesson-feed.js";

// ---------------------------------------------------------------------------
// Migration 087 — broadcast view §10.4 diversity filter (issue #139 closure)
//
// Closes the last open acceptance line of issue #139:
//   "Diversity-dampened lessons (local_weight < 0.3) are excluded."
//
// Contract tests pin three things any future edit MUST keep:
//   1. The view is re-created via CREATE OR REPLACE (so existing GRANTs
//      from migration 078 carry through).
//   2. The WHERE clause requires BOTH lesson_tier='A' AND local_weight>=0.3.
//      Either filter alone is a regression — the §10.6 firebreak (Tier-B
//      stays local) and the §10.4 firebreak (over-concentrated stays local)
//      both depend on this combined predicate.
//   3. Migration is create-only (no DROP / DELETE) — same hard rule as
//      every Phase 4 substrate migration since 070. The substrate may be
//      re-tightened, never weakened by demolishing existing structure.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/087_broadcast_diversity_filter.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so prose like
// "no DROP" inside a comment cannot accidentally satisfy or violate a
// structural assertion.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Combined firebreak — view tightened with both filters
// ---------------------------------------------------------------------------

test("swarm_lessons_broadcast_eligible is re-created via CREATE OR REPLACE VIEW", () => {
  // CREATE OR REPLACE preserves the GRANT SELECT to anon + service_role
  // that migration 078 already issued. Dropping and recreating would
  // silently strip those grants — a future PostgREST query would 401 and
  // an operator would have to rediscover the missing GRANT. Pin the form.
  assert.match(SQL, /create or replace view swarm_lessons_broadcast_eligible\s+as\b/);
});

test("view requires BOTH lesson_tier='A' AND local_weight>=0.3", () => {
  // The §10.6 firebreak (Tier-B stays local) and the §10.4 firebreak
  // (over-concentrated stays local) both depend on this combined predicate.
  // Either alone is a regression. Pin a single regex so the two clauses
  // cannot drift apart between PRs (e.g. someone splitting the WHERE into
  // two views and forgetting to keep them in sync).
  assert.match(
    SQL,
    /select\s+\*\s+from swarm_lessons\s+where lesson_tier\s*=\s*'a'\s+and local_weight\s*>=\s*0\.3/,
  );
});

test("view threshold matches the lesson-feed handler constant", () => {
  // The handler in mcp-server/src/swarm/endpoints/lesson-feed.ts exports
  // MIN_LOCAL_WEIGHT_FOR_BROADCAST as the documented threshold. The
  // substrate now enforces the same threshold; importing the TS constant
  // and asserting both shape + cross-file agreement catches a future
  // edit that touches one file but forgets the other.
  assert.equal(MIN_LOCAL_WEIGHT_FOR_BROADCAST, 0.3);
  const literal = MIN_LOCAL_WEIGHT_FOR_BROADCAST.toString(); // "0.3"
  // The SQL literal must equal the TS constant verbatim (byte-equal at
  // the digit level — Postgres NUMERIC parsing is loose, but `0.30` would
  // pass while drifting the documented threshold). Anchor on \b so a
  // future "0.30" or "0.31" trips the assertion.
  const re = new RegExp(`local_weight\\s*>=\\s*${literal.replace(".", "\\.")}\\b`);
  assert.match(SQL, re);
});

// ---------------------------------------------------------------------------
// (2) Documentation invariants — comment carries the spec reference
// ---------------------------------------------------------------------------

test("view comment references both §10.6 and §10.4", () => {
  // Drift between SQL and spec is the failure mode the comment defends
  // against. Pin both spec section markers in the raw (un-lowercased)
  // SQL so a future edit cannot weaken the comment to e.g. only §10.6.
  assert.match(SQL_RAW, /§10\.6/);
  assert.match(SQL_RAW, /§10\.4/);
});

test("migration includes a COMMENT ON VIEW clause", () => {
  // The COMMENT is what an operator running `\d+` sees; without it the
  // view shows as "swarm_lessons_broadcast_eligible" with no spec hook.
  assert.match(SQL, /comment on view swarm_lessons_broadcast_eligible is/);
});

// ---------------------------------------------------------------------------
// (3) Hard-rule guards — same discipline as 070..086
// ---------------------------------------------------------------------------

test("migration is create-only (no DROP / DELETE statements)", () => {
  // Phase 4 migrations are append-only by hard rule. A stray DROP VIEW
  // here would strip the existing grants from migration 078, breaking
  // every /swarm/lessons caller until a follow-up restored them.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|column|constraint|view|schema|function)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
});

test("migration does not weaken any GRANT", () => {
  // Belt-and-braces: a REVOKE on the view would strip the inherited
  // grants from migration 078. Catch that class of edit at SQL-text
  // time.
  assert.doesNotMatch(SQL, /\brevoke\b/);
});
