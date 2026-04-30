-- 074_lesson_chain.sql — Swarm Phase 4d (issue #104)
--
-- Per-node commitment chain for SELF-published Lessons. Spec §3.7.2.
-- The integrity guarantee §5 rule 19 leans on lives in this table:
-- a strictly-ordered, append-only sequence of lesson hashes whose
-- prev_lesson_hash links back to the previous tip. Rewriting any past
-- entry invalidates every subsequent hash this node has ever signed.
--
-- Append-only is enforced by trigger (UPDATE / DELETE raise) — defense
-- in depth so an operator with table-owner privileges still can't
-- silently rewrite chain history. RLS would also work but a trigger is
-- simpler to reason about and applies to every role that doesn't
-- bypass triggers (none should — the autonomy loop runs as service_role
-- which honors triggers).
--
-- Scope discipline:
--   * This table holds OUR locally-published lessons only. Remote-chain
--     caching for §5 rule 19 enforcement uses `swarm_lessons` (migration
--     071) as the source of truth — no per-origin dimension here.
--   * `sequence_number` is monotone-from-COALESCE (not SERIAL) so a
--     restore-from-backup keeps the chain intact: SERIAL sequences are
--     not part of pg_dump --data-only output and would diverge from the
--     backed-up sequence_numbers, breaking every prev_lesson_hash linkage.
--
-- Producer flow (TS-side, lands in a later phase — this migration only
-- supplies the SQL substrate):
--   1. prev := SELECT compute_next_prev_lesson_hash()    (NULL for first ever)
--   2. seq  := SELECT compute_next_sequence_number()      (0 for first ever)
--   3. build the lesson body with prev_lesson_hash = prev, sign
--   4. lesson_hash := multihash(sha2-256, JCS(signed_lesson))
--   5. INSERT INTO lesson_chain (lesson_id, signed_at, lesson_hash,
--                                prev_lesson_hash, sequence_number)
--                         VALUES (id, signed_at, hash, prev, seq);
-- Race protection: UNIQUE (sequence_number) makes a parallel double-insert
-- fail loudly rather than corrupting the chain.
--
-- Receiver-side rule 19 (TS-side, this migration ships nothing for it):
-- the wire-validator uses an injected `getExpectedPrevLessonHashForOrigin`
-- callback. The callback is the receiver's responsibility — typical
-- implementation queries `swarm_lessons WHERE origin_node_id = ?`
-- ORDER BY signed_at DESC LIMIT 1 and recomputes the multihash. This
-- migration intentionally does NOT cache remote chains: receivers MAY
-- (per §3.7.2) reconstruct producer chains from `swarm_lessons` rather
-- than maintaining a parallel cache table.
--
-- Reed runs the migration manually after merge — the autonomy loop is
-- forbidden from executing it (migration discipline from 070-073).

-- ---------------------------------------------------------------------------
-- (1) lesson_chain table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesson_chain (
  lesson_id        UUID        PRIMARY KEY,
  signed_at        TIMESTAMPTZ NOT NULL,
  lesson_hash      TEXT        NOT NULL UNIQUE,
  prev_lesson_hash TEXT,
  sequence_number  INT         NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sequence_number >= 0),
  -- §3.7.2: prev_lesson_hash IS NULL iff this is the very first lesson.
  -- Encoding the biconditional as a CHECK turns "first-lesson" semantics
  -- into a database invariant — a producer that forgets to set
  -- prev_lesson_hash on lesson #2 cannot quietly publish a broken chain.
  CHECK ((sequence_number = 0) = (prev_lesson_hash IS NULL)),
  UNIQUE (sequence_number)
);

CREATE INDEX IF NOT EXISTS lesson_chain_signed_at_idx
  ON lesson_chain (signed_at);

COMMENT ON TABLE lesson_chain IS
  'Mycelium swarm: per-node commitment chain over self-published lessons. SWARM_SPEC §3.7.2. Append-only by trigger; UPDATE and DELETE raise.';

-- ---------------------------------------------------------------------------
-- (2) Append-only enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lesson_chain_no_mutate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'lesson_chain is append-only — rows cannot be % (SWARM_SPEC §3.7.2)',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lesson_chain_no_update ON lesson_chain;
CREATE TRIGGER lesson_chain_no_update
  BEFORE UPDATE ON lesson_chain
  FOR EACH ROW EXECUTE FUNCTION lesson_chain_no_mutate();

DROP TRIGGER IF EXISTS lesson_chain_no_delete ON lesson_chain;
CREATE TRIGGER lesson_chain_no_delete
  BEFORE DELETE ON lesson_chain
  FOR EACH ROW EXECUTE FUNCTION lesson_chain_no_mutate();

-- ---------------------------------------------------------------------------
-- (3) Producer-side read helpers
--
-- compute_next_prev_lesson_hash() returns the tip of the current chain.
-- The producer feeds this into the NEXT lesson's prev_lesson_hash field
-- BEFORE signing — the field has to be inside the canonical signed bytes
-- per §3.7.2. NULL when the chain is empty (the very first lesson this
-- node ever publishes has prev_lesson_hash = null).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_next_prev_lesson_hash() RETURNS TEXT AS $$
  SELECT lesson_hash
  FROM lesson_chain
  ORDER BY sequence_number DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION compute_next_prev_lesson_hash() TO anon, service_role;

-- compute_next_sequence_number() — companion helper. Returns 0 for the
-- first-ever lesson, monotone-increasing thereafter. Producer calls this
-- at INSERT time. Two-call convention (read prev_hash + read seq) is
-- intentional: the producer needs the prev_hash BEFORE signing, and the
-- sequence_number AFTER signing (it's not part of the signed bytes).
CREATE OR REPLACE FUNCTION compute_next_sequence_number() RETURNS INT AS $$
  SELECT COALESCE(MAX(sequence_number) + 1, 0) FROM lesson_chain;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION compute_next_sequence_number() TO anon, service_role;
