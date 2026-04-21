-- 048_bitemporal_coactivation.sql — Bitemporal validity + co-activation counter
--
-- Two orthogonal fixes that engram already has and we don't:
--
--   (a) Bitemporal. Today we only track "when was this memory created /
--       updated", not "when was this memory considered TRUE". A fact
--       that was right in March and wrong in May is currently either
--       deleted (losing the history) or edited-in-place (losing the
--       old version). valid_from / valid_until / invalidated_by lets
--       us archive the old version with bounds and keep the new one
--       live — the agent can then answer "what did I believe about X
--       on date Y".
--
--   (b) Co-activation counter. memory_links already has weight and
--       last_coactivated_at, but no explicit count. Without a count,
--       the weight curve is hard to interpret ("is weight=0.7 from
--       one strong signal or 30 weak ones?") and Hebbian reinforcement
--       can't tell first-encounter from hundredth-encounter. Adding
--       coactivation_count is a prerequisite for cleaner reinforcement
--       functions later.

-- ---------------------------------------------------------------------------
-- 1. Bitemporal columns on memories
-- ---------------------------------------------------------------------------

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS valid_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_until    TIMESTAMPTZ,           -- NULL = still valid
  ADD COLUMN IF NOT EXISTS invalidated_by UUID REFERENCES memories(id) ON DELETE SET NULL;

-- Mirror the same columns on forgotten_memories (it's a LIKE-clone from 007
-- and 010_cognitive_v2 explicitly documents that new columns must be added
-- here too, otherwise INSERT INTO forgotten_memories SELECT m.* fails).
ALTER TABLE forgotten_memories
  ADD COLUMN IF NOT EXISTS valid_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated_by UUID;

CREATE INDEX IF NOT EXISTS memories_valid_from_idx  ON memories (valid_from);
CREATE INDEX IF NOT EXISTS memories_valid_until_idx ON memories (valid_until)
  WHERE valid_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Auto-set valid_until when a memory is archived
-- ---------------------------------------------------------------------------
-- stage='archived' is the current "this is no longer live" signal. Make the
-- temporal bound follow automatically, so callers don't have to remember
-- to set both fields.

CREATE OR REPLACE FUNCTION memories_touch_valid_until()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.stage = 'archived' AND OLD.stage <> 'archived' AND NEW.valid_until IS NULL THEN
    NEW.valid_until := NOW();
  ELSIF NEW.stage <> 'archived' AND OLD.stage = 'archived' THEN
    -- restore: clear the bound
    NEW.valid_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_touch_valid_until_trig ON memories;
CREATE TRIGGER memories_touch_valid_until_trig
BEFORE UPDATE OF stage ON memories
FOR EACH ROW EXECUTE FUNCTION memories_touch_valid_until();

-- ---------------------------------------------------------------------------
-- 3. supersede_memory — explicit "b replaces a" with bitemporal bookkeeping
-- ---------------------------------------------------------------------------
-- One call that:
--   * sets a.valid_until = NOW()
--   * sets a.invalidated_by = b
--   * sets a.stage = 'archived'
--   * writes a 'supersedes' relation (a, b)
--   * writes a 'superseded' memory_event on a

CREATE OR REPLACE FUNCTION supersede_memory(
  p_old_id  UUID,
  p_new_id  UUID,
  p_reason  TEXT DEFAULT '',
  p_agent_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_old memories%ROWTYPE;
  v_new memories%ROWTYPE;
BEGIN
  IF p_old_id = p_new_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'old and new must differ');
  END IF;

  SELECT * INTO v_old FROM memories WHERE id = p_old_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'old memory not found');
  END IF;

  SELECT * INTO v_new FROM memories WHERE id = p_new_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'new memory not found');
  END IF;

  UPDATE memories
     SET stage          = 'archived',
         valid_until    = NOW(),
         invalidated_by = p_new_id
   WHERE id = p_old_id;

  -- Relation (idempotent — chain_memories handles upsert)
  PERFORM chain_memories(p_new_id, p_old_id, 'supersedes', p_reason, 0.8, p_agent_id);

  -- Event
  PERFORM log_memory_event(
    p_old_id,
    'superseded',
    'rpc:supersede_memory',
    jsonb_build_object('by', p_new_id, 'reason', p_reason),
    NULL,
    p_agent_id
  );

  RETURN jsonb_build_object(
    'ok',           true,
    'old_id',       p_old_id,
    'new_id',       p_new_id,
    'valid_until',  NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION supersede_memory(UUID, UUID, TEXT, UUID) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 4. Co-activation count on memory_links
-- ---------------------------------------------------------------------------

ALTER TABLE memory_links
  ADD COLUMN IF NOT EXISTS coactivation_count INT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. coactivate_pair — canonical-ordered upsert that bumps count + weight
-- ---------------------------------------------------------------------------
-- memory_links uses canonical ordering (a < b) for undirectedness. Callers
-- shouldn't have to remember that — this RPC normalises order, inserts the
-- link if missing, and bumps both coactivation_count and weight (with a
-- soft cap at 1.0).

CREATE OR REPLACE FUNCTION coactivate_pair(
  p_x      UUID,
  p_y      UUID,
  p_delta  FLOAT DEFAULT 0.05
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_a UUID;
  v_b UUID;
  v_row memory_links%ROWTYPE;
BEGIN
  IF p_x = p_y THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self-loop not allowed');
  END IF;

  IF p_x < p_y THEN v_a := p_x; v_b := p_y; ELSE v_a := p_y; v_b := p_x; END IF;

  INSERT INTO memory_links (a, b, weight, coactivation_count, last_coactivated_at)
  VALUES (v_a, v_b, LEAST(1.0, 0.1 + p_delta), 1, NOW())
  ON CONFLICT (a, b) DO UPDATE
    SET weight              = LEAST(1.0, memory_links.weight + p_delta * (1.0 - memory_links.weight)),
        coactivation_count  = memory_links.coactivation_count + 1,
        last_coactivated_at = NOW()
  RETURNING * INTO v_row;

  -- Opportunistic event (bus-level, memory_id left NULL — context has both)
  PERFORM log_memory_event(
    NULL,
    'coactivated',
    'rpc:coactivate_pair',
    jsonb_build_object('a', v_a, 'b', v_b, 'count', v_row.coactivation_count, 'weight', v_row.weight),
    NULL,
    NULL
  );

  RETURN jsonb_build_object(
    'ok',                  true,
    'a',                   v_row.a,
    'b',                   v_row.b,
    'weight',              v_row.weight,
    'coactivation_count',  v_row.coactivation_count,
    'last_coactivated_at', v_row.last_coactivated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION coactivate_pair(UUID, UUID, FLOAT) TO anon, service_role;
