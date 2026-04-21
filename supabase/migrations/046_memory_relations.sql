-- 046_memory_relations.sql — Explicit memory-to-memory graph (Engram-inspired)
--
-- Motivation: memories today associate only via the Hebbian memory_links
-- table (undirected, weight-only, decays). That's great for "these two
-- facts co-activate", but it can't capture *kinds* of relation — which
-- one supersedes the other, which is a bugfix for which, which one led
-- to which, which one contradicts which.
--
-- Engram (cueplex-engram) solved this with a typed relations table
-- (13 labels: caused_by, led_to, supersedes, contradicts, related,
-- overrides, originated_in, learned_from, depends_on, exemplifies,
-- fixed_by, repeated_mistake, validated_by). We already have
-- experience_causes for episodic-to-episodic cause edges — this migration
-- adds the analogous graph on the *memory* layer, so the agent can answer
-- "why this memory exists" and "what superseded it" without a free-text
-- scan.
--
-- Design decisions (2026-04-21):
--   * DIRECTED edges (a → b), unlike memory_links which is undirected.
--     Semantics depend on the relation type (e.g. a supersedes b, a
--     caused_by b).
--   * Idempotent on (a_id, b_id, type) — re-inserting the same edge
--     just bumps weight and updates reason/last_reinforced_at.
--   * reason is a short free-text rationale; weight is a confidence
--     score in [0,1] that can be reinforced.
--   * created_by_agent_id tracks provenance (like the rest of the
--     cognitive layer post-029).
--   * No cascade on memory-delete — we soft-archive memories, we don't
--     drop them. FK uses ON DELETE CASCADE only to survive accidental
--     hard-deletes in dev.

-- ---------------------------------------------------------------------------
-- 1. memory_relations table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_relations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id                UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  b_id                UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  reason              TEXT NOT NULL DEFAULT '',
  weight              FLOAT NOT NULL DEFAULT 0.5
                        CHECK (weight >= 0 AND weight <= 1),
  evidence_count      INT NOT NULL DEFAULT 1
                        CHECK (evidence_count >= 1),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_agent_id UUID REFERENCES agent_genomes(id),

  CHECK (a_id <> b_id),
  CHECK (type IN (
    'caused_by',        -- a was caused by b
    'led_to',           -- a led to b
    'supersedes',       -- a replaces b (b is now stale)
    'contradicts',      -- a contradicts b
    'related',          -- loose association (when nothing sharper fits)
    'overrides',        -- a overrides b's applicability in context
    'originated_in',    -- a was first observed in context b
    'learned_from',     -- a is a lesson derived from b
    'depends_on',       -- a presupposes b
    'exemplifies',      -- a is an instance of the rule b
    'fixed_by',         -- a (bug/issue) is fixed by b (patch/decision)
    'repeated_mistake', -- a is the same mistake as b, repeated
    'validated_by'      -- a is confirmed by evidence b
  )),

  UNIQUE (a_id, b_id, type)
);

CREATE INDEX IF NOT EXISTS memory_relations_a_idx    ON memory_relations (a_id, type);
CREATE INDEX IF NOT EXISTS memory_relations_b_idx    ON memory_relations (b_id, type);
CREATE INDEX IF NOT EXISTS memory_relations_type_idx ON memory_relations (type);

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_relations TO service_role;
GRANT SELECT                         ON memory_relations TO anon;

-- ---------------------------------------------------------------------------
-- 2. chain_memories — idempotent upsert
-- ---------------------------------------------------------------------------
-- Insert an edge. If the same (a,b,type) already exists, bump evidence_count
-- and weight (soft cap at 1.0). Returns the edge row as JSONB.

CREATE OR REPLACE FUNCTION chain_memories(
  p_a_id    UUID,
  p_b_id    UUID,
  p_type    TEXT,
  p_reason  TEXT DEFAULT '',
  p_weight  FLOAT DEFAULT 0.5,
  p_agent_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row memory_relations%ROWTYPE;
BEGIN
  IF p_a_id = p_b_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self-loop not allowed');
  END IF;

  INSERT INTO memory_relations (a_id, b_id, type, reason, weight, created_by_agent_id)
  VALUES (p_a_id, p_b_id, p_type, COALESCE(p_reason, ''), GREATEST(0, LEAST(1, p_weight)), p_agent_id)
  ON CONFLICT (a_id, b_id, type) DO UPDATE
    SET evidence_count     = memory_relations.evidence_count + 1,
        weight             = LEAST(1.0, memory_relations.weight + 0.15 * (1.0 - memory_relations.weight)),
        reason             = CASE WHEN EXCLUDED.reason <> '' THEN EXCLUDED.reason ELSE memory_relations.reason END,
        last_reinforced_at = NOW()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok',                 true,
    'id',                 v_row.id,
    'a_id',               v_row.a_id,
    'b_id',               v_row.b_id,
    'type',               v_row.type,
    'reason',             v_row.reason,
    'weight',             v_row.weight,
    'evidence_count',     v_row.evidence_count,
    'created_at',         v_row.created_at,
    'last_reinforced_at', v_row.last_reinforced_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION chain_memories(UUID, UUID, TEXT, TEXT, FLOAT, UUID)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 3. memory_why — causes + consequences for one memory
-- ---------------------------------------------------------------------------
-- Walks the graph ONE hop in both directions for "ancestry" relations
-- (caused_by, learned_from, originated_in, depends_on, fixed_by,
-- validated_by) and "descendants" (led_to, supersedes, overrides,
-- exemplifies, repeated_mistake, contradicts, related).
--
-- Returns two arrays: `causes` (edges where this memory is the *target*
-- of an ancestry relation, or the *source* of a descendant relation —
-- i.e. things that feed INTO this memory's existence) and `consequences`
-- (edges that flow OUT of it).

CREATE OR REPLACE FUNCTION memory_why(p_memory_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_causes       JSONB;
  v_consequences JSONB;
  v_self         JSONB;
BEGIN
  SELECT jsonb_build_object(
    'id',         m.id,
    'content',    LEFT(m.content, 200),
    'category',   m.category,
    'tags',       m.tags,
    'stage',      m.stage,
    'strength',   m.strength,
    'importance', m.importance,
    'pinned',     m.pinned,
    'created_at', m.created_at
  ) INTO v_self
  FROM memories m
  WHERE m.id = p_memory_id;

  IF v_self IS NULL THEN
    RETURN jsonb_build_object('exists', false, 'memory_id', p_memory_id);
  END IF;

  -- "causes" = edges that explain why this memory exists:
  --   * this memory is the A-side of caused_by / learned_from /
  --     originated_in / depends_on / fixed_by / validated_by
  --     (meaning "a caused_by b" → b is a cause of a)
  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_causes
  FROM (
    SELECT
      mr.id, mr.type, mr.reason, mr.weight, mr.evidence_count,
      mr.b_id AS other_id,
      LEFT(m.content, 200) AS other_content,
      m.category AS other_category,
      m.stage AS other_stage,
      mr.created_at
    FROM memory_relations mr
    JOIN memories m ON m.id = mr.b_id
    WHERE mr.a_id = p_memory_id
      AND mr.type IN ('caused_by', 'learned_from', 'originated_in',
                      'depends_on', 'fixed_by', 'validated_by')
    ORDER BY mr.weight DESC, mr.created_at DESC
    LIMIT 20
  ) r;

  -- "consequences" = edges that flow out of this memory:
  --   * this memory is the A-side of led_to / supersedes / overrides /
  --     exemplifies / contradicts / related / repeated_mistake
  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_consequences
  FROM (
    SELECT
      mr.id, mr.type, mr.reason, mr.weight, mr.evidence_count,
      mr.b_id AS other_id,
      LEFT(m.content, 200) AS other_content,
      m.category AS other_category,
      m.stage AS other_stage,
      mr.created_at
    FROM memory_relations mr
    JOIN memories m ON m.id = mr.b_id
    WHERE mr.a_id = p_memory_id
      AND mr.type IN ('led_to', 'supersedes', 'overrides', 'exemplifies',
                      'contradicts', 'related', 'repeated_mistake')
    ORDER BY mr.weight DESC, mr.created_at DESC
    LIMIT 20
  ) r;

  RETURN jsonb_build_object(
    'exists',       true,
    'memory',       v_self,
    'causes',       v_causes,
    'consequences', v_consequences
  );
END;
$$;

GRANT EXECUTE ON FUNCTION memory_why(UUID) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 4. memory_neighbors — k-hop BFS over the relations graph
-- ---------------------------------------------------------------------------
-- Breadth-first walk up to `p_depth` hops (default 2). Undirected for this
-- purpose: we follow edges in either direction. Optional relation-type
-- filter. Returns nodes with min-hop distance.

CREATE OR REPLACE FUNCTION memory_neighbors(
  p_memory_id UUID,
  p_depth     INT DEFAULT 2,
  p_types     TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_nodes JSONB;
BEGIN
  IF p_depth < 1 OR p_depth > 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'depth must be 1..5');
  END IF;

  WITH RECURSIVE walk(node_id, hop, path) AS (
    SELECT p_memory_id, 0, ARRAY[p_memory_id]
    UNION ALL
    SELECT
      CASE WHEN mr.a_id = w.node_id THEN mr.b_id ELSE mr.a_id END,
      w.hop + 1,
      w.path || CASE WHEN mr.a_id = w.node_id THEN mr.b_id ELSE mr.a_id END
    FROM walk w
    JOIN memory_relations mr
      ON (mr.a_id = w.node_id OR mr.b_id = w.node_id)
    WHERE w.hop < p_depth
      AND (p_types IS NULL OR mr.type = ANY(p_types))
      AND NOT (
        CASE WHEN mr.a_id = w.node_id THEN mr.b_id ELSE mr.a_id END
        = ANY(w.path)
      )
  )
  SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.min_hop, r.memory_id), '[]'::jsonb) INTO v_nodes
  FROM (
    SELECT
      w.node_id AS memory_id,
      MIN(w.hop) AS min_hop,
      LEFT(m.content, 160) AS preview,
      m.category, m.stage, m.strength
    FROM walk w
    JOIN memories m ON m.id = w.node_id
    WHERE w.node_id <> p_memory_id
    GROUP BY w.node_id, m.content, m.category, m.stage, m.strength
    ORDER BY min_hop, memory_id
    LIMIT 100
  ) r;

  RETURN jsonb_build_object(
    'ok',        true,
    'memory_id', p_memory_id,
    'depth',     p_depth,
    'nodes',     v_nodes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION memory_neighbors(UUID, INT, TEXT[]) TO anon, service_role;
