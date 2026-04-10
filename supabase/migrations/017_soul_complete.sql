-- 017_soul_complete.sql — closes the five conceptual gaps that separate
-- a memory store from a soul.
--
-- Layers added:
--   1. mood          — rolling emotional state derived from recent episodes
--   2. intentions    — forward-looking will (what the soul wants)
--   3. people        — relationship layer (who it has lived through things with)
--   4. conflicts     — inner contradictions between traits, with resolution
--   5. prime/narrate — output channels that turn the soul into a context block
--                      and a first-person narration
--
-- Design principles:
--   - All embeddings live in the same VECTOR(768) space as memories/experiences
--     so cross-layer similarity is meaningful.
--   - All RPCs are idempotent (DROP IF EXISTS first where signatures may evolve).
--   - record_experience itself is not modified — instead, sibling RPCs
--     (attach_person_to_experience, evaluate_intentions_for_experience)
--     compose with it from the application layer.

-- ===========================================================================
-- (1) MOOD — derived state, no storage needed
-- ===========================================================================
DROP FUNCTION IF EXISTS current_mood(INT);
CREATE OR REPLACE FUNCTION current_mood(window_hours INT DEFAULT 24)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v FLOAT;
  a FLOAT;
  n INT;
  label TEXT;
BEGIN
  SELECT COALESCE(avg(valence), 0)::FLOAT,
         COALESCE(avg(arousal), 0)::FLOAT,
         count(*)::INT
    INTO v, a, n
  FROM experiences
  WHERE created_at >= NOW() - (window_hours || ' hours')::INTERVAL;

  -- Russell's circumplex compressed to a small label set.
  IF n = 0 THEN
    label := 'neutral';
  ELSIF v >  0.30 AND a >  0.55 THEN label := 'elated';
  ELSIF v >  0.30 AND a <  0.30 THEN label := 'content';
  ELSIF v >  0.15                THEN label := 'pleased';
  ELSIF v < -0.30 AND a >  0.55 THEN label := 'tense';
  ELSIF v < -0.30 AND a <  0.30 THEN label := 'drained';
  ELSIF v < -0.15                THEN label := 'frustrated';
  ELSIF a >  0.55                THEN label := 'activated';
  ELSE                                label := 'neutral';
  END IF;

  RETURN jsonb_build_object(
    'window_hours', window_hours,
    'n',            n,
    'valence',      v,
    'arousal',      a,
    'label',        label,
    'computed_at',  NOW()
  );
END;
$$;

-- 24h timeline of mood (one bucket per hour) for the dashboard sparkline.
CREATE OR REPLACE FUNCTION mood_timeline(hours INT DEFAULT 24)
RETURNS TABLE (
  bucket      TIMESTAMPTZ,
  n           INT,
  avg_valence FLOAT,
  avg_arousal FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    date_trunc('hour', d) AS bucket,
    COALESCE((SELECT count(*)::INT FROM experiences
              WHERE date_trunc('hour', created_at) = date_trunc('hour', d)), 0) AS n,
    COALESCE((SELECT avg(valence)::FLOAT FROM experiences
              WHERE date_trunc('hour', created_at) = date_trunc('hour', d)), 0) AS avg_valence,
    COALESCE((SELECT avg(arousal)::FLOAT FROM experiences
              WHERE date_trunc('hour', created_at) = date_trunc('hour', d)), 0) AS avg_arousal
  FROM generate_series(
    date_trunc('hour', NOW() - (hours || ' hours')::INTERVAL),
    date_trunc('hour', NOW()),
    INTERVAL '1 hour'
  ) d
  ORDER BY bucket;
$$;

-- ===========================================================================
-- (2) INTENTIONS — what the soul wants
-- ===========================================================================
CREATE TABLE IF NOT EXISTS intentions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intention       TEXT NOT NULL,         -- "ich will gründlicher werden bei migrations"
  embedding       VECTOR(768),
  status          TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'fulfilled', 'abandoned', 'paused')),
  priority        FLOAT NOT NULL DEFAULT 0.5 CHECK (priority BETWEEN 0 AND 1),
  progress        FLOAT NOT NULL DEFAULT 0   CHECK (progress BETWEEN 0 AND 1),
  evidence_count  INT  NOT NULL DEFAULT 0,
  evidence_ids    UUID[] NOT NULL DEFAULT '{}',
  target_date     DATE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evidence_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS intentions_embedding_hnsw ON intentions USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS intentions_status_idx     ON intentions (status);
CREATE INDEX IF NOT EXISTS intentions_priority_idx   ON intentions (priority DESC);

CREATE OR REPLACE FUNCTION set_intention(
  p_intention TEXT,
  p_embedding VECTOR(768),
  p_priority  FLOAT DEFAULT 0.5,
  p_target_date DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO intentions (intention, embedding, priority, target_date)
  VALUES (p_intention, p_embedding, p_priority, p_target_date)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_intention_status(
  p_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE intentions
     SET status = p_status,
         progress = CASE WHEN p_status = 'fulfilled' THEN 1.0 ELSE progress END,
         updated_at = NOW()
   WHERE id = p_id;
$$;

-- For each new experience, find active intentions whose embedding is close.
-- Bumps progress by a small step and records evidence. Returns count touched.
CREATE OR REPLACE FUNCTION evaluate_intentions_for_experience(
  p_experience_id UUID,
  p_embedding     VECTOR(768),
  p_threshold     FLOAT DEFAULT 0.65,
  p_step          FLOAT DEFAULT 0.10
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  touched INT := 0;
  rec     RECORD;
BEGIN
  FOR rec IN
    SELECT id, progress
      FROM intentions
     WHERE status = 'active'
       AND embedding IS NOT NULL
       AND (1 - (embedding <=> p_embedding)) >= p_threshold
  LOOP
    UPDATE intentions
       SET progress         = LEAST(rec.progress + p_step, 1.0),
           evidence_count   = evidence_count + 1,
           evidence_ids     = evidence_ids || ARRAY[p_experience_id],
           last_evidence_at = NOW(),
           updated_at       = NOW(),
           status           = CASE WHEN rec.progress + p_step >= 1.0 THEN 'fulfilled' ELSE status END
     WHERE id = rec.id;
    touched := touched + 1;
  END LOOP;
  RETURN touched;
END;
$$;

CREATE OR REPLACE FUNCTION recall_intentions(
  query_embedding VECTOR(768) DEFAULT NULL,
  filter_status   TEXT        DEFAULT 'active',
  match_count     INT         DEFAULT 10
)
RETURNS TABLE (
  id             UUID,
  intention      TEXT,
  status         TEXT,
  priority       FLOAT,
  progress       FLOAT,
  evidence_count INT,
  similarity     FLOAT,
  target_date    DATE,
  created_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF query_embedding IS NULL THEN
    RETURN QUERY
    SELECT i.id, i.intention, i.status, i.priority, i.progress,
           i.evidence_count, NULL::FLOAT, i.target_date, i.created_at
      FROM intentions i
     WHERE (filter_status IS NULL OR i.status = filter_status)
     ORDER BY i.priority DESC, i.created_at DESC
     LIMIT match_count;
  ELSE
    RETURN QUERY
    SELECT i.id, i.intention, i.status, i.priority, i.progress,
           i.evidence_count,
           (1 - (i.embedding <=> query_embedding))::FLOAT,
           i.target_date, i.created_at
      FROM intentions i
     WHERE (filter_status IS NULL OR i.status = filter_status)
       AND i.embedding IS NOT NULL
     ORDER BY i.embedding <=> query_embedding
     LIMIT match_count;
  END IF;
END;
$$;

-- ===========================================================================
-- (3) PEOPLE — relationship layer
-- ===========================================================================
CREATE TABLE IF NOT EXISTS people (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  aliases       TEXT[] NOT NULL DEFAULT '{}',
  description   TEXT,
  embedding     VECTOR(768),                   -- over name + description
  relationship  TEXT,                          -- "user", "collaborator", "self", ...
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  encounter_count INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS people_name_lower_uidx ON people (lower(name));
CREATE INDEX IF NOT EXISTS people_embedding_hnsw ON people USING hnsw (embedding vector_cosine_ops);

ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS experiences_person_idx ON experiences (person_id);

-- Resolve a person by name (case-insensitive) or alias; create if missing.
-- Embedding param is optional — if NULL, no embedding is set yet (the
-- application can backfill via update_person_embedding once it has one).
CREATE OR REPLACE FUNCTION resolve_or_create_person(
  p_name        TEXT,
  p_description TEXT DEFAULT NULL,
  p_embedding   VECTOR(768) DEFAULT NULL,
  p_relationship TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  found_id UUID;
BEGIN
  SELECT id INTO found_id
    FROM people
   WHERE lower(name) = lower(p_name)
      OR lower(p_name) = ANY(SELECT lower(unnest(aliases)))
   LIMIT 1;

  IF found_id IS NOT NULL THEN
    -- Reuse existing; do NOT bump encounter_count here. The caller
    -- (attach_person_to_experience) is the single source of truth for that.
    UPDATE people
       SET last_seen_at = NOW(),
           description  = COALESCE(description,  p_description),
           embedding    = COALESCE(embedding,    p_embedding),
           relationship = COALESCE(relationship, p_relationship)
     WHERE id = found_id;
    RETURN found_id;
  END IF;

  -- Create at zero; the caller (typically attach_person_to_experience) bumps it.
  INSERT INTO people (name, description, embedding, relationship, encounter_count)
  VALUES (p_name, p_description, p_embedding, p_relationship, 0)
  RETURNING id INTO found_id;
  RETURN found_id;
END;
$$;

CREATE OR REPLACE FUNCTION attach_person_to_experience(
  p_experience_id UUID,
  p_person_id     UUID
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE experiences SET person_id = p_person_id WHERE id = p_experience_id;
  UPDATE people
     SET last_seen_at    = NOW(),
         encounter_count = encounter_count + 1
   WHERE id = p_person_id;
$$;

-- Recall the relationship history with a person: how it has gone, mood mix.
CREATE OR REPLACE FUNCTION recall_person(p_person_id UUID, p_limit INT DEFAULT 10)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'person', (SELECT row_to_json(p) FROM people p WHERE p.id = p_person_id),
    'totals', (
      SELECT jsonb_build_object(
        'experiences',  count(*),
        'avg_valence',  COALESCE(avg(valence),    0),
        'avg_arousal',  COALESCE(avg(arousal),    0),
        'avg_difficulty', COALESCE(avg(difficulty), 0),
        'success_rate', CASE WHEN count(*) FILTER (WHERE outcome <> 'unknown') > 0
                             THEN count(*) FILTER (WHERE outcome = 'success')::FLOAT
                                / count(*) FILTER (WHERE outcome <> 'unknown')
                             ELSE 0 END
      )
      FROM experiences WHERE person_id = p_person_id
    ),
    'recent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id, 'summary', summary, 'outcome', outcome,
        'valence', valence, 'created_at', created_at
      ) ORDER BY created_at DESC), '[]'::jsonb)
      FROM (
        SELECT id, summary, outcome, valence, created_at
          FROM experiences
         WHERE person_id = p_person_id
         ORDER BY created_at DESC
         LIMIT p_limit
      ) sub
    )
  ) INTO result;
  RETURN result;
END;
$$;

-- ===========================================================================
-- (4) CONFLICTS — inner contradictions between traits
-- ===========================================================================
ALTER TABLE soul_traits
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS supersedes UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS soul_traits_archived_idx ON soul_traits (archived);

-- A conflict is a pair of (active) traits whose embeddings are similar
-- but whose polarities meaningfully disagree. Lower-similarity threshold
-- on purpose: contradictions live in the *adjacent* concept space.
DROP FUNCTION IF EXISTS find_trait_conflicts(FLOAT, FLOAT);
CREATE OR REPLACE FUNCTION find_trait_conflicts(
  similarity_threshold FLOAT DEFAULT 0.65,
  polarity_gap         FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  a_id          UUID,
  a_trait       TEXT,
  a_polarity    FLOAT,
  a_evidence    INT,
  b_id          UUID,
  b_trait       TEXT,
  b_polarity    FLOAT,
  b_evidence    INT,
  similarity    FLOAT,
  polarity_diff FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t1.id, t1.trait, t1.polarity, t1.evidence_count,
    t2.id, t2.trait, t2.polarity, t2.evidence_count,
    (1 - (t1.embedding <=> t2.embedding))::FLOAT AS similarity,
    abs(t1.polarity - t2.polarity)::FLOAT       AS polarity_diff
  FROM soul_traits t1
  JOIN soul_traits t2
    ON t1.id < t2.id
   AND t1.archived = FALSE
   AND t2.archived = FALSE
   AND t1.embedding IS NOT NULL
   AND t2.embedding IS NOT NULL
  WHERE (1 - (t1.embedding <=> t2.embedding)) >= similarity_threshold
    AND abs(t1.polarity - t2.polarity)        >= polarity_gap
  ORDER BY abs(t1.polarity - t2.polarity) DESC, similarity DESC
  LIMIT 20;
$$;

-- Resolution: archive the loser, bump winner's evidence by absorbed amount.
CREATE OR REPLACE FUNCTION resolve_trait_conflict(
  p_winner_id UUID,
  p_loser_id  UUID
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE soul_traits
     SET evidence_count    = soul_traits.evidence_count
                              + (SELECT evidence_count FROM soul_traits WHERE id = p_loser_id),
         confidence        = LEAST(confidence + 0.05, 1.0),
         last_reinforced_at = NOW(),
         supersedes        = supersedes || ARRAY[p_loser_id]
   WHERE id = p_winner_id;
  UPDATE soul_traits SET archived = TRUE WHERE id = p_loser_id;
$$;

-- Synthesis: create a new trait that supersedes both, archive the parents.
CREATE OR REPLACE FUNCTION synthesize_trait_conflict(
  p_a_id      UUID,
  p_b_id      UUID,
  p_new_trait TEXT,
  p_polarity  FLOAT,
  p_embedding VECTOR(768)
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  new_id UUID;
  ev INT;
BEGIN
  SELECT COALESCE(sum(evidence_count), 1)::INT INTO ev
    FROM soul_traits WHERE id IN (p_a_id, p_b_id);

  INSERT INTO soul_traits (
    trait, polarity, evidence_count, source_lesson_ids,
    embedding, confidence, supersedes
  ) VALUES (
    p_new_trait,
    p_polarity,
    ev,
    (SELECT array_agg(DISTINCT s) FROM (
       SELECT unnest(source_lesson_ids) AS s FROM soul_traits WHERE id IN (p_a_id, p_b_id)
     ) x WHERE s IS NOT NULL),
    p_embedding,
    0.75,
    ARRAY[p_a_id, p_b_id]
  )
  RETURNING id INTO new_id;

  UPDATE soul_traits SET archived = TRUE WHERE id IN (p_a_id, p_b_id);
  RETURN new_id;
END;
$$;

-- ===========================================================================
-- (5) PRIME / NARRATE — output channels
-- ===========================================================================

-- Single round-trip: everything the soul wants the agent to know about itself
-- before the next turn. The MCP tool layer combines this with a semantic
-- recall_experiences pass when a task description is provided.
CREATE OR REPLACE FUNCTION prime_context_static()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'mood', current_mood(24),
    'top_traits', (
      SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'weight')::float DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'trait', trait, 'polarity', polarity,
          'evidence_count', evidence_count,
          -- weighted importance: evidence × (1 + |polarity|)
          'weight', evidence_count * (1 + abs(polarity))
        ) AS t
        FROM soul_traits
        WHERE archived = FALSE
        ORDER BY evidence_count * (1 + abs(polarity)) DESC
        LIMIT 8
      ) sub
    ),
    'active_intentions', (
      SELECT COALESCE(jsonb_agg(i ORDER BY (i->>'priority')::float DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'intention', intention,
          'priority', priority, 'progress', progress,
          'evidence_count', evidence_count,
          'target_date', target_date
        ) AS i
        FROM intentions
        WHERE status = 'active'
        ORDER BY priority DESC, created_at DESC
        LIMIT 5
      ) sub
    ),
    'open_conflicts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'a_trait', a_trait, 'a_polarity', a_polarity,
        'b_trait', b_trait, 'b_polarity', b_polarity,
        'similarity', similarity,
        'polarity_diff', polarity_diff
      )), '[]'::jsonb)
      FROM find_trait_conflicts(0.65, 0.5)
    ),
    'recent_pattern', (
      SELECT jsonb_build_object(
        'last_n', count(*),
        'success_rate',
          CASE WHEN count(*) FILTER (WHERE outcome <> 'unknown') > 0
               THEN count(*) FILTER (WHERE outcome = 'success')::FLOAT
                  / count(*) FILTER (WHERE outcome <> 'unknown')
               ELSE NULL END,
        'avg_difficulty', COALESCE(avg(difficulty), 0)
      )
      FROM (SELECT * FROM experiences ORDER BY created_at DESC LIMIT 10) recent
    ),
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

-- A self-narration: structured input for the LLM to render as first-person prose.
CREATE OR REPLACE FUNCTION narrate_self()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'mood', current_mood(24),
    'identity_traits', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'trait', trait, 'polarity', polarity, 'evidence_count', evidence_count
      ) ORDER BY evidence_count DESC), '[]'::jsonb)
      FROM soul_traits WHERE archived = FALSE LIMIT 10
    ),
    'aspirations', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'intention', intention, 'priority', priority, 'progress', progress
      ) ORDER BY priority DESC), '[]'::jsonb)
      FROM intentions WHERE status = 'active' LIMIT 5
    ),
    'recent_lessons', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'lesson', lesson, 'evidence_count', evidence_count
      )), '[]'::jsonb)
      FROM (SELECT * FROM lessons ORDER BY updated_at DESC LIMIT 5) sub
    ),
    'closest_relationships', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', name, 'relationship', relationship,
        'encounter_count', encounter_count,
        'last_seen_at', last_seen_at
      ) ORDER BY encounter_count DESC), '[]'::jsonb)
      FROM (SELECT * FROM people ORDER BY encounter_count DESC LIMIT 5) sub
    ),
    'inner_tensions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'a', a_trait, 'b', b_trait, 'gap', polarity_diff
      )), '[]'::jsonb)
      FROM find_trait_conflicts(0.65, 0.5)
    ),
    'drift_7d', soul_drift(7),
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

-- ===========================================================================
-- soul_stats v3 — expose mood, intentions, people, conflicts in dashboard payload
-- ===========================================================================
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
        'traits',          (SELECT count(*) FROM soul_traits WHERE archived = FALSE),
        'archived_traits', (SELECT count(*) FROM soul_traits WHERE archived = TRUE),
        'intentions_active',    (SELECT count(*) FROM intentions WHERE status = 'active'),
        'intentions_fulfilled', (SELECT count(*) FROM intentions WHERE status = 'fulfilled'),
        'people',          (SELECT count(*) FROM people),
        'conflicts',       (SELECT count(*) FROM find_trait_conflicts(0.65, 0.5)),
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
    'mood',          current_mood(24),
    'mood_timeline', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'bucket', bucket, 'n', n,
                       'avg_valence', avg_valence, 'avg_arousal', avg_arousal
                     ) ORDER BY bucket), '[]'::jsonb) FROM mood_timeline(24)),
    'drift', soul_drift(7),
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
               COALESCE((SELECT count(*) FROM experiences WHERE created_at::date = d::date), 0) AS cnt,
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
          'person_id',    person_id,
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
          'id', id, 'lesson', lesson, 'category', category,
          'evidence_count', evidence_count, 'confidence', confidence,
          'valence', valence, 'created_at', created_at,
          'promoted', promoted_to_trait
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
          'id', id, 'lesson', lesson,
          'evidence_count', evidence_count, 'confidence', confidence
        ) AS r
        FROM find_promotion_candidates(4, 0.7)
      ) sub
    ),
    'traits', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'evidence_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'trait', trait, 'polarity', polarity,
          'evidence_count', evidence_count, 'confidence', confidence,
          'first_seen_at', first_seen_at, 'last_reinforced_at', last_reinforced_at,
          'archived', archived
        ) AS r
        FROM soul_traits
        WHERE archived = FALSE
        ORDER BY evidence_count DESC
        LIMIT 20
      ) sub
    ),
    'most_useful_experiences', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'useful_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'summary', summary,
          'useful_count', useful_count, 'outcome', outcome
        ) AS r
        FROM experiences
        WHERE useful_count > 0
        ORDER BY useful_count DESC
        LIMIT 8
      ) sub
    ),
    'intentions', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'priority')::float DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'intention', intention, 'status', status,
          'priority', priority, 'progress', progress,
          'evidence_count', evidence_count, 'target_date', target_date,
          'created_at', created_at
        ) AS r
        FROM intentions
        ORDER BY status, priority DESC
        LIMIT 20
      ) sub
    ),
    'people', (
      SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'encounter_count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', id, 'name', name, 'relationship', relationship,
          'encounter_count', encounter_count,
          'first_seen_at', first_seen_at, 'last_seen_at', last_seen_at
        ) AS r
        FROM people
        ORDER BY encounter_count DESC
        LIMIT 12
      ) sub
    ),
    'conflicts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'a_id', a_id, 'a_trait', a_trait, 'a_polarity', a_polarity, 'a_evidence', a_evidence,
        'b_id', b_id, 'b_trait', b_trait, 'b_polarity', b_polarity, 'b_evidence', b_evidence,
        'similarity', similarity, 'polarity_diff', polarity_diff
      )), '[]'::jsonb)
      FROM find_trait_conflicts(0.65, 0.5)
    ),
    'narrative', narrate_self(),
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON intentions TO anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON people     TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON intentions TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON people     TO service_role;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION current_mood(INT)                                              TO anon, service_role;
GRANT EXECUTE ON FUNCTION mood_timeline(INT)                                             TO anon, service_role;
GRANT EXECUTE ON FUNCTION set_intention(TEXT, VECTOR(768), FLOAT, DATE)                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION update_intention_status(UUID, TEXT)                            TO anon, service_role;
GRANT EXECUTE ON FUNCTION evaluate_intentions_for_experience(UUID, VECTOR(768), FLOAT, FLOAT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION recall_intentions(VECTOR(768), TEXT, INT)                      TO anon, service_role;
GRANT EXECUTE ON FUNCTION resolve_or_create_person(TEXT, TEXT, VECTOR(768), TEXT)        TO anon, service_role;
GRANT EXECUTE ON FUNCTION attach_person_to_experience(UUID, UUID)                        TO anon, service_role;
GRANT EXECUTE ON FUNCTION recall_person(UUID, INT)                                       TO anon, service_role;
GRANT EXECUTE ON FUNCTION find_trait_conflicts(FLOAT, FLOAT)                             TO anon, service_role;
GRANT EXECUTE ON FUNCTION resolve_trait_conflict(UUID, UUID)                             TO anon, service_role;
GRANT EXECUTE ON FUNCTION synthesize_trait_conflict(UUID, UUID, TEXT, FLOAT, VECTOR(768)) TO anon, service_role;
GRANT EXECUTE ON FUNCTION prime_context_static()                                         TO anon, service_role;
GRANT EXECUTE ON FUNCTION narrate_self()                                                 TO anon, service_role;
