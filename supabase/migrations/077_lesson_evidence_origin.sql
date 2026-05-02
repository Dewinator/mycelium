-- 077_lesson_evidence_origin.sql — Swarm Phase 4e (issue #105)
--
-- Producer-side substrate for the §4.6 Merkle inclusion-proof endpoint
-- (`GET /swarm/lessons/{id}/proof`). Stores, per locally-published Lesson,
-- the ordered list of `hashed_experience_id` leaves that fed its
-- `evidence_root` at signing time.
--
-- Why a separate table (and not a JSONB column on `lessons`):
--
--   * `lessons.metadata` is application-mutable: the autonomy loop, REM
--     promotions, and operator tools all write into it. A leaves array
--     stored there could be silently rewritten, breaking the §4.6 invariant
--     that `evidence_root == merkle_root(stored_leaves)` for every proof
--     this node ever issues.
--   * Append-only enforcement is column-by-column impossible inside a
--     JSONB blob. A dedicated table lets us put the trigger on UPDATE/DELETE
--     and put a row-level UNIQUE on (lesson_id, position) — the structural
--     guarantee the proof endpoint relies on.
--   * §4.6 may be queried at arbitrary cadence per lesson; a normalised
--     row-per-leaf shape supports the future per-leaf incremental fetch
--     path (4e successor) without a schema rewrite.
--
-- Privacy invariant — only the **hashed** experience id is stored. Raw
-- experience IDs never enter this table. Hashes are produced by
-- `hashExperienceId(...)` (services/evidence-merkle.ts, sub-phase 4c).
-- The shape constraint (CHECK) catches obvious raw-ID smuggling: the
-- hashed form is a 46-char base58btc multihash starting with 'Qm'; any
-- input that isn't that shape is rejected at INSERT time.
--
-- Append-only by trigger — same defense pattern as `lesson_chain` (074)
-- and `trust_edge_log` (075). An operator with table-owner privileges
-- still cannot silently rewrite a previously-published lesson's evidence
-- set, which would let the proof endpoint return a "valid" proof against
-- a different leaf set than the one that was originally signed.
--
-- Reed runs the migration manually after merge — the autonomy loop is
-- forbidden from executing it (migration discipline from 070-076).

-- ---------------------------------------------------------------------------
-- (1) lesson_evidence_origin table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesson_evidence_origin (
  lesson_id              UUID        NOT NULL,
  position               INT         NOT NULL,
  hashed_experience_id   TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lesson_id, position),
  -- §4.6: every leaf in the proof MUST be a sha2-256 multihash in
  -- base58btc. The shape pin keeps a producer bug (passing a raw UUID,
  -- a content blob, a different hash family) from silently committing
  -- bytes the §4.6 endpoint will later sign over and the receiver will
  -- reject as malformed. 46 chars + 'Qm' prefix is the deterministic
  -- output of multihash(sha2-256, ...) in base58btc; see evidence-merkle.ts.
  CHECK (LENGTH(hashed_experience_id) = 46),
  CHECK (hashed_experience_id LIKE 'Qm%'),
  CHECK (position >= 0),
  -- A lesson MUST NOT have two leaves at the same position (caught by
  -- the PRIMARY KEY) AND MUST NOT have the same leaf at two positions
  -- (the deduped-and-sorted contract from §3.7.1). This UNIQUE pin
  -- makes a producer that forgets to dedupe before writing the leaves
  -- fail loudly rather than emitting a tree the receiver will reject.
  UNIQUE (lesson_id, hashed_experience_id)
);

CREATE INDEX IF NOT EXISTS lesson_evidence_origin_lesson_id_idx
  ON lesson_evidence_origin (lesson_id);

COMMENT ON TABLE lesson_evidence_origin IS
  'Mycelium swarm: per-locally-published-Lesson list of hashed_experience_id leaves that fed its evidence_root at signing time. SWARM_SPEC §4.6 producer-side substrate for the inclusion-proof endpoint. Append-only by trigger; UPDATE and DELETE raise. Only hashes (never raw experience IDs) are stored.';

COMMENT ON COLUMN lesson_evidence_origin.hashed_experience_id IS
  'sha2-256 multihash of the raw experience id, encoded base58btc (46-char Qm... string). Produced by services/evidence-merkle.ts hashExperienceId(). Raw IDs MUST NOT be stored — only the hashed form leaves any module.';

COMMENT ON COLUMN lesson_evidence_origin.position IS
  'Zero-based index into the producer-canonical leaf order. SWARM_SPEC §3.7.1 sorts leaves ascending before tree construction; position pins that order so the proof endpoint can rebuild the same tree without re-sorting at query time.';

-- ---------------------------------------------------------------------------
-- (2) Append-only enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lesson_evidence_origin_no_mutate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'lesson_evidence_origin is append-only — rows cannot be % (SWARM_SPEC §4.6)',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lesson_evidence_origin_no_update ON lesson_evidence_origin;
CREATE TRIGGER lesson_evidence_origin_no_update
  BEFORE UPDATE ON lesson_evidence_origin
  FOR EACH ROW EXECUTE FUNCTION lesson_evidence_origin_no_mutate();

DROP TRIGGER IF EXISTS lesson_evidence_origin_no_delete ON lesson_evidence_origin;
CREATE TRIGGER lesson_evidence_origin_no_delete
  BEFORE DELETE ON lesson_evidence_origin
  FOR EACH ROW EXECUTE FUNCTION lesson_evidence_origin_no_mutate();

-- ---------------------------------------------------------------------------
-- (3) record_lesson_evidence — atomic insert of all leaves for one lesson.
--
-- Single round-trip from the Lesson-publishing flow. Either every leaf is
-- recorded (success) or none are (transactional rollback on any CHECK or
-- UNIQUE violation). Idempotency: re-recording the SAME leaf set for the
-- same lesson_id is a no-op (returns ok=false with reason='already_recorded')
-- so a publisher retry doesn't double-write. A DIFFERENT leaf set for an
-- existing lesson_id is a hard error (returns ok=false with
-- reason='leaf_set_mismatch') — the §4.6 contract is one signed
-- evidence_root per lesson, immutable once signed.
--
-- Input p_hashed_experience_ids is the producer-canonical (sorted, deduped)
-- leaf order, not raw experience ids. The producer constructs this by
-- calling buildEvidenceRoot(...).leaves from evidence-merkle.ts and passing
-- that array verbatim — the function does NOT re-sort, dedupe, or hash.
-- That keeps the SQL pure and the privacy boundary in one TS module.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_lesson_evidence(
  p_lesson_id              UUID,
  p_hashed_experience_ids  TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_count       INT;
  v_existing    INT;
  v_existing_set TEXT[];
  v_input_set   TEXT[];
BEGIN
  IF p_lesson_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lesson_id is required');
  END IF;
  IF p_hashed_experience_ids IS NULL OR array_length(p_hashed_experience_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_count must be >= 1 (SWARM_SPEC §3.1)');
  END IF;

  v_count := array_length(p_hashed_experience_ids, 1);

  -- Idempotency check: does this lesson already have evidence?
  SELECT COUNT(*) INTO v_existing
  FROM lesson_evidence_origin
  WHERE lesson_id = p_lesson_id;

  IF v_existing > 0 THEN
    -- Compare existing leaves against input. Position-ordered comparison
    -- so a re-publish with the same canonical order returns ok=false /
    -- already_recorded (idempotent retry), and any divergence is a hard
    -- mismatch (the lesson was already signed against a different root).
    SELECT array_agg(hashed_experience_id ORDER BY position)
      INTO v_existing_set
    FROM lesson_evidence_origin
    WHERE lesson_id = p_lesson_id;

    v_input_set := p_hashed_experience_ids;

    IF v_existing_set = v_input_set THEN
      RETURN jsonb_build_object(
        'ok',             false,
        'error',          'already_recorded',
        'lesson_id',      p_lesson_id,
        'evidence_count', v_existing
      );
    ELSE
      RETURN jsonb_build_object(
        'ok',             false,
        'error',          'leaf_set_mismatch',
        'lesson_id',      p_lesson_id,
        'existing_count', v_existing,
        'input_count',    v_count
      );
    END IF;
  END IF;

  -- Atomic insert of all leaves at their canonical positions. The
  -- generate_subscripts iteration preserves array order, which IS the
  -- producer-canonical position contract. CHECK constraints on shape
  -- and the PRIMARY KEY on (lesson_id, position) catch any malformed
  -- input at row-level — the whole insert rolls back transactionally
  -- on the first violation.
  INSERT INTO lesson_evidence_origin (lesson_id, position, hashed_experience_id)
  SELECT p_lesson_id, i - 1, p_hashed_experience_ids[i]
  FROM generate_subscripts(p_hashed_experience_ids, 1) AS i;

  RETURN jsonb_build_object(
    'ok',             true,
    'lesson_id',      p_lesson_id,
    'evidence_count', v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION record_lesson_evidence(UUID, TEXT[])
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (4) get_lesson_evidence — read-side helper for the §4.6 endpoint.
--
-- Returns the canonical leaf order for the lesson. Empty array when the
-- lesson is unknown (the §4.6 endpoint maps that to HTTP 404 — never
-- a 200 with empty proofs, which would let a malicious caller forge
-- "this node holds no evidence" answers). The endpoint distinguishes
-- 404 from 410 (forgotten/superseded) by checking against the lessons
-- table separately — this RPC's job is just the leaf lookup.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_lesson_evidence(p_lesson_id UUID)
RETURNS TABLE ("position" INT, hashed_experience_id TEXT)
LANGUAGE sql STABLE
AS $$
  SELECT position, hashed_experience_id
  FROM lesson_evidence_origin
  WHERE lesson_id = p_lesson_id
  ORDER BY position ASC;
$$;

GRANT EXECUTE ON FUNCTION get_lesson_evidence(UUID) TO anon, service_role;
