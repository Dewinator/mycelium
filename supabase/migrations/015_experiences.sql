-- Experiential / "soul" memory layer.
--
-- The existing memories table stores SEMANTIC knowledge (facts, decisions,
-- people, topics). This migration adds an EPISODIC experience layer:
-- what was hard, what worked, how interactions felt. Together they form
-- something like a vectorised "soul" — not just what the agent knows,
-- but how it has lived.
--
-- Three layers:
--   1. experiences  — raw episodes (one per task / interaction). Many, cheap, decay-able.
--   2. lessons      — distilled patterns extracted from clusters of episodes ("I tend to X").
--   3. soul_traits  — the most stable, repeatedly-reinforced lessons → identity.
--
-- Lessons and traits emerge through periodic reflection (REM-sleep analogue):
-- the `find_experience_clusters` RPC groups recent unprocessed episodes by
-- semantic similarity; the LLM client then writes the synthesis back via
-- `record_lesson` / `promote_lesson_to_trait`.

-- ---------------------------------------------------------------------------
-- (1) experiences — raw episodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT,
  task_type           TEXT,                              -- refactor|debug|explain|implement|research|chat|...
  summary             TEXT NOT NULL,                     -- short narrative used for embedding & display
  details             TEXT,                              -- optional longer body
  outcome             TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (outcome IN ('success','partial','failure','unknown')),
  difficulty          FLOAT NOT NULL DEFAULT 0.5 CHECK (difficulty BETWEEN 0 AND 1),
  confidence_before   FLOAT CHECK (confidence_before BETWEEN 0 AND 1),
  confidence_after    FLOAT CHECK (confidence_after  BETWEEN 0 AND 1),
  user_sentiment      TEXT CHECK (user_sentiment IN ('frustrated','neutral','pleased','delighted','angry')),
  valence             FLOAT NOT NULL DEFAULT 0    CHECK (valence BETWEEN -1 AND 1),
  arousal             FLOAT NOT NULL DEFAULT 0    CHECK (arousal BETWEEN  0 AND 1),
  what_worked         TEXT,
  what_failed         TEXT,
  tools_used          TEXT[] DEFAULT '{}',
  tags                TEXT[] DEFAULT '{}',
  embedding           VECTOR(768),
  metadata            JSONB  NOT NULL DEFAULT '{}'::jsonb,
  reflected           BOOLEAN NOT NULL DEFAULT FALSE,    -- TRUE once a lesson has consumed it
  lesson_id           UUID,                              -- backref to the lesson that distilled it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS experiences_created_idx     ON experiences (created_at DESC);
CREATE INDEX IF NOT EXISTS experiences_outcome_idx     ON experiences (outcome);
CREATE INDEX IF NOT EXISTS experiences_task_type_idx   ON experiences (task_type);
CREATE INDEX IF NOT EXISTS experiences_reflected_idx   ON experiences (reflected);
CREATE INDEX IF NOT EXISTS experiences_embedding_hnsw  ON experiences USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS experiences_summary_fts_idx ON experiences USING gin (to_tsvector('german', summary));

-- ---------------------------------------------------------------------------
-- (2) lessons — distilled patterns extracted from clusters of experiences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson            TEXT NOT NULL,                       -- "When migrating TS configs I underestimate build steps"
  evidence_count    INT  NOT NULL DEFAULT 1,             -- how many episodes back this lesson
  source_ids        UUID[] NOT NULL DEFAULT '{}',        -- experiences that informed it
  embedding         VECTOR(768),
  valence           FLOAT NOT NULL DEFAULT 0,            -- aggregate from sources
  arousal           FLOAT NOT NULL DEFAULT 0,
  confidence        FLOAT NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  category          TEXT NOT NULL DEFAULT 'general',     -- skill|preference|warning|insight|...
  promoted_to_trait BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lessons_embedding_hnsw  ON lessons USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS lessons_evidence_idx    ON lessons (evidence_count DESC);
CREATE INDEX IF NOT EXISTS lessons_created_idx     ON lessons (created_at DESC);

-- backref FK from experience -> lesson (added after lessons table exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'experiences_lesson_id_fkey'
  ) THEN
    ALTER TABLE experiences
      ADD CONSTRAINT experiences_lesson_id_fkey
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (3) soul_traits — the stable, repeatedly-reinforced "personality" layer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soul_traits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trait           TEXT NOT NULL,                          -- "tends toward over-caution on DB migrations"
  polarity        FLOAT NOT NULL DEFAULT 0,               -- -1 (weakness) .. +1 (strength)
  evidence_count  INT  NOT NULL DEFAULT 1,
  source_lesson_ids UUID[] NOT NULL DEFAULT '{}',
  embedding       VECTOR(768),
  confidence      FLOAT NOT NULL DEFAULT 0.5,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS soul_traits_embedding_hnsw ON soul_traits USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS soul_traits_evidence_idx   ON soul_traits (evidence_count DESC);

-- ---------------------------------------------------------------------------
-- (4) RPC: record_experience — insert a new episode, link to similar past ones
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_experience(
  p_summary           TEXT,
  p_embedding         VECTOR(768),
  p_session_id        TEXT    DEFAULT NULL,
  p_task_type         TEXT    DEFAULT NULL,
  p_details           TEXT    DEFAULT NULL,
  p_outcome           TEXT    DEFAULT 'unknown',
  p_difficulty        FLOAT   DEFAULT 0.5,
  p_confidence_before FLOAT   DEFAULT NULL,
  p_confidence_after  FLOAT   DEFAULT NULL,
  p_user_sentiment    TEXT    DEFAULT NULL,
  p_valence           FLOAT   DEFAULT 0,
  p_arousal           FLOAT   DEFAULT 0,
  p_what_worked       TEXT    DEFAULT NULL,
  p_what_failed       TEXT    DEFAULT NULL,
  p_tools_used        TEXT[]  DEFAULT '{}',
  p_tags              TEXT[]  DEFAULT '{}',
  p_metadata          JSONB   DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO experiences (
    summary, embedding, session_id, task_type, details, outcome,
    difficulty, confidence_before, confidence_after, user_sentiment,
    valence, arousal, what_worked, what_failed, tools_used, tags, metadata
  ) VALUES (
    p_summary, p_embedding, p_session_id, p_task_type, p_details, p_outcome,
    p_difficulty, p_confidence_before, p_confidence_after, p_user_sentiment,
    p_valence, p_arousal, p_what_worked, p_what_failed, p_tools_used, p_tags, p_metadata
  )
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- (5) RPC: recall_experiences — semantic search over episodes (+ optional lessons)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recall_experiences(
  query_embedding VECTOR(768),
  query_text      TEXT  DEFAULT '',
  match_count     INT   DEFAULT 8,
  filter_outcome  TEXT  DEFAULT NULL,
  include_lessons BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  kind            TEXT,        -- 'experience' | 'lesson'
  id              UUID,
  content         TEXT,
  outcome         TEXT,
  difficulty      FLOAT,
  valence         FLOAT,
  arousal         FLOAT,
  similarity      FLOAT,
  evidence_count  INT,
  created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH ex AS (
    SELECT
      'experience'::TEXT                            AS kind,
      e.id,
      e.summary                                     AS content,
      e.outcome,
      e.difficulty,
      e.valence,
      e.arousal,
      (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity,
      1                                             AS evidence_count,
      e.created_at
    FROM experiences e
    WHERE e.embedding IS NOT NULL
      AND (filter_outcome IS NULL OR e.outcome = filter_outcome)
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count
  ),
  ls AS (
    SELECT
      'lesson'::TEXT                                AS kind,
      l.id,
      l.lesson                                      AS content,
      NULL::TEXT                                    AS outcome,
      NULL::FLOAT                                   AS difficulty,
      l.valence,
      l.arousal,
      (1 - (l.embedding <=> query_embedding))::FLOAT AS similarity,
      l.evidence_count,
      l.created_at
    FROM lessons l
    WHERE include_lessons AND l.embedding IS NOT NULL
    ORDER BY l.embedding <=> query_embedding
    LIMIT GREATEST(match_count / 2, 3)
  )
  SELECT * FROM ex
  UNION ALL
  SELECT * FROM ls
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- (6) RPC: find_experience_clusters — REM-sleep clustering of unreflected episodes
--     Returns cluster seeds (one experience per cluster) plus member ids,
--     so the LLM client can synthesise a lesson from each cluster.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_experience_clusters(
  similarity_threshold FLOAT DEFAULT 0.85,
  min_cluster_size     INT   DEFAULT 2,
  max_age_days         INT   DEFAULT 30
)
RETURNS TABLE (
  seed_id        UUID,
  seed_summary   TEXT,
  member_ids     UUID[],
  member_count   INT,
  avg_difficulty FLOAT,
  avg_valence    FLOAT,
  outcomes       TEXT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  used UUID[] := ARRAY[]::UUID[];
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
      count(*),
      avg(e.difficulty),
      avg(e.valence),
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
      RETURN NEXT;
    ELSE
      used := used || ARRAY[rec.id];
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- (7) RPC: record_lesson — store a synthesised lesson + mark sources reflected
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_lesson(
  p_lesson      TEXT,
  p_embedding   VECTOR(768),
  p_source_ids  UUID[],
  p_category    TEXT  DEFAULT 'general',
  p_confidence  FLOAT DEFAULT 0.6
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
    valence, arousal, evidence_count
  ) VALUES (
    p_lesson, p_embedding, p_source_ids, p_category, p_confidence,
    COALESCE(agg_val, 0), COALESCE(agg_aro, 0), GREATEST(ev_count, 1)
  )
  RETURNING id INTO new_id;

  UPDATE experiences
     SET reflected = TRUE,
         lesson_id = new_id
   WHERE id = ANY(p_source_ids);

  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- (8) RPC: reinforce_lesson — when a new cluster matches an existing lesson
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reinforce_lesson(
  p_lesson_id  UUID,
  p_source_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE lessons
     SET evidence_count = evidence_count + array_length(p_source_ids, 1),
         source_ids     = source_ids || p_source_ids,
         confidence     = LEAST(confidence + 0.05, 1.0),
         updated_at     = NOW()
   WHERE id = p_lesson_id;

  UPDATE experiences
     SET reflected = TRUE,
         lesson_id = p_lesson_id
   WHERE id = ANY(p_source_ids);
END;
$$;

-- ---------------------------------------------------------------------------
-- (9) RPC: promote_lesson_to_trait — when a lesson has enough evidence
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION promote_lesson_to_trait(
  p_lesson_id  UUID,
  p_trait      TEXT,
  p_polarity   FLOAT DEFAULT 0,
  p_embedding  VECTOR(768) DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  new_id    UUID;
  l_record  RECORD;
BEGIN
  SELECT * INTO l_record FROM lessons WHERE id = p_lesson_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lesson % not found', p_lesson_id;
  END IF;

  INSERT INTO soul_traits (
    trait, polarity, evidence_count, source_lesson_ids,
    embedding, confidence
  ) VALUES (
    p_trait,
    p_polarity,
    l_record.evidence_count,
    ARRAY[p_lesson_id],
    COALESCE(p_embedding, l_record.embedding),
    LEAST(l_record.confidence + 0.1, 1.0)
  )
  RETURNING id INTO new_id;

  UPDATE lessons SET promoted_to_trait = TRUE WHERE id = p_lesson_id;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- (10) RPC: soul_stats — single-roundtrip snapshot for the dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION soul_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'experiences',     (SELECT count(*) FROM experiences),
        'lessons',         (SELECT count(*) FROM lessons),
        'traits',          (SELECT count(*) FROM soul_traits),
        'unreflected',     (SELECT count(*) FROM experiences WHERE reflected = FALSE),
        'avg_difficulty',  (SELECT COALESCE(avg(difficulty), 0) FROM experiences),
        'avg_valence',     (SELECT COALESCE(avg(valence),    0) FROM experiences),
        'success_rate',    (SELECT CASE WHEN count(*) > 0
                              THEN count(*) FILTER (WHERE outcome = 'success')::FLOAT / count(*)
                              ELSE 0 END FROM experiences WHERE outcome <> 'unknown')
      )
    ),
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
          'id',         id,
          'summary',    summary,
          'task_type',  task_type,
          'outcome',    outcome,
          'difficulty', difficulty,
          'valence',    valence,
          'sentiment',  user_sentiment,
          'reflected',  reflected,
          'created_at', created_at
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
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permissions: anon (used by dashboard via service-role JWT proxy) + service_role
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON experiences TO anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON lessons     TO anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON soul_traits TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON experiences TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON lessons     TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON soul_traits TO service_role;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION record_experience(TEXT, VECTOR(768), TEXT, TEXT, TEXT, TEXT, FLOAT, FLOAT, FLOAT, TEXT, FLOAT, FLOAT, TEXT, TEXT, TEXT[], TEXT[], JSONB) TO anon, service_role;
GRANT EXECUTE ON FUNCTION recall_experiences(VECTOR(768), TEXT, INT, TEXT, BOOLEAN) TO anon, service_role;
GRANT EXECUTE ON FUNCTION find_experience_clusters(FLOAT, INT, INT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION record_lesson(TEXT, VECTOR(768), UUID[], TEXT, FLOAT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION reinforce_lesson(UUID, UUID[]) TO anon, service_role;
GRANT EXECUTE ON FUNCTION promote_lesson_to_trait(UUID, TEXT, FLOAT, VECTOR(768)) TO anon, service_role;
GRANT EXECUTE ON FUNCTION soul_stats() TO anon, service_role;

-- ---------------------------------------------------------------------------
-- Optional cron: nudge for reflection pass (just logs unreflected count;
-- the actual synthesis must run client-side because it needs the LLM).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'vectormemory_soul_unreflected_check';
    PERFORM cron.schedule(
      'vectormemory_soul_unreflected_check',
      '0 4 * * *',
      $sql$SELECT count(*) FROM experiences WHERE reflected = FALSE;$sql$
    );
  END IF;
END $$;
