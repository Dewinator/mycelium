import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 077 — lesson_evidence_origin (issue #105, sub-phase 4e)
//
// Producer-side substrate for the §4.6 inclusion-proof endpoint. The pins
// below cover the load-bearing structural invariants the proof endpoint
// (and the §4.6 invariant evidence_root == merkle_root(stored_leaves))
// will rely on once the HTTP handler lands. Without these the table can
// silently regress into shapes that *look* like an evidence store but
// no longer enforce one:
//
//   1. Append-only must be SQL-side, not application-trust. A producer
//      flow that's "carefully not running UPDATE" is one fat finger
//      away from rewriting an already-published lesson's evidence set,
//      which would let the §4.6 endpoint hand peers a proof against
//      bytes the original signature does not cover.
//   2. The hashed_experience_id shape pin (46 chars + Qm prefix) keeps
//      a producer bug (passing a raw UUID, content blob, or different
//      hash family) from ever entering the wire path.
//   3. UNIQUE (lesson_id, hashed_experience_id) makes a forgotten
//      dedupe in the producer flow fail loudly rather than emitting
//      a tree the receiver will reject.
//   4. The atomic record_lesson_evidence(...) RPC is the only intended
//      writer; an idempotent retry on the same leaf set is a no-op,
//      a divergent leaf set on an existing lesson is a hard error
//      (the §4.6 contract is one signed evidence_root per lesson).
//
// Contract-test pattern mirrors migration-070..076: the autonomy loop
// cannot execute migrations (Reed runs them by hand after merge), so
// shape is pinned at the SQL-text level. Stripping comments before
// keyword matching prevents an explanatory phrase like "no DROP" from
// satisfying a structural assertion.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/077_lesson_evidence_origin.sql",
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

test("lesson_evidence_origin table is created with the documented column set", () => {
  assert.match(SQL, /create table if not exists lesson_evidence_origin\b/);
  assert.match(SQL, /lesson_id\s+uuid\s+not null/);
  assert.match(SQL, /position\s+int\s+not null/);
  assert.match(SQL, /hashed_experience_id\s+text\s+not null/);
  assert.match(SQL, /created_at\s+timestamptz\s+not null\s+default now\(\)/);
});

test("primary key is (lesson_id, position) — not a surrogate UUID", () => {
  // Using the natural composite key both shrinks the row and pins the
  // position uniqueness invariant in the most expressive place. A
  // surrogate id would let two rows with the same (lesson_id, position)
  // coexist if the UNIQUE was forgotten; the composite PK makes that
  // impossible by construction.
  assert.match(SQL, /primary key\s*\(\s*lesson_id\s*,\s*position\s*\)/);
});

test("position is non-negative", () => {
  assert.match(SQL, /check\s*\(\s*position\s*>=\s*0\s*\)/);
});

test("hashed_experience_id shape: 46 chars + Qm prefix (sha2-256 base58btc multihash)", () => {
  // The wire form per §3.7.1 is multihash(sha2-256, ...) in base58btc,
  // which is deterministically a 46-char string starting with 'Qm'.
  // Pinning this at the column level catches a producer that
  // accidentally writes a raw UUID (36 chars) or content blob.
  assert.match(SQL, /check\s*\(\s*length\s*\(\s*hashed_experience_id\s*\)\s*=\s*46\s*\)/);
  assert.match(SQL, /check\s*\(\s*hashed_experience_id\s+like\s+'qm%'\s*\)/);
});

test("UNIQUE (lesson_id, hashed_experience_id) prevents duplicate leaves per lesson", () => {
  // §3.7.1 leaves are deduped before the tree is built. A producer that
  // forgets to dedupe would emit a different evidence_root than the
  // receiver would compute when reconstructing from the proof. The
  // UNIQUE makes the bug fail at INSERT time on the producer side.
  assert.match(SQL, /unique\s*\(\s*lesson_id\s*,\s*hashed_experience_id\s*\)/);
});

test("lesson_id index for proof-endpoint lookup", () => {
  // The §4.6 endpoint scans by lesson_id; without an index every proof
  // request triggers a full table scan once the table has any size.
  assert.match(SQL, /create index if not exists lesson_evidence_origin_lesson_id_idx\s+on lesson_evidence_origin \(lesson_id\)/);
});

// ---------------------------------------------------------------------------
// (2) Append-only triggers
// ---------------------------------------------------------------------------

test("UPDATE is forbidden by trigger (append-only invariant)", () => {
  assert.match(
    SQL,
    /create trigger lesson_evidence_origin_no_update\s+before update on lesson_evidence_origin\s+for each row execute function lesson_evidence_origin_no_mutate\(\)/,
  );
});

test("DELETE is forbidden by trigger (append-only invariant)", () => {
  assert.match(
    SQL,
    /create trigger lesson_evidence_origin_no_delete\s+before delete on lesson_evidence_origin\s+for each row execute function lesson_evidence_origin_no_mutate\(\)/,
  );
});

test("trigger function exists and raises with the spec section in the message", () => {
  assert.match(SQL, /create or replace function lesson_evidence_origin_no_mutate\(\) returns trigger/);
  // Operator-readable error: include the spec section so a confused
  // operator landing on the failure can find the rationale instantly.
  assert.match(SQL, /raise exception\s+'lesson_evidence_origin is append-only — rows cannot be %.*swarm_spec §4\.6\)'/i);
});

// ---------------------------------------------------------------------------
// (3) record_lesson_evidence RPC
// ---------------------------------------------------------------------------

test("record_lesson_evidence(UUID, TEXT[]) is created and granted", () => {
  assert.match(SQL, /create or replace function record_lesson_evidence\(\s*p_lesson_id\s+uuid\s*,\s*p_hashed_experience_ids\s+text\[\]\s*\)\s+returns jsonb/);
  assert.match(SQL, /grant execute on function record_lesson_evidence\(uuid, text\[\]\)\s+to anon, service_role/);
});

test("record_lesson_evidence rejects null lesson_id and empty/null evidence array", () => {
  // The §3.1 rule "evidence_count >= 1" lives in the RPC body — a
  // producer that calls with an empty leaf set MUST get a hard error
  // rather than silently writing zero rows (which would later make the
  // §4.6 endpoint return 200 with empty proofs).
  assert.match(SQL, /if p_lesson_id is null then\s+return jsonb_build_object\('ok', false, 'error', 'lesson_id is required'\);/);
  assert.match(
    SQL,
    /if p_hashed_experience_ids is null or array_length\(p_hashed_experience_ids, 1\) is null then\s+return jsonb_build_object\('ok', false, 'error', 'evidence_count must be >= 1 \(swarm_spec §3\.1\)'\);/,
  );
});

test("record_lesson_evidence is idempotent on the same leaf set (already_recorded)", () => {
  // The publishing flow may retry — re-recording the SAME leaves for the
  // same lesson MUST be a safe no-op. The RPC compares the existing leaf
  // set against the input and returns ok=false / error=already_recorded
  // so the caller can distinguish "already done" from "did the work".
  assert.match(SQL, /'already_recorded'/);
});

test("record_lesson_evidence rejects a divergent leaf set on existing lesson_id", () => {
  // §4.6 contract: one evidence_root per lesson, immutable after signing.
  // A divergent input MUST be a hard error, never a silent overwrite
  // (the append-only trigger would block the overwrite anyway, but
  // returning a clear leaf_set_mismatch error gives the producer a
  // useful failure mode instead of a generic trigger raise).
  assert.match(SQL, /'leaf_set_mismatch'/);
});

test("record_lesson_evidence inserts at canonical zero-based positions", () => {
  // generate_subscripts(arr, 1) yields 1..N; we subtract one to land on
  // zero-based position so position semantically matches array indexing
  // in the wire-side merkle code (services/evidence-merkle.ts).
  assert.match(
    SQL,
    /insert into lesson_evidence_origin \(lesson_id, position, hashed_experience_id\)\s+select p_lesson_id, i - 1, p_hashed_experience_ids\[i\]\s+from generate_subscripts\(p_hashed_experience_ids, 1\) as i;/,
  );
});

// ---------------------------------------------------------------------------
// (4) get_lesson_evidence RPC
// ---------------------------------------------------------------------------

test("get_lesson_evidence returns ordered (position, hashed_experience_id) pairs", () => {
  // Returning a setof rows with position included lets the proof-endpoint
  // implementation reconstruct the producer-canonical order without
  // relying on PostgreSQL's row-return order accidentally matching.
  // Ordering by position ASC is the §3.7.1 leaf-order contract.
  assert.match(SQL, /create or replace function get_lesson_evidence\(p_lesson_id uuid\)\s+returns table \("position" int, hashed_experience_id text\)\s+language sql stable/);
  assert.match(SQL, /select position, hashed_experience_id\s+from lesson_evidence_origin\s+where lesson_id = p_lesson_id\s+order by position asc/);
});

test("get_lesson_evidence is granted to anon and service_role", () => {
  assert.match(SQL, /grant execute on function get_lesson_evidence\(uuid\) to anon, service_role/);
});

// ---------------------------------------------------------------------------
// (5) Migration discipline — substrate-only, no DROP/DELETE/TRUNCATE
// ---------------------------------------------------------------------------

test("migration is substrate-only: no DROP, DELETE, or TRUNCATE on lesson_evidence_origin", () => {
  // The 070-076 discipline: Reed runs migrations manually, the autonomy
  // loop cannot execute them. A migration that destroys data couldn't
  // be safely rolled back, so we keep this floor structural.
  // (DROP TRIGGER IF EXISTS ... is allowed — it's the idempotent
  // re-create pattern, not data destruction.)
  assert.doesNotMatch(SQL, /drop\s+table\b/);
  assert.doesNotMatch(SQL, /delete\s+from\s+lesson_evidence_origin/);
  assert.doesNotMatch(SQL, /truncate\s+lesson_evidence_origin/);
  // Defense pin: the trigger itself uses RAISE EXCEPTION for UPDATE/DELETE.
  // The migration MUST NOT include any ALTER TABLE that would loosen the
  // PK or drop the UNIQUE — none should appear at all.
  assert.doesNotMatch(SQL, /alter\s+table\s+lesson_evidence_origin\s+drop/);
});

test("table and column COMMENTs cite SWARM_SPEC §4.6 — operator-discoverable rationale", () => {
  // A future operator running `\d+ lesson_evidence_origin` in psql sees
  // the spec citation directly. Same discipline as 074/075/076.
  assert.match(SQL, /comment on table lesson_evidence_origin is\s+'mycelium swarm:.*swarm_spec §4\.6/i);
  assert.match(SQL, /comment on column lesson_evidence_origin\.hashed_experience_id is/i);
  assert.match(SQL, /comment on column lesson_evidence_origin\.position is\s+'zero-based.*swarm_spec §3\.7\.1/i);
});
