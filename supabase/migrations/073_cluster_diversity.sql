-- ---------------------------------------------------------------------------
-- 073_cluster_diversity.sql — closes (last part of) issue #95
--
-- A cluster is only a meaningful *pattern* if its members are contextually
-- diverse — otherwise it's just the same work logged twice. Before this
-- migration find_experience_clusters had no notion of diversity and would
-- happily cluster two fragments of the same session, feeding the REM
-- synthesiser redundant input.
--
-- Axiom: "cluster == pattern  ⇔  diversity_score ≥ min_diversity_score".
--
-- diversity_score ∈ [0, 1] is a weighted sum of three dimensions:
--   0.50 · time_spread_norm      — (max_ts − min_ts) clipped to
--                                  `time_spread_window_hours`
--   0.25 · project_diversity     — (distinct_projects − 1) / (N − 1),
--                                  NULLs as own bucket
--   0.25 · task_type_diversity   — analogous
--
-- Time-spread is the dominant axis because same-project + same-task-type can
-- still be a valid intra-project pattern ("Ich vergesse X beim implement-
-- Task"), but those must then be spread over time. Same-project + same-task
-- + < 1 h is redundancy, not pattern.
--
-- Default `min_diversity_score = 0.0` keeps the RPC backwards-compatible for
-- callers that want raw clusters; the REM-sleep caller passes a positive
-- gate (see scripts/nightly-sleep.mjs, env REM_MIN_DIVERSITY).
--
-- Renumbering note (issue #95 triage): this work originally lived in a
-- stashed 051_cluster_diversity.sql from an interrupted autonomy branch.
-- Slot 051 on main is now `051_fix_coactivate_memories.sql` (unrelated work
-- merged in the interim). 072 was just taken by the lessons.pattern_name
-- migration; 073 is the next free slot. The RPC body is unchanged from the
-- original stash, modulo:
--   1. The GRANT EXECUTE for the new 6-arg signature, which the stash
--      forgot — DROP FUNCTION removes the GRANT issued by migration 016
--      along with the function, so without re-granting every authenticated
--      client breaks at runtime.
--   2. A defensive DROP of both prior overloads (3-arg from 015, 4-arg from
--      016) before the recreate, so CREATE OR REPLACE can never silently
--      add a NEW overload on top instead of replacing.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS find_experience_clusters(FLOAT, INT, INT, FLOAT);
DROP FUNCTION IF EXISTS find_experience_clusters(FLOAT, INT, INT);

CREATE OR REPLACE FUNCTION find_experience_clusters(
  similarity_threshold     FLOAT DEFAULT 0.85,
  min_cluster_size         INT   DEFAULT 2,
  max_age_days             INT   DEFAULT 30,
  lesson_match_threshold   FLOAT DEFAULT 0.78,
  time_spread_window_hours INT   DEFAULT 72,
  min_diversity_score      FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  seed_id              UUID,
  seed_summary         TEXT,
  member_ids           UUID[],
  member_count         INT,
  avg_difficulty       FLOAT,
  avg_valence          FLOAT,
  outcomes             TEXT[],
  matched_lesson_id    UUID,
  matched_lesson_text  TEXT,
  matched_similarity   FLOAT,
  diversity_score      FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  rec              RECORD;
  used             UUID[] := ARRAY[]::UUID[];
  match            RECORD;
  time_span_hours  FLOAT;
  distinct_proj    INT;
  distinct_task    INT;
  p_ratio          FLOAT;
  t_ratio          FLOAT;
  time_norm        FLOAT;
BEGIN
  FOR rec IN
    SELECT id, summary, embedding
      FROM experiences
     WHERE reflected = FALSE
       AND embedding IS NOT NULL
       AND created_at >= NOW() - (max_age_days || ' days')::INTERVAL
     ORDER BY created_at DESC
  LOOP
    IF rec.id = ANY(used) THEN CONTINUE; END IF;

    seed_id      := rec.id;
    seed_summary := rec.summary;

    SELECT
      array_agg(e.id),
      count(*)::INT,
      avg(e.difficulty)::FLOAT,
      avg(e.valence)::FLOAT,
      array_agg(DISTINCT e.outcome)
      INTO member_ids, member_count, avg_difficulty, avg_valence, outcomes
    FROM experiences e
    WHERE e.reflected = FALSE
      AND e.embedding IS NOT NULL
      AND e.id <> ALL(used)
      AND (1 - (e.embedding <=> rec.embedding)) >= similarity_threshold
      AND e.created_at >= NOW() - (max_age_days || ' days')::INTERVAL;

    IF member_count >= min_cluster_size THEN
      -- diversity over the member set ----------------------------------------
      SELECT
        EXTRACT(epoch FROM (MAX(e.created_at) - MIN(e.created_at))) / 3600.0,
        COUNT(DISTINCT COALESCE(e.project_id::TEXT, '__null__')),
        COUNT(DISTINCT COALESCE(e.task_type,        '__null__'))
        INTO time_span_hours, distinct_proj, distinct_task
      FROM experiences e
      WHERE e.id = ANY(member_ids);

      time_norm := LEAST(GREATEST(time_span_hours, 0) / NULLIF(time_spread_window_hours, 0)::FLOAT, 1.0);
      p_ratio   := CASE WHEN member_count > 1 THEN (distinct_proj - 1)::FLOAT / (member_count - 1) ELSE 0 END;
      t_ratio   := CASE WHEN member_count > 1 THEN (distinct_task - 1)::FLOAT / (member_count - 1) ELSE 0 END;

      diversity_score := 0.50 * time_norm + 0.25 * p_ratio + 0.25 * t_ratio;

      IF diversity_score < min_diversity_score THEN
        -- Below diversity gate: mark members as used so we don't reseed the
        -- same set on the next iteration, but do NOT emit. Treat as noise.
        used := used || member_ids;
        CONTINUE;
      END IF;

      used := used || member_ids;

      -- Lesson-match lookup (unchanged from migration 016 v2) ----------------
      SELECT l.id, l.lesson, (1 - (l.embedding <=> rec.embedding))::FLOAT AS sim
        INTO match
        FROM lessons l
       WHERE l.embedding IS NOT NULL
         AND (1 - (l.embedding <=> rec.embedding)) >= lesson_match_threshold
       ORDER BY l.embedding <=> rec.embedding
       LIMIT 1;

      IF FOUND THEN
        matched_lesson_id   := match.id;
        matched_lesson_text := match.lesson;
        matched_similarity  := match.sim;
      ELSE
        matched_lesson_id   := NULL;
        matched_lesson_text := NULL;
        matched_similarity  := NULL;
      END IF;

      RETURN NEXT;
    ELSE
      used := used || ARRAY[rec.id];
    END IF;
  END LOOP;
END;
$$;

-- DROP above removed every grant; re-issue for the new 6-arg signature so
-- service_role / anon can keep calling the RPC. Mirrors the GRANT in 016.
GRANT EXECUTE ON FUNCTION find_experience_clusters(
  FLOAT, INT, INT, FLOAT, INT, FLOAT
) TO anon, service_role;
