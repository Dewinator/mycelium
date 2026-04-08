-- dashboard_stats v2: adds time-series, health, link density, retention curve.
-- Replaces v1 in 012. Single round-trip; backwards-compatible (all v1 fields kept).

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
    -- last 30 days, daily memory creation count (zero-filled).
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
    -- retention curve: how many memories still have strength >= threshold,
    -- as a function of "age days bucket" since last access. Useful to *see*
    -- the decay model in action.
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
          'id',           id,
          'content',      LEFT(content, 200),
          'category',     category,
          'tags',         tags,
          'stage',        stage,
          'strength',     strength,
          'importance',   importance,
          'access_count', access_count,
          'useful_count', useful_count,
          'pinned',       pinned,
          'created_at',   created_at
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
          'id',           id,
          'content',      LEFT(content, 160),
          'category',     category,
          'strength',     strength,
          'access_count', access_count,
          'useful_count', useful_count
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
