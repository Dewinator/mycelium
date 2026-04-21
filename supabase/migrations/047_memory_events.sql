-- 047_memory_events.sql — Canonical event log for the memory layer (Engram-inspired)
--
-- Motivation: today the system tracks lived state via snapshots
-- (memories.access_count, agent_neurochemistry.history, experience_causes,
-- guard_events). What we don't have is a SINGLE canonical append-only
-- stream of "something happened to / with a memory". That stream is what
-- engram's memory_events table is — and it enables three things we
-- currently can't do cleanly:
--
--   1. Agent event-bus (5s polling): subscribers read from one log with
--      a per-agent cursor instead of polling N different tables.
--   2. Memory history-per-id: "show me everything that ever happened to
--      memory X" in a single indexed scan.
--   3. Trace-id correlation: group all events that happened inside the
--      same tool-call / hook invocation.
--
-- This migration intentionally ADDS a log — it does not replace or move
-- the existing tables. Writers are wired up opportunistically (a trigger
-- on memories for created; manual inserts elsewhere), so adoption is
-- incremental.

-- ---------------------------------------------------------------------------
-- 1. memory_events table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID REFERENCES memories(id) ON DELETE SET NULL,  -- nullable for bus-level events
  event_type  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'unknown',                  -- 'mcp:remember' / 'trigger' / 'agent:consolidator' / ...
  context     JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id    UUID,                                             -- group events of the same operation
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID REFERENCES agent_genomes(id),

  CHECK (event_type IN (
    -- lifecycle
    'created', 'updated', 'archived', 'restored', 'superseded',
    -- access / use
    'accessed', 'recalled', 'used_in_response', 'pinned', 'unpinned',
    -- feedback / learning
    'promoted', 'demoted', 'positive_feedback', 'negative_feedback',
    'mark_useful', 'emphasis_bump',
    -- relations
    'relation_added', 'relation_removed', 'coactivated',
    -- guard / conscience
    'guard_hit', 'guard_miss', 'prevention_hit', 'prevention_miss',
    'conscience_warning', 'contradiction_detected',
    -- agent bus
    'agent_triggered', 'agent_completed', 'agent_error',
    'consolidation_done', 'synthesis_created',
    -- observability
    'reasoning_trace', 'tool_call_trace', 'prompt_received',
    -- generic
    'note'
  ))
);

CREATE INDEX IF NOT EXISTS memory_events_memory_idx    ON memory_events (memory_id, created_at DESC) WHERE memory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_events_type_idx      ON memory_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_created_idx   ON memory_events (created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_trace_idx     ON memory_events (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_events_source_idx    ON memory_events (source, created_at DESC);

GRANT SELECT, INSERT ON memory_events TO service_role;
GRANT SELECT         ON memory_events TO anon;

-- ---------------------------------------------------------------------------
-- 2. log_memory_event — convenience writer (idempotent-ish via trace_id)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION log_memory_event(
  p_memory_id  UUID,
  p_event_type TEXT,
  p_source     TEXT DEFAULT 'mcp',
  p_context    JSONB DEFAULT '{}'::jsonb,
  p_trace_id   UUID DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO memory_events (memory_id, event_type, source, context, trace_id, created_by)
  VALUES (p_memory_id, p_event_type, p_source, COALESCE(p_context, '{}'::jsonb), p_trace_id, p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION log_memory_event(UUID, TEXT, TEXT, JSONB, UUID, UUID)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 3. Trigger: log 'created' on every memories INSERT
-- ---------------------------------------------------------------------------
-- Keeps the stream honest without requiring every caller to manually log.
-- The existing remember() flow still continues to work — this just adds a
-- row to memory_events alongside.

CREATE OR REPLACE FUNCTION memories_log_created()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO memory_events (memory_id, event_type, source, context, created_by)
  VALUES (
    NEW.id,
    'created',
    'trigger:memories_insert',
    jsonb_build_object(
      'category',   NEW.category,
      'tags',       NEW.tags,
      'stage',      NEW.stage,
      'pinned',     NEW.pinned,
      'project_id', NEW.project_id
    ),
    NEW.created_by_agent_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memories_log_created_trig ON memories;
CREATE TRIGGER memories_log_created_trig
AFTER INSERT ON memories
FOR EACH ROW EXECUTE FUNCTION memories_log_created();

-- ---------------------------------------------------------------------------
-- 4. memory_history — all events + metadata for a memory
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION memory_history(
  p_memory_id UUID,
  p_limit     INT DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_self   JSONB;
  v_events JSONB;
  v_counts JSONB;
BEGIN
  SELECT jsonb_build_object(
    'id',               m.id,
    'content',          LEFT(m.content, 300),
    'category',         m.category,
    'tags',             m.tags,
    'stage',            m.stage,
    'pinned',           m.pinned,
    'strength',         m.strength,
    'importance',       m.importance,
    'access_count',     m.access_count,
    'useful_count',     m.useful_count,
    'last_accessed_at', m.last_accessed_at,
    'created_at',       m.created_at,
    'updated_at',       m.updated_at
  ) INTO v_self
  FROM memories m
  WHERE m.id = p_memory_id;

  IF v_self IS NULL THEN
    RETURN jsonb_build_object('exists', false, 'memory_id', p_memory_id);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.created_at DESC), '[]'::jsonb) INTO v_events
  FROM (
    SELECT id, event_type, source, context, trace_id, created_at, created_by
    FROM memory_events
    WHERE memory_id = p_memory_id
    ORDER BY created_at DESC
    LIMIT p_limit
  ) e;

  SELECT COALESCE(
    jsonb_object_agg(event_type, cnt),
    '{}'::jsonb
  ) INTO v_counts
  FROM (
    SELECT event_type, COUNT(*) AS cnt
    FROM memory_events
    WHERE memory_id = p_memory_id
    GROUP BY event_type
  ) c;

  RETURN jsonb_build_object(
    'exists',         true,
    'memory',         v_self,
    'event_counts',   v_counts,
    'recent_events',  v_events
  );
END;
$$;

GRANT EXECUTE ON FUNCTION memory_history(UUID, INT) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 5. memory_events_since — event-bus poll primitive (for future agents)
-- ---------------------------------------------------------------------------
-- Returns events strictly AFTER (created_at, id) — the usual keyset
-- pagination pattern so a polling agent can't miss or double-count events
-- inside a single millisecond.

CREATE OR REPLACE FUNCTION memory_events_since(
  p_after_created_at TIMESTAMPTZ DEFAULT NULL,
  p_after_id         UUID        DEFAULT NULL,
  p_event_types      TEXT[]      DEFAULT NULL,
  p_limit            INT         DEFAULT 100
)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.created_at, e.id), '[]'::jsonb)
  FROM (
    SELECT id, memory_id, event_type, source, context, trace_id, created_at, created_by
    FROM memory_events
    WHERE (p_after_created_at IS NULL
           OR created_at > p_after_created_at
           OR (created_at = p_after_created_at AND id > p_after_id))
      AND (p_event_types IS NULL OR event_type = ANY(p_event_types))
    ORDER BY created_at, id
    LIMIT p_limit
  ) e;
$$;

GRANT EXECUTE ON FUNCTION memory_events_since(TIMESTAMPTZ, UUID, TEXT[], INT)
  TO anon, service_role;
