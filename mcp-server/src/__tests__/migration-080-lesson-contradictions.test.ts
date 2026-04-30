import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 080 — §10.3 Contradicts-trigger storage floor (Swarm Phase 4g,
// issue #108)
//
// Why this guard exists: the §10.3 gate (lesson-contradiction-gate.ts)
// depends on three on-disk contracts. If any one drifts silently the gate
// becomes a no-op or, worse, demotes the wrong rows:
//
//   1. `lessons.tier` mirrors §10.6 on locally-generated lessons but
//      defaults to 'pinned' (Tier-A by construction). A reversed default
//      would force every reflect-pass output through the tentative pool.
//   2. `swarm_lesson_contradictions` exists with the §10.3 unique
//      ordered-pair constraint (a_id < b_id) and the cosine_similarity
//      range CHECK. The orchestrator relies on the canonical ordering
//      to dedup re-detections from either ingest direction.
//   3. The RPC `chain_swarm_lesson_contradicts` writes the §10.6
//      canonical column `swarm_lessons.lesson_tier = 'B'` (from
//      migration 078) — NOT a 4g-private `tier` column. The earlier
//      076 draft of this migration carried its own `swarm_lessons.tier`
//      column that silently bypassed the broadcast firewall view; that
//      column was deleted and the RPC now writes the firewall column
//      directly. These tests pin the corrected behaviour so a future
//      edit can never reintroduce the divergence.
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
  "supabase/migrations/080_lesson_contradictions.sql",
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
// (1) lessons.tier — §10.6 Tier-A default for locally-generated lessons
// ---------------------------------------------------------------------------

test("migration 080 adds lessons.tier with 'pinned' default", () => {
  // Locally-generated lessons are Tier-A by §10.6 construction (the
  // local node is, definitionally, its own ground truth). Reversing
  // this default would force every reflect-pass output through the
  // tentative pool unnecessarily.
  assert.match(
    SQL,
    /alter table lessons\s+add column if not exists tier\s+text\s+not null\s+default\s+'pinned'/,
  );
});

test("lessons.tier whitelist CHECK pins valid values", () => {
  assert.match(
    SQL,
    /alter table lessons\s+add constraint lessons_tier_whitelist\s+check\s*\(\s*tier in\s*\(\s*'tentative'\s*,\s*'pinned'\s*\)\s*\)/,
  );
  assert.match(SQL, /alter table lessons validate constraint lessons_tier_whitelist/);
});

test("lessons.tier has an index for cross-source REM audits", () => {
  assert.match(SQL, /create index if not exists lessons_tier_idx\s+on lessons\s*\(\s*tier\s*\)/);
});

// ---------------------------------------------------------------------------
// (2) swarm_lessons firebreak: 080 must NOT add its own tier column.
// The §10.6 canonical column is `swarm_lessons.lesson_tier` from migration
// 078. A regression that re-introduces a parallel `tier` column would
// silently bypass the broadcast firewall view in 078, and the §10.3
// demotion would never reach the broadcast pool. Pin the absence.
// ---------------------------------------------------------------------------

test("migration 080 does NOT add a parallel swarm_lessons.tier column", () => {
  // Negative test guarding against the 076-draft regression. If a future
  // edit re-introduces `ALTER TABLE swarm_lessons ADD COLUMN ... tier`,
  // this catches it before the silent firebreak collision returns.
  assert.doesNotMatch(
    SQL,
    /alter table swarm_lessons\s+add column[^;]*\btier\b(?!_)/,
  );
  // Index on a 4g-private column is also forbidden — 078 owns the
  // firebreak index `swarm_lessons_lesson_tier_idx` (or equivalent) on
  // the canonical column.
  assert.doesNotMatch(
    SQL,
    /create index[^;]*on swarm_lessons\s*\(\s*tier\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) swarm_lesson_contradictions — receiver-side §10.3 edge table
// ---------------------------------------------------------------------------

test("swarm_lesson_contradictions table exists with the §10.3 columns", () => {
  // The minimal column set the orchestrator depends on. cosine_similarity
  // is captured at detection time so a future audit can re-rank stale
  // edges without re-embedding. confidence is the polarity-detector
  // confidence in [0,1]. evidence_count tracks re-detections.
  assert.match(SQL, /create table if not exists swarm_lesson_contradictions\b/);
  assert.match(SQL, /a_id\s+uuid\s+not null\s+references swarm_lessons\(id\)\s+on delete cascade/);
  assert.match(SQL, /b_id\s+uuid\s+not null\s+references swarm_lessons\(id\)\s+on delete cascade/);
  assert.match(SQL, /cosine_similarity\s+real\s+not null\s+check\s*\(\s*cosine_similarity\s*>=\s*-1\s+and\s+cosine_similarity\s*<=\s*1\s*\)/);
  assert.match(SQL, /confidence\s+real\s+not null\s+default\s+0\.5/);
  assert.match(SQL, /reason\s+text\s+not null\s+default\s+''/);
  assert.match(SQL, /detected_at\s+timestamptz\s+not null\s+default\s+now\(\)/);
  assert.match(SQL, /evidence_count\s+int\s+not null\s+default\s+1/);
});

test("swarm_lesson_contradictions enforces canonical ordered pair (UNIQUE + a_id < b_id)", () => {
  // The orchestrator sorts (a_id, b_id) before insert so that the same
  // pair detected from either ingest direction collides on the UNIQUE
  // constraint. Without the ordering CHECK, a buggy direct insert could
  // create both (A,B) and (B,A) — two rows for the same contradiction —
  // and the §10.5 REM audit would double-count the conflict.
  assert.match(SQL, /check\s*\(\s*a_id\s*<>\s*b_id\s*\)/);
  assert.match(SQL, /check\s*\(\s*a_id\s*<\s*b_id\s*\)/);
  assert.match(SQL, /unique\s*\(\s*a_id\s*,\s*b_id\s*\)/);
});

test("swarm_lesson_contradictions has indexes for both endpoints + recency scans", () => {
  assert.match(SQL, /create index if not exists swarm_lesson_contradictions_a_idx\s+on swarm_lesson_contradictions\s*\(\s*a_id\s*\)/);
  assert.match(SQL, /create index if not exists swarm_lesson_contradictions_b_idx\s+on swarm_lesson_contradictions\s*\(\s*b_id\s*\)/);
  // detected_at DESC for "most recent contradictions" admin queries.
  assert.match(SQL, /create index if not exists swarm_lesson_contradictions_detected_at_idx\s+on swarm_lesson_contradictions\s*\(\s*detected_at desc\s*\)/);
});

test("swarm_lesson_contradictions has the standard service_role / anon grants", () => {
  // Mirror the migration 046 memory_relations grant pattern so the
  // RPC + dashboard can read/write without bespoke role plumbing.
  assert.match(
    SQL,
    /grant select,\s*insert,\s*update,\s*delete\s+on swarm_lesson_contradictions to service_role/,
  );
  assert.match(SQL, /grant select\s+on swarm_lesson_contradictions to anon/);
});

// ---------------------------------------------------------------------------
// (4) chain_swarm_lesson_contradicts RPC — the only writer
// ---------------------------------------------------------------------------

test("chain_swarm_lesson_contradicts RPC exists with the canonical signature", () => {
  // The orchestrator (lesson-contradiction-gate.ts → applyContradictionGate)
  // is the only writer. Pinning the signature here keeps that contract
  // visible to anyone editing either side.
  assert.match(
    SQL,
    /create or replace function chain_swarm_lesson_contradicts\(\s*p_lesson_a_id\s+uuid\s*,\s*p_lesson_b_id\s+uuid\s*,\s*p_cosine\s+real\s*,\s*p_confidence\s+real\s+default\s+0\.5\s*,\s*p_reason\s+text\s+default\s+''\s*\)/,
  );
  assert.match(SQL, /returns jsonb/);
  // EXECUTE grants — same pattern as chain_memories.
  assert.match(
    SQL,
    /grant execute on function chain_swarm_lesson_contradicts\(uuid,\s*uuid,\s*real,\s*real,\s*text\)\s+to anon,\s*service_role/,
  );
});

test("RPC sorts (a,b) into canonical (a_id < b_id) order before insert", () => {
  // §10.3 detection from either ingest direction MUST collapse onto a
  // single row. The RPC enforces this by sorting the pair on the way in,
  // matching the table-level CHECK (a_id < b_id). Pin the comparison so
  // a future "optimization" that drops the swap silently breaks dedup.
  assert.match(SQL, /if p_lesson_a_id\s*<\s*p_lesson_b_id then/);
});

test("RPC reads prior lesson_tier from swarm_lessons (the §10.6 firebreak column)", () => {
  // The RPC must read `lesson_tier` (migration 078) — NOT a 4g-private
  // `tier` column. This is the assertion that prevents the silent
  // firebreak regression: if a future edit changes `lesson_tier` back
  // to `tier`, the demotion no longer reaches the broadcast view.
  assert.match(
    SQL,
    /select lesson_tier into v_prior_a from swarm_lessons where id\s*=\s*v_a_id/,
  );
  assert.match(
    SQL,
    /select lesson_tier into v_prior_b from swarm_lessons where id\s*=\s*v_b_id/,
  );
});

test("RPC demotes both endpoints to lesson_tier='B' atomically", () => {
  // §10.3 "MUST mark both as tentative" maps to §10.6 Tier-B. The UPDATE
  // runs after the edge upsert in the same SQL function — they share an
  // implicit transaction. A future edit that splits this into two RPCs
  // would create a window where the edge exists but the demotion hasn't
  // happened yet.
  assert.match(
    SQL,
    /update swarm_lessons set lesson_tier\s*=\s*'b' where id in\s*\(\s*v_a_id\s*,\s*v_b_id\s*\)/,
  );
});

test("RPC reports prior lesson tiers + a `demoted` flag", () => {
  // The orchestrator records an experience that captures the demotion
  // delta — knowing whether either side was previously 'A' (i.e. a
  // previously-broadcast-eligible lesson is now contested) is the §10.5
  // REM-audit signal that matters most. Pin the JSONB output keys.
  assert.match(SQL, /'prior_lesson_tier_a',\s*v_prior_a/);
  assert.match(SQL, /'prior_lesson_tier_b',\s*v_prior_b/);
  assert.match(SQL, /'demoted',\s*\(v_prior_a\s*=\s*'a'\s+or\s+v_prior_b\s*=\s*'a'\)/);
});

test("RPC rejects self-contradiction and out-of-range cosine", () => {
  // Defense in depth — the gate already filters self-pairs and clamps
  // cosine, but the RPC must not be a sharp edge for any other caller.
  assert.match(SQL, /if p_lesson_a_id\s*=\s*p_lesson_b_id then/);
  assert.match(SQL, /'self-contradiction not allowed'/);
  assert.match(
    SQL,
    /if p_cosine is null or p_cosine\s*<\s*-1 or p_cosine\s*>\s*1 then/,
  );
});

// ---------------------------------------------------------------------------
// (5) No DROP, no DELETE, no data backfill — Reed's standing migration rule
// ---------------------------------------------------------------------------

test("migration 080 contains no DROP / DELETE / TRUNCATE statements", () => {
  // Verfassung pillar 4: data is sacred. Schema migrations may add or
  // alter, never remove silently. The autonomy loop is also explicitly
  // forbidden from executing data-destructive SQL.
  assert.doesNotMatch(SQL, /\bdrop\s+(?:table|column|index|constraint|function)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
  assert.doesNotMatch(SQL, /\btruncate\b/);
});
