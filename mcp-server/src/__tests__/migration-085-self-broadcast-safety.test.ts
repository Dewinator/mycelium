import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 085 — self-broadcast safety guard (PR #155 follow-up, issue #139)
//
// PR #155 (substrate for outbound /swarm/lessons feed handler) listed this
// as out-of-scope. The migration adds two triggers that converge on the
// invariant: a row whose id appears in lesson_chain (074) — definitionally a
// self-row — MUST carry origin_node_id equal to the local self identity.
//
// Three structural surfaces this test pins:
//
//   1. The shared helper self_broadcast_assert_origin(UUID, TEXT) raises
//      when (a) no is_self row exists, or (b) p_origin differs from the
//      local self id. Both directions must RAISE — silently returning on
//      either branch would gut the invariant.
//
//   2. lesson_chain BEFORE INSERT trigger uses the helper. Without it, a
//      chain insert that lands AFTER a swarm_lessons row with foreign
//      origin would never be checked.
//
//   3. swarm_lessons BEFORE INSERT OR UPDATE OF origin_node_id trigger
//      uses the helper, gated on lesson_chain existence so foreign-row
//      admission via /swarm/lessons (PR #154 substrate) still works.
//      The UPDATE OF clause is critical — a blanket BEFORE UPDATE would
//      fire on every signature_verified_at touch, multiplying overhead
//      on the receiver hot path.
//
// Contract-test pattern mirrors migration-070..082: the autonomy loop
// cannot execute migrations (Reed runs them by hand after merge), so we
// pin shape at the SQL-text level. Stripping comments before keyword
// matching prevents an explanatory phrase from satisfying a structural
// assertion below.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/085_self_broadcast_safety.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Shared assertion helper
// ---------------------------------------------------------------------------

test("self_broadcast_assert_origin helper exists with the (UUID, TEXT) signature", () => {
  // Both triggers funnel through this helper — pinning the signature
  // catches a refactor that drops the lesson_id arg (which would lose
  // the lesson context from the error message).
  assert.match(
    SQL,
    /create or replace function self_broadcast_assert_origin\(\s*p_lesson_id\s+uuid\s*,\s*p_origin\s+text\s*\)\s+returns void/,
  );
});

test("helper raises when no is_self row exists (identity-not-bootstrapped path)", () => {
  // Without this branch, a fresh DB before phase 1b would silently admit
  // chain inserts whose origin can't be resolved — defeating §3.7.2.
  assert.match(
    SQL,
    /raise exception\s+'self_broadcast_safety: no is_self row in nodes — node identity not bootstrapped/,
  );
});

test("helper raises when p_origin differs from local self (misattribution path)", () => {
  // The core invariant. IS DISTINCT FROM (not <>) handles the NULL-origin
  // edge case — a row with origin_node_id = NULL would slip past a plain
  // <> comparison since (NULL <> 'self') is NULL, not TRUE.
  assert.match(SQL, /if p_origin is distinct from v_self then/);
  assert.match(
    SQL,
    /raise exception\s+'self_broadcast_safety: lesson % carries origin_node_id=% but local self is %/,
  );
});

test("helper is STABLE (planner can hoist within a statement)", () => {
  // STABLE is the right volatility class: the function reads but does
  // not mutate. IMMUTABLE would be wrong (depends on table state);
  // VOLATILE would block any planner reuse on bulk inserts.
  assert.match(
    SQL,
    /create or replace function self_broadcast_assert_origin.+?\$\$\s+language plpgsql stable/,
  );
});

// ---------------------------------------------------------------------------
// (2) lesson_chain BEFORE INSERT trigger
// ---------------------------------------------------------------------------

test("lesson_chain_assert_self_origin trigger function returns TRIGGER", () => {
  assert.match(
    SQL,
    /create or replace function lesson_chain_assert_self_origin\(\)\s+returns trigger/,
  );
});

test("lesson_chain trigger looks up swarm_lessons.origin_node_id by NEW.lesson_id", () => {
  // Pin the SELECT — a refactor that swaps NEW.lesson_id for NEW.id
  // would silently miss every check (NEW.id doesn't exist on lesson_chain).
  assert.match(
    SQL,
    /select origin_node_id into v_origin\s+from swarm_lessons\s+where id = new\.lesson_id/,
  );
});

test("lesson_chain trigger raises when identity is unbootstrapped on the no-row path", () => {
  // The "swarm_lessons row not yet present" branch must still verify
  // identity bootstrap. Allowing a chain insert without ANY check would
  // create an unattributable chain entry that no later swarm_lessons
  // insert can repair.
  assert.match(
    SQL,
    /raise exception\s+'self_broadcast_safety: no is_self row in nodes — refusing lesson_chain insert for lesson %/,
  );
});

test("lesson_chain trigger calls the shared helper on the row-exists path", () => {
  // The cross-row check must funnel through the helper. A locally-inlined
  // re-implementation would drift from the swarm_lessons trigger over
  // time and the two would diverge on edge cases.
  assert.match(
    SQL,
    /perform self_broadcast_assert_origin\(new\.lesson_id, v_origin\)/,
  );
});

test("lesson_chain trigger fires BEFORE INSERT, not AFTER", () => {
  // BEFORE is load-bearing: AFTER would commit the chain row before
  // the check runs, requiring a transaction rollback to undo.
  assert.match(
    SQL,
    /drop trigger if exists lesson_chain_assert_self_origin_trg on lesson_chain/,
  );
  assert.match(
    SQL,
    /create trigger lesson_chain_assert_self_origin_trg\s+before insert on lesson_chain\s+for each row execute function lesson_chain_assert_self_origin\(\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) swarm_lessons BEFORE INSERT OR UPDATE OF origin_node_id trigger
// ---------------------------------------------------------------------------

test("swarm_lessons_assert_self_origin trigger function returns TRIGGER", () => {
  assert.match(
    SQL,
    /create or replace function swarm_lessons_assert_self_origin\(\)\s+returns trigger/,
  );
});

test("swarm_lessons trigger gates on lesson_chain existence (foreign-row passthrough)", () => {
  // Without this gate, every receiver-side admission of a foreign lesson
  // would fail — the entire /swarm/lessons inbound path (PR #154 substrate)
  // would be blocked. The EXISTS check is the firebreak.
  assert.match(
    SQL,
    /select exists \(\s*select 1 from lesson_chain where lesson_id = new\.id\s*\) into v_in_chain/,
  );
  assert.match(SQL, /if not v_in_chain then\s+return new;/);
});

test("swarm_lessons trigger calls the shared helper for self-rows", () => {
  assert.match(
    SQL,
    /perform self_broadcast_assert_origin\(new\.id, new\.origin_node_id\)/,
  );
});

test("swarm_lessons trigger fires only on origin_node_id changes (UPDATE OF clause)", () => {
  // A blanket BEFORE UPDATE would fire on every signature_verified_at
  // backfill and lesson_tier promotion in the receiver hot path. Narrowing
  // to UPDATE OF origin_node_id keeps the check tight without touching
  // unrelated column writes.
  assert.match(
    SQL,
    /drop trigger if exists swarm_lessons_assert_self_origin_trg on swarm_lessons/,
  );
  assert.match(
    SQL,
    /create trigger swarm_lessons_assert_self_origin_trg\s+before insert or update of origin_node_id on swarm_lessons\s+for each row execute function swarm_lessons_assert_self_origin\(\)/,
  );
});

// ---------------------------------------------------------------------------
// (4) Migration discipline — purely additive, no destructive ops
// ---------------------------------------------------------------------------

test("migration 085 does not DROP swarm_lessons, lesson_chain, or nodes", () => {
  // The follow-up is purely additive — two trigger functions, two triggers,
  // one shared helper. A silent DROP TABLE in a fresh-DB migration would
  // still apply cleanly but blow away production data on an upgrade run.
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?swarm_lessons\b/);
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?lesson_chain\b/);
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?nodes\b/);
});

test("migration 085 does not modify the swarm_lessons or lesson_chain column set", () => {
  // The §10.6 firebreak view (migration 078) and the §3.7.2 chain
  // structure (074) are downstream contracts. An ALTER TABLE in 085
  // would couple the safety guard to schema evolution — not the right
  // separation of concerns for a pure invariant trigger.
  assert.doesNotMatch(SQL, /alter table\s+swarm_lessons\s+(?:add|drop|alter|rename) column/);
  assert.doesNotMatch(SQL, /alter table\s+lesson_chain\s+(?:add|drop|alter|rename) column/);
});

test("migration 085 does not touch the swarm_lessons_broadcast_eligible firebreak view", () => {
  // The §10.6 view from migration 078 is the single source of truth for
  // broadcast eligibility. Re-defining it here would split the contract
  // across two migrations and invite drift on upgrade.
  assert.doesNotMatch(
    SQL,
    /create (?:or replace )?view\s+swarm_lessons_broadcast_eligible\b/,
  );
  assert.doesNotMatch(
    SQL,
    /drop view\s+(?:if exists\s+)?swarm_lessons_broadcast_eligible\b/,
  );
});

test("migration 085 does not re-grant lesson_chain or swarm_lessons", () => {
  // Triggers run in the privileges of the invoking role. A GRANT change
  // here would suggest a privilege coupling that this migration does not
  // create — pin the absence to make that explicit.
  assert.doesNotMatch(SQL, /grant\s+\w+\s+on\s+swarm_lessons\b/);
  assert.doesNotMatch(SQL, /grant\s+\w+\s+on\s+lesson_chain\b/);
});
