-- 060_scope_aware_recall.sql — Layer-0 (Bedrock) + Layer-1 (per-role) recall.
--
-- Context (Reed 2026-04-26 Identity-Pivot):
--   Each role gets its own brain (per-role project_id). Privacy by default,
--   shared knowledge only via Bedrock (pinned memories) or explicit bridges.
--
-- This migration extends `match_memories_cognitive` with two optional
-- parameters; when both are at their defaults, behaviour is unchanged
-- (= today's "everyone sees everything"), so existing callers keep working.
--
--   p_project_id            UUID    DEFAULT NULL
--     If NULL → no scope filter (legacy behaviour).
--     If set  → only memories with this project_id are visible.
--
--   p_include_pinned_global BOOLEAN DEFAULT TRUE
--     When p_project_id is set, also include pinned memories outside the
--     scope (= Bedrock). Default ON because pinned IS the explicit signal
--     "every role should know this".
--
-- The combined visibility predicate becomes:
--   (p_project_id IS NULL
--    OR m.project_id IS NOT DISTINCT FROM p_project_id
--    OR (p_include_pinned_global AND m.pinned))
--
-- We DROP + CREATE rather than CREATE OR REPLACE because adding parameters
-- changes the function signature, which OR REPLACE cannot do in PostgreSQL.

DROP FUNCTION IF EXISTS match_memories_cognitive(VECTOR(768), TEXT, INT, TEXT, FLOAT, BOOLEAN);

CREATE OR REPLACE FUNCTION match_memories_cognitive(
  query_embedding         VECTOR(768),
  query_text              TEXT    DEFAULT '',
  match_count             INT     DEFAULT 10,
  filter_category         TEXT    DEFAULT NULL,
  vector_weight           FLOAT   DEFAULT 0.6,
  include_archived        BOOLEAN DEFAULT FALSE,
  p_project_id            UUID    DEFAULT NULL,
  p_include_pinned_global BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  id               UUID,
  content          TEXT,
  category         TEXT,
  tags             TEXT[],
  metadata         JSONB,
  source           TEXT,
  stage            TEXT,
  strength         FLOAT,
  importance       FLOAT,
  access_count     INT,
  pinned           BOOLEAN,
  relevance        FLOAT,
  strength_now     FLOAT,
  salience         FLOAT,
  effective_score  FLOAT,
  created_at       TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      m.id,
      1 - (m.embedding <=> query_embedding) AS vector_score
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (include_archived OR m.stage <> 'archived')
      AND (filter_category IS NULL OR m.category = filter_category)
      AND (
        p_project_id IS NULL
        OR m.project_id IS NOT DISTINCT FROM p_project_id
        OR (p_include_pinned_global AND m.pinned)
      )
    ORDER BY m.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 5, 50)
  ),
  fts_results AS (
    SELECT
      m.id,
      ts_rank(to_tsvector('german', m.content), plainto_tsquery('german', query_text)) AS fts_score
    FROM memories m
    WHERE query_text <> ''
      AND to_tsvector('german', m.content) @@ plainto_tsquery('german', query_text)
      AND (include_archived OR m.stage <> 'archived')
      AND (filter_category IS NULL OR m.category = filter_category)
      AND (
        p_project_id IS NULL
        OR m.project_id IS NOT DISTINCT FROM p_project_id
        OR (p_include_pinned_global AND m.pinned)
      )
  ),
  scored AS (
    SELECT
      m.id,
      m.content,
      m.category,
      m.tags,
      m.metadata,
      m.source,
      m.stage,
      m.strength,
      m.importance,
      m.access_count,
      m.pinned,
      m.created_at,
      m.last_accessed_at,
      (vector_weight * vr.vector_score
        + (1 - vector_weight) * COALESCE(fr.fts_score, 0))::FLOAT AS relevance,
      (m.strength
        * exp(
            - GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(m.last_accessed_at, m.created_at))) / 86400.0, 0)
            / NULLIF(m.decay_tau_days * (1 + m.importance), 0)
          )
        * (1 + ln(1 + m.access_count + m.useful_count * 2))
      )::FLOAT AS strength_now,
      (1 + 0.3 * abs(m.valence) + 0.3 * m.arousal + CASE WHEN m.pinned THEN 1 ELSE 0 END)::FLOAT AS salience
    FROM vector_results vr
    JOIN memories m ON m.id = vr.id
    LEFT JOIN fts_results fr ON fr.id = vr.id
  ),
  base_ranked AS (
    SELECT s.*,
           (s.relevance * s.strength_now * s.salience) AS base_score,
           ROW_NUMBER() OVER (ORDER BY (s.relevance * s.strength_now * s.salience) DESC) AS rn
    FROM scored s
  ),
  seeds AS (
    SELECT br.id AS seed_id FROM base_ranked br WHERE br.rn <= 5
  ),
  link_boost AS (
    SELECT br.id AS br_id,
           COALESCE(SUM(ml.weight), 0) AS boost
    FROM base_ranked br
    LEFT JOIN memory_links ml
      ON (ml.a = br.id AND ml.b IN (SELECT seed_id FROM seeds))
      OR (ml.b = br.id AND ml.a IN (SELECT seed_id FROM seeds))
    GROUP BY br.id
  )
  SELECT
    br.id, br.content, br.category, br.tags, br.metadata, br.source, br.stage,
    br.strength, br.importance, br.access_count, br.pinned,
    br.relevance, br.strength_now, br.salience,
    (br.base_score * (1 + 0.20 * lb.boost))::FLOAT AS effective_score,
    br.created_at, br.last_accessed_at
  FROM base_ranked br
  LEFT JOIN link_boost lb ON lb.br_id = br.id
  ORDER BY effective_score DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_memories_cognitive(
  VECTOR(768), TEXT, INT, TEXT, FLOAT, BOOLEAN, UUID, BOOLEAN
) TO anon, service_role;
