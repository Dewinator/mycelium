-- ---------------------------------------------------------------------------
-- 072_lessons_pattern_name.sql — closes (part of) issue #95
--
-- Adds a human-readable `pattern_name` (kebab-case slug) to lessons. Produced
-- by the REM synthesiser as a short label alongside the full lesson text, so
-- clusters of experiences get a stable name — useful for cross-cluster
-- matching and UI/debug output.
--
-- Renumbering note (issue #95 triage): this work originally lived in a stashed
-- 050_lessons_pattern_name.sql from an interrupted autonomy branch. Slot 050
-- on main is now `050_grant_coactivate_memories.sql` (unrelated work merged in
-- the interim). Next free slot after the swarm Phase 1 migrations (070, 071)
-- is 072 — the column add and RPC body are unchanged from the original stash,
-- modulo the GRANT EXECUTE that the stash forgot.
-- ---------------------------------------------------------------------------

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS pattern_name TEXT;

CREATE INDEX IF NOT EXISTS lessons_pattern_name_idx
  ON lessons (pattern_name)
  WHERE pattern_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- record_lesson — extended with p_pattern_name
--
-- The previous 5-argument signature is dropped explicitly: CREATE OR REPLACE
-- does NOT replace across different parameter counts — it creates an overload
-- instead, which would silently route 5-arg callers to the old body without
-- the new column. Dropping first guarantees exactly one canonical signature.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_lesson(
  TEXT, VECTOR(768), UUID[], TEXT, FLOAT
);

CREATE OR REPLACE FUNCTION record_lesson(
  p_lesson        TEXT,
  p_embedding     VECTOR(768),
  p_source_ids    UUID[],
  p_category      TEXT  DEFAULT 'general',
  p_confidence    FLOAT DEFAULT 0.6,
  p_pattern_name  TEXT  DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  new_id    UUID;
  agg_val   FLOAT;
  agg_aro   FLOAT;
  ev_count  INT;
BEGIN
  SELECT avg(valence), avg(arousal), count(*)
    INTO agg_val, agg_aro, ev_count
    FROM experiences
    WHERE id = ANY(p_source_ids);

  INSERT INTO lessons (
    lesson, embedding, source_ids, category, confidence,
    valence, arousal, evidence_count, pattern_name
  ) VALUES (
    p_lesson, p_embedding, p_source_ids, p_category, p_confidence,
    COALESCE(agg_val, 0), COALESCE(agg_aro, 0), GREATEST(ev_count, 1),
    NULLIF(trim(p_pattern_name), '')
  )
  RETURNING id INTO new_id;

  UPDATE experiences
     SET reflected = TRUE,
         lesson_id = new_id
   WHERE id = ANY(p_source_ids);

  RETURN new_id;
END;
$$;

-- DROP above removed every grant; re-issue for the new 6-arg signature so
-- service_role / anon can keep calling the RPC. Mirrors the GRANT in 015.
GRANT EXECUTE ON FUNCTION record_lesson(
  TEXT, VECTOR(768), UUID[], TEXT, FLOAT, TEXT
) TO anon, service_role;
