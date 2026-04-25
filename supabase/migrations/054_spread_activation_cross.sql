-- 054_spread_activation_cross.sql — Phase 3: cross-layer Hebbian spread.
--
-- Today spread_activation (008) walks ONLY memory_links and returns ONLY
-- memories. Experiences live in their own Hebbian table
-- (experience_memory_links, Migration 016) that the recall path consults
-- separately via experiencesForMemory(), but those experiences never
-- bleed into the spreading-activation graph itself: M1 → E1 → M2 stays
-- invisible because spread_activation can't follow the M1↔E1 edge.
--
-- This migration adds spread_activation_cross — a typed-seed, typed-output
-- spread that walks BOTH memory_links and experience_memory_links from
-- a single seed and returns neighbors as (kind, id, content, score).
-- Single-hop for now; the recall layer will surface the typed neighbors
-- alongside the existing memory-only spread.
--
-- Storage is left untouched. Phase 4 (atomization) is the right moment
-- to collapse memory_links + experience_memory_links into a single
-- polymorphic table — touching memory_links here would reach into 6+
-- legacy migrations (010 dedup, 014 forgotten transfer, 012/013 dashboard
-- stats), which is too much blast radius for a single phase.
--
-- Future kinds (lesson, trait, intention) plug into the CASE inside
-- this function as their own Hebbian tables come online — the SIGNATURE
-- is already extensible.

DROP FUNCTION IF EXISTS spread_activation_cross(TEXT, UUID, INT);

CREATE OR REPLACE FUNCTION spread_activation_cross(
  p_seed_kind     TEXT,
  p_seed_id       UUID,
  p_max_neighbors INT  DEFAULT 5
)
RETURNS TABLE (
  kind          TEXT,
  id            UUID,
  content       TEXT,
  category      TEXT,
  tags          TEXT[],
  link_strength FLOAT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF p_seed_kind = 'memory' THEN
    RETURN QUERY
    WITH neighbors AS (
      -- (a) memory↔memory via memory_links — same edge weights as
      --     spread_activation(008) so scores are comparable.
      SELECT 'memory'::TEXT AS k, ml.b AS nid, ml.weight AS w
      FROM memory_links ml
      WHERE ml.a = p_seed_id
      UNION ALL
      SELECT 'memory'::TEXT, ml.a, ml.weight
      FROM memory_links ml
      WHERE ml.b = p_seed_id
      UNION ALL
      -- (b) memory↔experience via experience_memory_links — the existing
      --     cross-kind Hebbian table. Weight maps to link_strength.
      SELECT 'experience'::TEXT, eml.experience_id, eml.weight
      FROM experience_memory_links eml
      WHERE eml.memory_id = p_seed_id
    ),
    agg AS (
      SELECT k, nid, SUM(w) AS total
      FROM neighbors
      WHERE NOT (k = 'memory' AND nid = p_seed_id)
      GROUP BY k, nid
      ORDER BY total DESC
      LIMIT p_max_neighbors
    )
    SELECT
      a.k                                                            AS kind,
      a.nid                                                          AS id,
      CASE
        WHEN a.k = 'memory'     THEN (SELECT m.content FROM memories m   WHERE m.id = a.nid)
        WHEN a.k = 'experience' THEN (SELECT e.summary FROM experiences e WHERE e.id = a.nid)
        ELSE NULL
      END                                                            AS content,
      CASE
        WHEN a.k = 'memory'     THEN (SELECT m.category FROM memories m WHERE m.id = a.nid)
        WHEN a.k = 'experience' THEN 'experience'
        ELSE NULL
      END                                                            AS category,
      CASE
        WHEN a.k = 'memory' THEN (SELECT m.tags FROM memories m WHERE m.id = a.nid)
        ELSE '{}'::TEXT[]
      END                                                            AS tags,
      a.total::FLOAT                                                 AS link_strength
    FROM agg a;

  ELSIF p_seed_kind = 'experience' THEN
    RETURN QUERY
    WITH neighbors AS (
      -- experience → memories via experience_memory_links
      SELECT 'memory'::TEXT AS k, eml.memory_id AS nid, eml.weight AS w
      FROM experience_memory_links eml
      WHERE eml.experience_id = p_seed_id
    ),
    agg AS (
      SELECT k, nid, SUM(w) AS total
      FROM neighbors
      GROUP BY k, nid
      ORDER BY total DESC
      LIMIT p_max_neighbors
    )
    SELECT
      a.k                                                  AS kind,
      a.nid                                                AS id,
      (SELECT m.content  FROM memories m WHERE m.id = a.nid) AS content,
      (SELECT m.category FROM memories m WHERE m.id = a.nid) AS category,
      (SELECT m.tags     FROM memories m WHERE m.id = a.nid) AS tags,
      a.total::FLOAT                                       AS link_strength
    FROM agg a;

  ELSE
    -- Unknown seed kind — empty result, not an error. Forward-compat
    -- with future kinds that haven't shipped their Hebbian tables yet.
    RETURN;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION spread_activation_cross(TEXT, UUID, INT) TO anon, service_role;
