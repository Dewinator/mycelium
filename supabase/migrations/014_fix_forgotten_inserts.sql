-- Fix: forget_weak_memories and dedup_similar_memories used `INSERT INTO
-- forgotten_memories SELECT m.*, NOW(), 'reason'`. That breaks any time
-- a new column is added to memories — column order between the two tables
-- drifts and the assignment lands on the wrong type (e.g. useful_count from
-- 010 collided with forgotten_at).
--
-- Fix: explicit column lists, so the insert is robust against future ALTERs.

CREATE OR REPLACE FUNCTION forget_weak_memories(
  strength_threshold FLOAT DEFAULT 0.05,
  min_age_days       INT   DEFAULT 7
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  archived INT;
BEGIN
  WITH candidates AS (
    SELECT m.id
    FROM memories m
    WHERE m.pinned = FALSE
      AND m.stage <> 'archived'
      AND m.created_at < NOW() - (min_age_days || ' days')::INTERVAL
      AND (
        m.strength
        * exp(
            - GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(m.last_accessed_at, m.created_at))) / 86400.0, 0)
            / NULLIF(m.decay_tau_days * (1 + m.importance), 0)
          )
      ) < strength_threshold
  ),
  moved AS (
    INSERT INTO forgotten_memories (
      id, content, category, tags, embedding, metadata, source,
      created_at, updated_at, strength, importance, access_count,
      last_accessed_at, valence, arousal, stage, pinned, decay_tau_days,
      useful_count, forgotten_at, forgotten_reason
    )
    SELECT
      m.id, m.content, m.category, m.tags, m.embedding, m.metadata, m.source,
      m.created_at, m.updated_at, m.strength, m.importance, m.access_count,
      m.last_accessed_at, m.valence, m.arousal, m.stage, m.pinned, m.decay_tau_days,
      m.useful_count, NOW(), 'decay below threshold'
    FROM memories m
    WHERE m.id IN (SELECT id FROM candidates)
    RETURNING id
  )
  UPDATE memories SET stage = 'archived' WHERE id IN (SELECT id FROM moved);
  GET DIAGNOSTICS archived = ROW_COUNT;
  RETURN archived;
END;
$$;


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
      INSERT INTO forgotten_memories (
        id, content, category, tags, embedding, metadata, source,
        created_at, updated_at, strength, importance, access_count,
        last_accessed_at, valence, arousal, stage, pinned, decay_tau_days,
        useful_count, forgotten_at, forgotten_reason
      )
      SELECT
        m.id, m.content, m.category, m.tags, m.embedding, m.metadata, m.source,
        m.created_at, m.updated_at, m.strength, m.importance, m.access_count,
        m.last_accessed_at, m.valence, m.arousal, m.stage, m.pinned, m.decay_tau_days,
        m.useful_count, NOW(), 'merged into ' || rep.id::TEXT
      FROM memories m WHERE m.id = dup_id;

      -- Redirect Hebbian links from duplicate to representative; merge weights.
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
