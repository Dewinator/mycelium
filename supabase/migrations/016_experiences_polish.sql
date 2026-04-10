-- Polish layer on top of 015_experiences.sql.
--
-- What this adds:
--   1. useful_count + last_consulted_at on experiences (track which past
--      episodes actually informed a later decision — strongest learning signal)
--   2. experience_memory_links — Hebbian cross-table edges between the
--      experiential layer and the semantic memory layer ("the time I worked
--      with fact X went badly")
--   3. Smarter find_experience_clusters — also returns the closest existing
--      lesson per cluster, so the LLM can decide reinforce vs new
--   4. find_similar_lesson — utility for matching individual embeddings
--   5. dedup_lessons — merge near-identical lessons (after several reflect runs
--      they tend to drift toward similar phrasings)
--   6. find_promotion_candidates — lessons ripe for graduation into traits
--   7. soul_drift — quantify how much the experiential mean has shifted in
--      the last N days vs the older baseline (cosine distance of average
--      embeddings); a real "did the soul move?" metric
--   8. soul_stats v2 — exposes the new fields plus drift + promotion candidates
--   9. cron jobs for weekly lesson dedup

-- ---------------------------------------------------------------------------
-- (1) experiences: track consultation
-- ---------------------------------------------------------------------------
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS useful_count      INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_consulted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS experiences_useful_idx     ON experiences (useful_count);
CREATE INDEX IF NOT EXISTS experiences_consulted_idx  ON experiences (last_consulted_at);

CREATE OR REPLACE FUNCTION mark_experience_useful(p_experience_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE experiences
     SET useful_count      = useful_count + 1,
         last_consulted_at = NOW()
   WHERE id = p_experience_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- (2) Experience ↔ Memory cross-link table (the actual fusion of layers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experience_memory_links (
  experience_id UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  memory_id     UUID NOT NULL REFERENCES memories(id)    ON DELETE CASCADE,
  weight        FLOAT NOT NULL DEFAULT 0.5,
  similarity    FLOAT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (experience_id, memory_id)
);
CREATE INDEX IF NOT EXISTS exp_mem_links_mem_idx ON experience_memory_links (memory_id);
CREATE INDEX IF NOT EXISTS exp_mem_links_exp_idx ON experience_memory_links (experience_id);

-- Auto-link an experience to its semantic neighbors in the memories table.
-- Called from the application after record_experience succeeds.
CREATE OR REPLACE FUNCTION link_experience_to_memories(
  p_experience_id UUID,
  p_embedding     VECTOR(768),
  p_top_k         INT  DEFAULT 3,
  p_min_similarity FLOAT DEFAULT 0.55
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  inserted INT;
BEGIN
  WITH neighbors AS (
    SELECT m.id, (1 - (m.embedding <=> p_embedding))::FLOAT AS sim
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND m.stage <> 'archived'
    ORDER BY m.embedding <=> p_embedding
    LIMIT p_top_k
  ),
  ins AS (
    INSERT INTO experience_memory_links (experience_id, memory_id, weight, similarity)
    SELECT p_experience_id, n.id, n.sim, n.sim
    FROM neighbors n
    WHERE n.sim >= p_min_similarity
    ON CONFLICT (experience_id, memory_id) DO UPDATE
      SET weight     = GREATEST(experience_memory_links.weight, EXCLUDED.weight),
          similarity = EXCLUDED.similarity
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;

-- Reverse lookup: for a memory, return its linked experiences (so memory recall
-- can surface "this fact has lived experience attached to it").
CREATE OR REPLACE FUNCTION experiences_for_memory(
  p_memory_id UUID,
  p_limit     INT DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  summary     TEXT,
  outcome     TEXT,
  difficulty  FLOAT,
  valence     FLOAT,
  weight      FLOAT,
  created_at  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT e.id, e.summary, e.outcome, e.difficulty, e.valence, l.weight, e.created_at
  FROM experience_memory_links l
  JOIN experiences e ON e.id = l.experience_id
  WHERE l.memory_id = p_memory_id
  ORDER BY l.weight DESC, e.created_at DESC
  LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------------
-- (3) find_similar_lesson — match an embedding against existing lessons
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_similar_lesson(
  query_embedding      VECTOR(768),
  similarity_threshold FLOAT DEFAULT 0.80
)
RETURNS TABLE (
  id             UUID,
  lesson         TEXT,
  similarity     FLOAT,
  evidence_count INT,
  category       TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.id,
    l.lesson,
    (1 - (l.embedding <=> query_embedding))::FLOAT AS similarity,
    l.evidence_count,
    l.category
  FROM lessons l
  WHERE l.embedding IS NOT NULL
    AND (1 - (l.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY l.embedding <=> query_embedding
  LIMIT 3;
$$;

-- ---------------------------------------------------------------------------
-- (4) find_experience_clusters v2 — also returns matched lesson per cluster
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS find_experience_clusters(FLOAT, INT, INT);
CREATE OR REPLACE FUNCTION find_experience_clusters(
  similarity_threshold FLOAT DEFAULT 0.85,
  min_cluster_size     INT   DEFAULT 2,
  max_age_days         INT   DEFAULT 30,
  lesson_match_threshold FLOAT DEFAULT 0.78
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
  matched_similarity   FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  rec   RECORD;
  used  UUID[] := ARRAY[]::UUID[];
  match RECORD;
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
      used := used || member_ids;

      -- Try to find an existing lesson that already covers this cluster.
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

-- ---------------------------------------------------------------------------
-- (5) dedup_lessons — merge near-identical lessons
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dedup_lessons(
  similarity_threshold FLOAT DEFAULT 0.92
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  rep      RECORD;
  dup_id   UUID;
  merged   INT := 0;
BEGIN
  FOR rep IN
    SELECT id, embedding
      FROM lessons
     WHERE embedding IS NOT NULL
     ORDER BY evidence_count DESC, confidence DESC
  LOOP
    -- skip if rep was merged into another in a prior iteration
    IF NOT EXISTS (SELECT 1 FROM lessons WHERE id = rep.id) THEN CONTINUE; END IF;

    FOR dup_id IN
      SELECT l.id
        FROM lessons l
       WHERE l.id <> rep.id
         AND l.embedding IS NOT NULL
         AND (1 - (l.embedding <=> rep.embedding)) >= similarity_threshold
    LOOP
      -- merge: rep absorbs the duplicate's evidence, sources, and child experiences
      UPDATE lessons
         SET evidence_count = lessons.evidence_count
                              + (SELECT evidence_count FROM lessons WHERE id = dup_id),
             source_ids     = lessons.source_ids
                              || (SELECT source_ids FROM lessons WHERE id = dup_id),
             confidence     = LEAST(lessons.confidence + 0.05, 1.0),
             updated_at     = NOW()
       WHERE id = rep.id;

      UPDATE experiences SET lesson_id = rep.id WHERE lesson_id = dup_id;
      DELETE FROM lessons WHERE id = dup_id;
      merged := merged + 1;
    END LOOP;
  END LOOP;
  RETURN merged;
END;
$$;

-- ---------------------------------------------------------------------------
-- (6) find_promotion_candidates — lessons ripe for trait graduation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_promotion_candidates(
  min_evidence    INT   DEFAULT 4,
  min_confidence  FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id             UUID,
  lesson         TEXT,
  category       TEXT,
  evidence_count INT,
  confidence     FLOAT,
  valence        FLOAT,
  created_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, lesson, category, evidence_count, confidence, valence, created_at
  FROM lessons
  WHERE promoted_to_trait = FALSE
    AND evidence_count >= min_evidence
    AND confidence     >= min_confidence
  ORDER BY evidence_count DESC, confidence DESC
  LIMIT 20;
$$;

-- ---------------------------------------------------------------------------
-- (7) soul_drift — how much has the experiential mean shifted recently?
--     Approach: compute the average (centroid) embedding of experiences in
--     the last `recent_days` window vs everything older. Return cosine
--     distance between the two centroids. 0 = identical, 1 = orthogonal,
--     2 = opposite. Plus the count breakdown so the number can be trusted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soul_drift(
  recent_days INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  recent_centroid VECTOR(768);
  older_centroid  VECTOR(768);
  recent_n        INT;
  older_n         INT;
  drift_value     FLOAT;
BEGIN
  -- pgvector lacks AVG(vector); we approximate the centroid by averaging
  -- componentwise via array math. For 768 dims this is still a single scan.
  WITH r AS (
    SELECT embedding::real[] AS arr
    FROM experiences
    WHERE embedding IS NOT NULL
      AND created_at >= NOW() - (recent_days || ' days')::INTERVAL
  ),
  o AS (
    SELECT embedding::real[] AS arr
    FROM experiences
    WHERE embedding IS NOT NULL
      AND created_at <  NOW() - (recent_days || ' days')::INTERVAL
  ),
  rcent AS (
    SELECT
      (SELECT count(*) FROM r) AS n,
      (
        SELECT array_agg(comp_avg ORDER BY i)
        FROM (
          SELECT i, avg(arr[i]) AS comp_avg
          FROM r, generate_series(1, 768) AS i
          GROUP BY i
        ) s
      ) AS centroid
  ),
  ocent AS (
    SELECT
      (SELECT count(*) FROM o) AS n,
      (
        SELECT array_agg(comp_avg ORDER BY i)
        FROM (
          SELECT i, avg(arr[i]) AS comp_avg
          FROM o, generate_series(1, 768) AS i
          GROUP BY i
        ) s
      ) AS centroid
  )
  SELECT rcent.n, ocent.n,
         CASE WHEN rcent.centroid IS NULL OR ocent.centroid IS NULL THEN NULL
              ELSE (rcent.centroid::VECTOR(768) <=> ocent.centroid::VECTOR(768))::FLOAT
         END
    INTO recent_n, older_n, drift_value
    FROM rcent, ocent;

  RETURN jsonb_build_object(
    'recent_days', recent_days,
    'recent_n',    COALESCE(recent_n, 0),
    'older_n',     COALESCE(older_n,  0),
    'drift',       drift_value,
    'computed_at', NOW()
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- (8) soul_stats v2 — replaces 015's version with the new fields
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soul_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result        JSONB;
  drift_payload JSONB;
BEGIN
  drift_payload := soul_drift(7);

  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'experiences',     (SELECT count(*) FROM experiences),
        'lessons',         (SELECT count(*) FROM lessons),
        'traits',          (SELECT count(*) FROM soul_traits),
        'unreflected',     (SELECT count(*) FROM experiences WHERE reflected = FALSE),
        'useful_total',    (SELECT COALESCE(sum(useful_count), 0) FROM experiences),
        'avg_difficulty',  (SELECT COALESCE(avg(difficulty), 0) FROM experiences),
        'avg_valence',     (SELECT COALESCE(avg(valence),    0) FROM experiences),
        'success_rate',    (SELECT CASE WHEN count(*) > 0
                              THEN count(*) FILTER (WHERE outcome = 'success')::FLOAT / count(*)
                              ELSE 0 END FROM experiences WHERE outcome <> 'unknown'),
        'cross_links',     (SELECT count(*) FROM experience_memory_links)
      )
    ),
    'drift', drift_payload,
    'outcomes', (
      SELECT COALESCE(jsonb_object_agg(outcome, n), '{}'::jsonb)
      FROM (SELECT outcome, count(*) AS n FROM experiences GROUP BY outcome) o
    ),
    'sentiment', (
      SELECT COALESCE(jsonb_object_agg(user_sentiment, n), '{}'::jsonb)
      FROM (SELECT user_sentiment, count(*) AS n FROM experiences
            WHERE user_sentiment IS NOT NULL GROUP BY user_sentiment) s
    ),
    'task_types', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', task_type, 'count', n,
        'success_rate', sr, 'avg_difficulty', avd
      ) ORDER BY n DESC), '[]'::jsonb)
      FROM (
        SELECT task_type,
               count(*) AS n,
               CASE WHEN count(*) FILTER (WHERE outcome <> 'unknown') > 0
                    THEN count(*) FILTER (WHERE outcome = 'success')::FLOAT
                       / count(*) FILTER (WHERE outcome <> 'unknown')
                    ELSE NULL END AS sr,
               avg(difficulty)::FLOAT AS avd
          FROM experiences
         WHERE task_type IS NOT NULL
         GROUP BY task_type
      ) t
    ),
    'timeline', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'day', day, 'count', cnt, 'avg_valence', av
      ) ORDER BY day), '[]'::jsonb)
      FROM (
        SELECT d::date AS day,
               COALESCE((SELECT count(*)        FROM experiences WHERE created_at::date = d::date), 0) AS cnt,
               COALESCE((SELECT avg(valence)::FLOAT FROM experiences WHERE created_at::date = d::date), 0) AS av
        FROM generate_series(
          (NOW() - INTERVAL '29 days')::date,
          NOW()::date,
          INTERVAL '1 day'
        ) d
      ) sub
    ),
    'recent_experiences', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'created_at') DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',           id,
          'summary',      summary,
          'task_type',    task_type,
          'outcome',      outcome,
          'difficulty',   difficulty,
          'valence',      valence,
          'sentiment',    user_sentiment,
          'reflected',    reflected,
          'useful_count', useful_count,
          'created_at',   created_at
        ) AS r
        FROM experiences
        ORDER BY created_at DESC
        LIMIT 15
      ) sub
    ),
    'top_lessons', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'evidence_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',             id,
          'lesson',         lesson,
          'category',       category,
          'evidence_count', evidence_count,
          'confidence',     confidence,
          'valence',        valence,
          'created_at',     created_at,
          'promoted',       promoted_to_trait
        ) AS r
        FROM lessons
        ORDER BY evidence_count DESC, confidence DESC
        LIMIT 12
      ) sub
    ),
    'promotion_candidates', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'evidence_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',             id,
          'lesson',         lesson,
          'evidence_count', evidence_count,
          'confidence',     confidence
        ) AS r
        FROM find_promotion_candidates(4, 0.7)
      ) sub
    ),
    'traits', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'evidence_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',                 id,
          'trait',              trait,
          'polarity',           polarity,
          'evidence_count',     evidence_count,
          'confidence',         confidence,
          'first_seen_at',      first_seen_at,
          'last_reinforced_at', last_reinforced_at
        ) AS r
        FROM soul_traits
        ORDER BY evidence_count DESC
        LIMIT 20
      ) sub
    ),
    'most_useful_experiences', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'useful_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',           id,
          'summary',      summary,
          'useful_count', useful_count,
          'outcome',      outcome
        ) AS r
        FROM experiences
        WHERE useful_count > 0
        ORDER BY useful_count DESC
        LIMIT 8
      ) sub
    ),
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON experience_memory_links TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON experience_memory_links TO service_role;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION mark_experience_useful(UUID)                                 TO anon, service_role;
GRANT EXECUTE ON FUNCTION link_experience_to_memories(UUID, VECTOR(768), INT, FLOAT)   TO anon, service_role;
GRANT EXECUTE ON FUNCTION experiences_for_memory(UUID, INT)                            TO anon, service_role;
GRANT EXECUTE ON FUNCTION find_similar_lesson(VECTOR(768), FLOAT)                      TO anon, service_role;
GRANT EXECUTE ON FUNCTION find_experience_clusters(FLOAT, INT, INT, FLOAT)             TO anon, service_role;
GRANT EXECUTE ON FUNCTION dedup_lessons(FLOAT)                                         TO anon, service_role;
GRANT EXECUTE ON FUNCTION find_promotion_candidates(INT, FLOAT)                        TO anon, service_role;
GRANT EXECUTE ON FUNCTION soul_drift(INT)                                              TO anon, service_role;

-- ---------------------------------------------------------------------------
-- Cron: weekly lesson dedup, mirroring memory dedup pattern
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'vectormemory_dedup_lessons';
    PERFORM cron.schedule(
      'vectormemory_dedup_lessons',
      '30 3 * * 0',
      $sql$SELECT dedup_lessons(0.92);$sql$
    );
  END IF;
END $$;
