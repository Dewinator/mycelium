-- 049_memory_patterns.sql — Tag co-occurrence patterns (Engram-inspired)
--
-- Engram's `patterns` tool surfaces recurring tag combinations from the
-- memory corpus — "these 3 tags show up together much more often than
-- random". That's useful for:
--   * Spotting implicit categories the agent didn't know it had
--   * Seeding lesson-synthesis clusters (if X+Y+Z always co-occur,
--     maybe there's a rule hiding there)
--   * Dashboard diagnostics
--
-- We implement it purely in SQL as an RPC. No background index needed
-- because the UNNEST-over-tags scan is cheap up to ~10k memories and we
-- add a LATERAL self-join only at query time.
--
-- Returns pairs (tag_a, tag_b) with:
--   * support: fraction of memories that contain BOTH tags
--   * lift:    support(a,b) / (support(a) * support(b))
--              (1.0 = independent, >1 = they attract each other)
--   * count:   raw co-occurrence count
--
-- Only pairs with support >= p_min_support AND count >= 3 are returned,
-- sorted by lift DESC (strongest non-trivial associations first).

CREATE OR REPLACE FUNCTION memory_patterns(
  p_min_support FLOAT DEFAULT 0.02,
  p_limit       INT   DEFAULT 25,
  p_project_id  UUID  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_total     INT;
  v_patterns  JSONB;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM memories
  WHERE stage <> 'archived'
    AND (p_project_id IS NULL OR project_id = p_project_id);

  IF v_total < 10 THEN
    RETURN jsonb_build_object(
      'total_memories', v_total,
      'note',           'fewer than 10 live memories — patterns not meaningful yet',
      'patterns',       '[]'::jsonb
    );
  END IF;

  WITH flat AS (
    SELECT m.id, UNNEST(m.tags) AS tag
    FROM memories m
    WHERE m.stage <> 'archived'
      AND m.tags IS NOT NULL
      AND array_length(m.tags, 1) >= 1
      AND (p_project_id IS NULL OR m.project_id = p_project_id)
  ),
  tag_counts AS (
    SELECT tag, COUNT(DISTINCT id) AS n
    FROM flat
    GROUP BY tag
  ),
  pairs AS (
    SELECT a.tag AS tag_a, b.tag AS tag_b, COUNT(DISTINCT a.id) AS n_ab
    FROM flat a
    JOIN flat b ON a.id = b.id AND a.tag < b.tag  -- canonical order, no self-pairs
    GROUP BY a.tag, b.tag
    HAVING COUNT(DISTINCT a.id) >= 3
  ),
  scored AS (
    SELECT
      p.tag_a,
      p.tag_b,
      p.n_ab,
      p.n_ab::FLOAT / v_total                                  AS support,
      (p.n_ab::FLOAT / v_total) /
        NULLIF((ca.n::FLOAT / v_total) * (cb.n::FLOAT / v_total), 0)  AS lift
    FROM pairs p
    JOIN tag_counts ca ON ca.tag = p.tag_a
    JOIN tag_counts cb ON cb.tag = p.tag_b
    WHERE (p.n_ab::FLOAT / v_total) >= p_min_support
  )
  SELECT COALESCE(jsonb_agg(row_to_json(s) ORDER BY s.lift DESC NULLS LAST, s.n_ab DESC), '[]'::jsonb)
  INTO v_patterns
  FROM (
    SELECT tag_a, tag_b, n_ab, support, lift
    FROM scored
    ORDER BY lift DESC NULLS LAST, n_ab DESC
    LIMIT p_limit
  ) s;

  RETURN jsonb_build_object(
    'total_memories', v_total,
    'min_support',    p_min_support,
    'patterns',       v_patterns
  );
END;
$$;

GRANT EXECUTE ON FUNCTION memory_patterns(FLOAT, INT, UUID) TO anon, service_role;
