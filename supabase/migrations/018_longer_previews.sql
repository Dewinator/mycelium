-- 018_longer_previews.sql — Memories appeared truncated in the dashboard.
-- Storage was always fine (TEXT column, no limit), but dashboard_stats was
-- emitting LEFT(content, 200) for the recent feed and LEFT(content, 160) for
-- the strongest list. This bumps both, and adds a content_length field so
-- the UI can show a "(N chars total)" hint when truncation still applies.
--
-- We also extend the same convention to soul_stats.recent_experiences.

-- ---------------------------------------------------------------------------
-- dashboard_stats v3 — bigger previews + content_length
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dashboard_stats()
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
        'memories',          count(*),
        'with_embedding',    count(embedding),
        'pinned',            count(*) FILTER (WHERE pinned),
        'episodic',          count(*) FILTER (WHERE stage = 'episodic'),
        'semantic',          count(*) FILTER (WHERE stage = 'semantic'),
        'archived',          count(*) FILTER (WHERE stage = 'archived'),
        'avg_strength',      COALESCE(avg(strength), 0),
        'avg_importance',    COALESCE(avg(importance), 0),
        'total_access',      COALESCE(sum(access_count), 0),
        'total_useful',      COALESCE(sum(useful_count), 0)
      )
      FROM memories
    ),
    'links', (
      SELECT jsonb_build_object(
        'count',      count(*),
        'avg_weight', COALESCE(avg(weight), 0),
        'max_weight', COALESCE(max(weight), 0),
        'density',    CASE WHEN (SELECT count(*) FROM memories WHERE stage <> 'archived') > 0
                           THEN count(*)::FLOAT / (SELECT count(*) FROM memories WHERE stage <> 'archived')
                           ELSE 0 END
      )
      FROM memory_links
    ),
    'forgotten', (SELECT count(*) FROM forgotten_memories),
    'health', (
      SELECT jsonb_build_object(
        'oldest_at',          (SELECT min(created_at)       FROM memories),
        'newest_at',          (SELECT max(created_at)       FROM memories),
        'last_access_at',     (SELECT max(last_accessed_at) FROM memories),
        'never_accessed',     (SELECT count(*) FROM memories WHERE last_accessed_at IS NULL AND stage <> 'archived'),
        'without_embedding',  (SELECT count(*) FROM memories WHERE embedding IS NULL),
        'days_since_oldest',  COALESCE(EXTRACT(DAY FROM NOW() - (SELECT min(created_at) FROM memories))::INT, 0)
      )
    ),
    'categories', (
      SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'name',           category,
          'count',          count(*),
          'avg_strength',   avg(strength),
          'avg_importance', avg(importance)
        ) AS c
        FROM memories
        WHERE stage <> 'archived'
        GROUP BY category
      ) sub
    ),
    'tags', (
      SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object('name', tag, 'count', count(*)) AS t
        FROM memories, unnest(tags) AS tag
        WHERE stage <> 'archived'
        GROUP BY tag
        ORDER BY count(*) DESC
        LIMIT 20
      ) sub
    ),
    'strength_histogram', (
      SELECT COALESCE(jsonb_agg(b ORDER BY (b->>'bucket')::int), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'bucket', LEAST(9, FLOOR(strength * 10))::int,
          'count',  count(*)
        ) AS b
        FROM memories
        WHERE stage <> 'archived'
        GROUP BY LEAST(9, FLOOR(strength * 10))::int
      ) sub
    ),
    'timeline', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', day, 'count', cnt) ORDER BY day), '[]'::jsonb)
      FROM (
        SELECT d::date AS day,
               COALESCE((SELECT count(*) FROM memories
                         WHERE created_at::date = d::date), 0) AS cnt
        FROM generate_series(
          (NOW() - INTERVAL '29 days')::date,
          NOW()::date,
          INTERVAL '1 day'
        ) d
      ) sub
    ),
    'retention', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('age_days', age_days, 'avg_strength', avg_s, 'n', n) ORDER BY age_days), '[]'::jsonb)
      FROM (
        SELECT age_days,
               avg(strength)::FLOAT AS avg_s,
               count(*)             AS n
        FROM (
          SELECT LEAST(29, GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(last_accessed_at, created_at))::INT)) AS age_days,
                 strength
          FROM memories
          WHERE stage <> 'archived'
        ) m
        GROUP BY age_days
      ) sub
    ),
    'recent', (
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',             id,
          -- 2000 chars covers ~95% of typical memories without blowing up payload size.
          'content',        LEFT(content, 2000),
          'content_length', length(content),
          'category',       category,
          'tags',           tags,
          'stage',          stage,
          'strength',       strength,
          'importance',     importance,
          'access_count',   access_count,
          'useful_count',   useful_count,
          'pinned',         pinned,
          'created_at',     created_at
        ) AS r
        FROM memories
        WHERE stage <> 'archived'
        ORDER BY created_at DESC
        LIMIT 15
      ) sub
    ),
    'strongest', (
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',             id,
          'content',        LEFT(content, 1200),
          'content_length', length(content),
          'category',       category,
          'strength',       strength,
          'access_count',   access_count,
          'useful_count',   useful_count
        ) AS r
        FROM memories
        WHERE stage <> 'archived'
        ORDER BY strength * (1 + ln(1 + access_count + useful_count * 2)) DESC
        LIMIT 10
      ) sub
    ),
    'generated_at', NOW()
  ) INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION dashboard_stats() TO anon, service_role;

-- ---------------------------------------------------------------------------
-- soul_stats: bump recent_experiences summary handling and add summary_length
-- (Replace only the relevant parts via full re-create — keeping the rest
-- identical to 017's version.)
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
          'id',             id,
          'summary',        LEFT(summary, 2000),
          'summary_length', length(summary),
          'task_type',      task_type,
          'outcome',        outcome,
          'difficulty',     difficulty,
          'valence',        valence,
          'sentiment',      user_sentiment,
          'reflected',      reflected,
          'useful_count',   useful_count,
          'person_id',      person_id,
          'created_at',     created_at
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
          'id', id, 'summary', LEFT(summary, 600), 'summary_length', length(summary),
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

GRANT EXECUTE ON FUNCTION soul_stats() TO anon, service_role;
