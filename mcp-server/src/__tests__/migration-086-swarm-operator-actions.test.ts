import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 086 — Swarm operator-action substrate (issue #142 backend slice)
//
// The dashboard's POST handlers (handleSwarmContradictResolve,
// handleSwarmPeerTrustOverride, handleSwarmLessonPin) depend on three
// on-disk contracts that this test pins:
//
//   1. swarm_lesson_contradictions has resolved_at + resolution_decision
//      columns. The §10.3 "operator decision" branch can't move a pair
//      out of the active list without these — and a future edit that
//      drops or renames either column would silently turn the active-
//      list view into a no-op.
//   2. The active-list view exists and reads `resolved_at IS NULL`.
//      A view definition that omits this filter would re-expose every
//      historical contradiction pair to the operator UI.
//   3. The two operator RPCs exist with the expected signatures and
//      whitelist their decision parameter to {'a','b','park'}. A widening
//      to accept arbitrary strings would let the UI write rows that the
//      column-level CHECK then rejects — confusing UX, hidden bug.
//
// We can't run the migration here (the autonomy loop is forbidden from
// executing migrations, Reed runs them by hand after merge), but we CAN
// regex-pin the structural contract so a future edit can never silently
// weaken any of the three.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/086_swarm_operator_actions.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so a phrase like
// "no DROP" inside a comment cannot satisfy or violate a structural
// assertion.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent
// or keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) swarm_lesson_contradictions adds the two operator-resolution columns
// ---------------------------------------------------------------------------

test("migration 086 adds resolved_at and resolution_decision columns", () => {
  assert.match(
    SQL,
    /alter table swarm_lesson_contradictions\s+add column if not exists resolved_at timestamptz/,
  );
  assert.match(
    SQL,
    /alter table swarm_lesson_contradictions\s+add column if not exists resolution_decision text/,
  );
});

test("resolution_decision is whitelisted to a / b / park", () => {
  // Operator UI can produce only these three outcomes; widening the
  // whitelist requires also extending the dashboard handler validator
  // and the operator_resolve_contradict RPC body.
  assert.match(
    SQL,
    /resolution_decision is null\s+or resolution_decision in\s*\(\s*'a'\s*,\s*'b'\s*,\s*'park'\s*\)/,
  );
});

test("resolved_at and resolution_decision must travel together", () => {
  // Either both NULL (still active) or both set (resolved with a known
  // outcome). Splitting them would let a partial write produce a row in
  // the resolved set with no decision, which the UI can't display.
  assert.match(
    SQL,
    /resolved_at is null and resolution_decision is null.*or.*resolved_at is not null and resolution_decision is not null/,
  );
});

test("partial index speeds up the active-list scan", () => {
  // The dashboard re-reads the active list on every operator action.
  // Without a partial index on resolved_at IS NULL the scan walks the
  // full historical contradictions table once it grows past a few rows.
  assert.match(
    SQL,
    /create index if not exists swarm_lesson_contradictions_active_idx[\s\S]*?where resolved_at is null/,
  );
});

// ---------------------------------------------------------------------------
// (2) swarm_lesson_contradictions_active view filters on resolved_at IS NULL
// ---------------------------------------------------------------------------

test("active-pairs view exists and filters on resolved_at IS NULL", () => {
  assert.match(
    SQL,
    /create or replace view swarm_lesson_contradictions_active as\s+select \*\s+from swarm_lesson_contradictions\s+where resolved_at is null/,
  );
});

test("active-pairs view is granted SELECT to anon and service_role", () => {
  // The dashboard reads through anon (no service-role JWT in the
  // browser), so dropping the anon grant would break the operator UI.
  assert.match(
    SQL,
    /grant select on swarm_lesson_contradictions_active to anon, service_role/,
  );
});

// ---------------------------------------------------------------------------
// (3) operator_resolve_contradict RPC — atomic resolve + audit
// ---------------------------------------------------------------------------

test("operator_resolve_contradict signature pins (UUID, TEXT) -> JSONB", () => {
  assert.match(
    SQL,
    /create or replace function operator_resolve_contradict\(\s*p_pair_id\s+uuid\s*,\s*p_decision\s+text\s*\)\s+returns jsonb/,
  );
});

test("operator_resolve_contradict rejects decisions outside a/b/park", () => {
  // A widening here would accept arbitrary input that the column-level
  // CHECK then rejects — confusing UX, the dashboard would show
  // "rpc returned 200" but nothing actually happened.
  assert.match(
    SQL,
    /if p_decision not in\s*\(\s*'a'\s*,\s*'b'\s*,\s*'park'\s*\)/,
  );
});

test("operator_resolve_contradict refuses to double-resolve", () => {
  // The active-list filter is the operator's safety surface — it MUST
  // be impossible to re-resolve a row that was already resolved (which
  // would write a second tier_promotion_log row for the same lesson).
  assert.match(SQL, /if v_pair\.resolved_at is not null then\s+raise exception/);
});

test("operator_resolve_contradict writes a tier_promotion_log row only when tier actually changes", () => {
  // §10.6 audit rule: every B->A transition writes a log row. But if the
  // kept lesson was already 'A' (e.g. promoted by §10.5 between detection
  // and resolution), writing another row would be a no-op log spam.
  // The kept_id selection inside the IF block guards against that.
  assert.match(
    SQL,
    /if\s*\(\s*select lesson_tier from swarm_lessons where id\s*=\s*v_keep_id\s*\)\s*=\s*'b'\s*then[\s\S]*?insert into tier_promotion_log/,
  );
});

test("operator_resolve_contradict deletes the losing lesson on a/b decisions", () => {
  // FK ON DELETE CASCADE on swarm_lesson_contradictions(b_id) handles the
  // edge cleanup; we just need the explicit delete on the lesson row.
  assert.match(SQL, /delete from swarm_lessons where id\s*=\s*v_drop_id/);
});

test("operator_resolve_contradict park branch keeps both lessons", () => {
  // Park = "both stay at Tier-B until more evidence arrives." No DELETE,
  // no tier change, no tier_promotion_log row — only the resolved_at
  // stamp moves the pair out of the active view.
  assert.match(
    SQL,
    /if p_decision = 'park' then[\s\S]*?update swarm_lesson_contradictions[\s\S]*?set resolved_at[\s\S]*?resolution_decision = 'park'/,
  );
});

test("operator_resolve_contradict is granted EXECUTE to anon and service_role", () => {
  // Dashboard handler runs through the service_role JWT; anon grant is
  // included for parity with the rest of the swarm RPC surface.
  assert.match(
    SQL,
    /grant execute on function operator_resolve_contradict\(uuid, text\)\s+to anon, service_role/,
  );
});

// ---------------------------------------------------------------------------
// (4) operator_pin_swarm_lesson RPC — manual Tier-B → Tier-A override
// ---------------------------------------------------------------------------

test("operator_pin_swarm_lesson signature pins (UUID) -> JSONB", () => {
  assert.match(
    SQL,
    /create or replace function operator_pin_swarm_lesson\(\s*p_lesson_id\s+uuid\s*\)\s+returns jsonb/,
  );
});

test("operator_pin_swarm_lesson is idempotent on already-Tier-A lessons", () => {
  // The dashboard may double-fire the pin button (network retry, double
  // click). The idempotent branch returns ok=true with noop=true so the
  // UI doesn't show an error for a benign repeat.
  assert.match(SQL, /if v_prior_tier = 'a' then\s+return jsonb_build_object/);
});

test("operator_pin_swarm_lesson logs the override with reason 'operator-pinned'", () => {
  // A future audit query can split automated promotions (rem-* reasons)
  // from manual overrides with a simple LIKE filter — only if the
  // reason string is stable.
  assert.match(
    SQL,
    /insert into tier_promotion_log[\s\S]*?'operator-pinned'/,
  );
});

test("operator_pin_swarm_lesson is granted EXECUTE to anon and service_role", () => {
  assert.match(
    SQL,
    /grant execute on function operator_pin_swarm_lesson\(uuid\)\s+to anon, service_role/,
  );
});

// ---------------------------------------------------------------------------
// (5) Scope-discipline assertions — no destructive ops on existing tables
// ---------------------------------------------------------------------------

test("migration 086 contains no DROP / DELETE / REVOKE on existing tables", () => {
  // Mirrors 075/078/080 discipline: this migration extends, never
  // rewrites. A DROP or REVOKE here would suggest schema drift that
  // belongs in a separate migration with its own review.
  assert.doesNotMatch(SQL, /drop\s+(table|column|view|function|index|constraint)/);
  assert.doesNotMatch(SQL, /\brevoke\b/);
});
