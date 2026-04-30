import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 074 — lesson_chain (closes #104, sub-phase 4d)
//
// The chain is the substrate §5 rule 19 (broken commitment chain) leans
// on. Without these structural pins the table can silently regress into
// shapes that *look* like a chain but no longer enforce one:
//
//   1. The append-only invariant has to be SQL-side, not application-trust.
//      A producer flow that's "carefully not running UPDATE" is one fat
//      finger away from rewriting history. Trigger-enforced is the floor.
//   2. The prev_lesson_hash IS NULL ↔ sequence_number = 0 biconditional
//      is what stops a producer from accidentally publishing lesson #2
//      with prev=null (silent fork). A loose CHECK (only one direction)
//      would let one of the two anomalies slip past.
//   3. UNIQUE (sequence_number) protects the chain from a parallel
//      double-insert during the read-build-sign-insert producer flow.
//
// Contract-test pattern mirrors migration-070..073: the autonomy loop
// cannot execute migrations (Reed runs them by hand after merge), so
// we pin shape at the SQL-text level. Stripping comments before keyword
// matching prevents an explanatory phrase like "no DROP" from satisfying
// a structural assertion below.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/074_lesson_chain.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) Table shape — every column the issue scope pins
// ---------------------------------------------------------------------------

test("lesson_chain table is created with the documented column set", () => {
  // The issue body fixes the column list verbatim — pinning the CREATE
  // TABLE here means a refactor that drops or renames any column trips
  // the test BEFORE it reaches a fresh-DB run that would silently
  // regress the chain semantics.
  assert.match(SQL, /create table if not exists lesson_chain\b/);
  assert.match(SQL, /lesson_id\s+uuid\s+primary key/);
  assert.match(SQL, /signed_at\s+timestamptz\s+not null/);
  assert.match(SQL, /lesson_hash\s+text\s+not null\s+unique/);
  assert.match(SQL, /prev_lesson_hash\s+text\b/);
  assert.match(SQL, /sequence_number\s+int\s+not null/);
  assert.match(SQL, /created_at\s+timestamptz\s+not null\s+default now\(\)/);
});

test("sequence_number is non-negative", () => {
  // CHECK (sequence_number >= 0) — without it, a buggy COALESCE could
  // emit a negative seed and the UNIQUE constraint would happily accept
  // it, breaking compute_next_sequence_number's monotone contract.
  assert.match(SQL, /check\s*\(\s*sequence_number\s*>=\s*0\s*\)/);
});

test("prev_lesson_hash IS NULL iff sequence_number = 0 (biconditional CHECK)", () => {
  // §3.7.2: the very first lesson a node publishes has prev_lesson_hash
  // = null; every subsequent lesson MUST chain. Encoding the
  // biconditional as a database CHECK turns the "first-lesson" semantics
  // into an invariant — producer-side bugs that would otherwise quietly
  // fork the chain (lesson #2 with prev=null, or lesson #1 with a
  // non-null prev) are rejected at INSERT time.
  assert.match(
    SQL,
    /check\s*\(\s*\(\s*sequence_number\s*=\s*0\s*\)\s*=\s*\(\s*prev_lesson_hash\s+is\s+null\s*\)\s*\)/,
  );
});

test("sequence_number is UNIQUE (parallel-double-insert protection)", () => {
  // The producer flow is read-build-sign-insert. Two flows racing on
  // step 1 will compute the same `next` value, sign two distinct
  // lessons against the same prev_hash, then both INSERT. UNIQUE
  // (sequence_number) makes the second INSERT fail loudly instead of
  // forking the chain.
  assert.match(SQL, /unique\s*\(\s*sequence_number\s*\)/);
});

test("lesson_chain has the signed_at index for replay-by-time", () => {
  // §3.7.2: receivers MAY reconstruct a producer's chain by ORDER BY
  // signed_at ASC. The producer's own table benefits from the same
  // index for any local ops tooling.
  assert.match(
    SQL,
    /create index if not exists lesson_chain_signed_at_idx\s+on lesson_chain\s*\(\s*signed_at\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (2) Append-only enforcement — UPDATE and DELETE both raise
// ---------------------------------------------------------------------------

test("append-only trigger function raises on any mutation", () => {
  // Defense in depth: even an operator with table-owner privileges
  // shouldn't be able to silently rewrite chain history. A trigger that
  // RAISES applies to every role that doesn't bypass triggers (none
  // should — the autonomy loop runs as service_role, which honors
  // triggers).
  assert.match(
    SQL,
    /create or replace function lesson_chain_no_mutate\(\)\s+returns trigger/,
  );
  assert.match(SQL, /raise exception\s+'lesson_chain is append-only/);
});

test("UPDATE on lesson_chain is blocked by trigger", () => {
  // The trigger has to be BEFORE UPDATE so the no-op AFTER variant
  // can't accidentally let the row through with a different value.
  assert.match(SQL, /drop trigger if exists lesson_chain_no_update on lesson_chain/);
  assert.match(
    SQL,
    /create trigger lesson_chain_no_update\s+before update on lesson_chain\s+for each row execute function lesson_chain_no_mutate\(\)/,
  );
});

test("DELETE on lesson_chain is blocked by trigger", () => {
  // Same shape as UPDATE — without DELETE protection the chain can be
  // rewritten by deleting + re-inserting the tip with a fresh hash.
  assert.match(SQL, /drop trigger if exists lesson_chain_no_delete on lesson_chain/);
  assert.match(
    SQL,
    /create trigger lesson_chain_no_delete\s+before delete on lesson_chain\s+for each row execute function lesson_chain_no_mutate\(\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) Producer-side read RPCs
// ---------------------------------------------------------------------------

test("compute_next_prev_lesson_hash returns the chain tip (or NULL)", () => {
  // Pin the body — a refactor that swaps ORDER BY sequence_number for
  // ORDER BY signed_at would silently break the chain on backdated
  // signed_at clocks. sequence_number is the load-bearing ordering.
  assert.match(
    SQL,
    /create or replace function compute_next_prev_lesson_hash\(\)\s+returns text/,
  );
  assert.match(
    SQL,
    /select lesson_hash\s+from lesson_chain\s+order by sequence_number desc\s+limit 1/,
  );
});

test("compute_next_prev_lesson_hash is GRANTed to anon + service_role", () => {
  // Same GRANT discipline as migrations 070-073: without an explicit
  // GRANT every authenticated client (including the autonomy loop)
  // breaks at runtime when it tries to call the RPC.
  assert.match(
    SQL,
    /grant execute on function compute_next_prev_lesson_hash\(\)\s+to anon\s*,\s*service_role/,
  );
});

test("compute_next_sequence_number returns 0 on empty chain, monotone otherwise", () => {
  // COALESCE(MAX(sequence_number) + 1, 0) — pinning the literal so a
  // refactor that switches to COUNT(*) (off-by-one on partial deletes,
  // though deletes are forbidden, so this would only bite in restored
  // backups) is caught here.
  assert.match(
    SQL,
    /create or replace function compute_next_sequence_number\(\)\s+returns int/,
  );
  assert.match(
    SQL,
    /select coalesce\s*\(\s*max\s*\(\s*sequence_number\s*\)\s*\+\s*1\s*,\s*0\s*\)\s+from lesson_chain/,
  );
});

test("compute_next_sequence_number is GRANTed to anon + service_role", () => {
  assert.match(
    SQL,
    /grant execute on function compute_next_sequence_number\(\)\s+to anon\s*,\s*service_role/,
  );
});

// ---------------------------------------------------------------------------
// (4) Migration discipline — no destructive ops on prior schema
// ---------------------------------------------------------------------------

test("migration 074 does not DROP swarm_lessons or any prior table", () => {
  // 4d adds a sibling table; it must not touch swarm_lessons (071) or
  // any other prior structure. A silent DROP TABLE in a fresh-DB
  // migration would still apply cleanly but blow away production data
  // on an upgrade run.
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?swarm_lessons\b/);
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?lessons\b/);
  assert.doesNotMatch(SQL, /drop table\s+(?:if exists\s+)?nodes\b/);
});
