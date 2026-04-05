-- Hybrid search: combines vector similarity (cosine) with full-text search (BM25)
-- Default weight: 70% vector, 30% full-text (matches openClaw defaults)
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(768),
  query_text TEXT DEFAULT '',
  match_count INT DEFAULT 10,
  filter_category TEXT DEFAULT NULL,
  vector_weight FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  category TEXT,
  tags TEXT[],
  metadata JSONB,
  source TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      m.id,
      m.content,
      m.category,
      m.tags,
      m.metadata,
      m.source,
      m.created_at,
      1 - (m.embedding <=> query_embedding) AS vector_score
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (filter_category IS NULL OR m.category = filter_category)
  ),
  fts_results AS (
    SELECT
      m.id,
      ts_rank(to_tsvector('german', m.content), plainto_tsquery('german', query_text)) AS fts_score
    FROM memories m
    WHERE query_text != ''
      AND to_tsvector('german', m.content) @@ plainto_tsquery('german', query_text)
      AND (filter_category IS NULL OR m.category = filter_category)
  )
  SELECT
    vr.id,
    vr.content,
    vr.category,
    vr.tags,
    vr.metadata,
    vr.source,
    (
      vector_weight * vr.vector_score +
      (1 - vector_weight) * COALESCE(fr.fts_score, 0)
    )::FLOAT AS similarity,
    vr.created_at
  FROM vector_results vr
  LEFT JOIN fts_results fr ON vr.id = fr.id
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
