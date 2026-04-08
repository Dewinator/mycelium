-- Cognitive memory v2: closes the gaps from the v1 honest review.
-- 1. Spreading activation now influences ranking (not just appended afterward)
-- 2. Retrieval-induced forgetting (interference) when new similar memories are stored
-- 3. Dedup consolidation: similar episodic memories merge into a representative
-- 4. useful_count column — stronger learning signal than mere recall touch

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS useful_count INT NOT NULL DEFAULT 0;

-- forgotten_memories is a LIKE-clone of memories from 007, so any new column on
-- memories must be mirrored here — otherwise INSERT INTO forgotten_memories
-- SELECT m.* fails with "more expressions than target columns".
ALTER TABLE forgotten_memories
  ADD COLUMN IF NOT EXISTS useful_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS memories_useful_count_idx ON memories (useful_count);

-- Grant access on cognitive tables added in 007 to the anon role.
-- (Migration 005 only granted memories, since 007 didn't exist yet.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON memory_links       TO anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON forgotten_memories TO anon;
    GRANT EXECUTE ON FUNCTION match_memories_cognitive(VECTOR(768), TEXT, INT, TEXT, FLOAT, BOOLEAN) TO anon;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- (1) Recall with link-boost: candidates linked to the strongest seed memories
--     get a multiplicative boost so spreading activation actually shapes the ranking.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_memories_cognitive(
  query_embedding VECTOR(768),
  query_text      TEXT  DEFAULT '',
  match_count     INT   DEFAULT 10,
  filter_category TEXT  DEFAULT NULL,
  vector_weight   FLOAT DEFAULT 0.6,
  include_archived BOOLEAN DEFAULT FALSE
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

-- ----------------------------------------------------------------------------
-- (2) Retrieval-induced forgetting: new similar memories slightly weaken old ones.
--     Models interference — not all forgetting is time-based.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION interfere_with_neighbors(
  new_embedding VECTOR(768),
  exclude_id    UUID,
  k             INT DEFAULT 5,
  decay_factor  FLOAT DEFAULT 0.97
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  affected INT;
BEGIN
  WITH targets AS (
    SELECT m.id
    FROM memories m
    WHERE m.id <> exclude_id
      AND m.embedding IS NOT NULL
      AND m.stage <> 'archived'
      AND m.pinned = FALSE
    ORDER BY m.embedding <=> new_embedding
    LIMIT k
  ),
  upd AS (
    UPDATE memories
    SET strength = GREATEST(strength * decay_factor, 0.01)
    WHERE id IN (SELECT id FROM targets)
    RETURNING id
  )
  SELECT count(*) INTO affected FROM upd;
  RETURN affected;
END;
$$;

-- ----------------------------------------------------------------------------
-- (3) Dedup consolidation: cluster near-duplicates, keep the strongest as
--     representative, archive the rest with a "merged into <id>" reason.
--     O(N²) on embeddings — fine for personal stores < ~10k entries.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dedup_similar_memories(
  similarity_threshold FLOAT DEFAULT 0.93,
  max_passes INT DEFAULT 1000
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  merged_total INT := 0;
  rep RECORD;
  dup_id UUID;
  passes INT := 0;
BEGIN
  FOR rep IN
    SELECT id, embedding
    FROM memories
    WHERE stage <> 'archived' AND embedding IS NOT NULL
    ORDER BY (strength * (1 + ln(1 + access_count + useful_count * 2))) DESC
  LOOP
    passes := passes + 1;
    IF passes > max_passes THEN EXIT; END IF;

    -- skip if rep was archived in a prior iteration of this run
    IF NOT EXISTS (SELECT 1 FROM memories WHERE id = rep.id AND stage <> 'archived') THEN
      CONTINUE;
    END IF;

    FOR dup_id IN
      SELECT m.id
      FROM memories m
      WHERE m.id <> rep.id
        AND m.stage <> 'archived'
        AND m.pinned = FALSE
        AND m.embedding IS NOT NULL
        AND (1 - (m.embedding <=> rep.embedding)) >= similarity_threshold
    LOOP
      INSERT INTO forgotten_memories
      SELECT m.*, NOW(), 'merged into ' || rep.id::TEXT
      FROM memories m WHERE m.id = dup_id;

      -- Transfer co-activation links from duplicate to representative.
      -- ON CONFLICT is INSERT-only in postgres, so we re-INSERT the redirected
      -- rows and merge weights on collision (Hebbian: keep the strongest link),
      -- then delete the originals.
      INSERT INTO memory_links (a, b, weight, last_coactivated_at)
      SELECT
        LEAST(rep.id,    CASE WHEN ml.a = dup_id THEN ml.b ELSE ml.a END),
        GREATEST(rep.id, CASE WHEN ml.a = dup_id THEN ml.b ELSE ml.a END),
        ml.weight,
        ml.last_coactivated_at
      FROM memory_links ml
      WHERE (ml.a = dup_id OR ml.b = dup_id)
        AND (CASE WHEN ml.a = dup_id THEN ml.b ELSE ml.a END) <> rep.id
      ON CONFLICT (a, b) DO UPDATE
        SET weight              = GREATEST(memory_links.weight, EXCLUDED.weight),
            last_coactivated_at = GREATEST(memory_links.last_coactivated_at, EXCLUDED.last_coactivated_at);

      DELETE FROM memory_links WHERE a = dup_id OR b = dup_id;

      UPDATE memories SET stage = 'archived' WHERE id = dup_id;

      UPDATE memories
      SET strength     = LEAST(strength * 1.05, 10.0),
          access_count = access_count + 1
      WHERE id = rep.id;

      merged_total := merged_total + 1;
    END LOOP;
  END LOOP;
  RETURN merged_total;
END;
$$;

-- ----------------------------------------------------------------------------
-- (4) mark_useful: strongest learning signal — this memory was actually used
--     in an answer, not just retrieved. Bigger strength bump than touch.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_memory_useful(memory_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memories
  SET useful_count = useful_count + 1,
      strength = LEAST(strength * 1.25 + 0.10, 10.0),
      last_accessed_at = NOW()
  WHERE id = memory_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- Schedule the dedup pass alongside the existing cron jobs (if pg_cron present).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'vectormemory_dedup';
    PERFORM cron.schedule(
      'vectormemory_dedup',
      '15 3 * * 0',  -- Sundays 03:15, between consolidate and forget_weak
      $sql$SELECT dedup_similar_memories(0.93);$sql$
    );
  END IF;
END $$;
