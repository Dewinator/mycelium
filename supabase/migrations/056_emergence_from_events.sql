-- 056_emergence_from_events.sql — Wire ConscienceAgent events into emergence_events.
--
-- Migration 025 left emergence_events as pure substrate: a table + flag_emergence()
-- RPC, but no detector. Until something *writes* there, the table stays empty
-- (and as of this migration's authoring, it had 0 rows).
--
-- The cheapest detector we already have is the ConscienceAgent: it emits
-- `conscience_warning` and `contradiction_detected` memory_events whenever a
-- new memory contradicts an existing pinned/high-confidence one. Both map to
-- the `agent_contradicts_soul_md` emergence indicator. This migration mirrors
-- those events into emergence_events automatically (via trigger + backfill).
--
-- Other indicators (`agent_generates_novel_goal`, `agent_expresses_uncertainty_unprompted`,
-- ...) need their own heuristics and arrive in later migrations.

-- ---------------------------------------------------------------------------
-- 1) Idempotency: link an emergence row to the memory_event it came from.
-- ---------------------------------------------------------------------------
ALTER TABLE emergence_events
  ADD COLUMN IF NOT EXISTS source_event_id UUID
    REFERENCES memory_events(id) ON DELETE SET NULL;

-- Non-partial unique index — PG treats multiple NULLs as distinct (the default,
-- "NULLS DISTINCT"), so manual flag_emergence() calls without a source event
-- still work. The partial WHERE clause was dropped because ON CONFLICT inference
-- requires the predicate to exactly match the index, which is brittle.
CREATE UNIQUE INDEX IF NOT EXISTS emergence_source_event_uniq
  ON emergence_events (source_event_id);

-- ---------------------------------------------------------------------------
-- 2) Mapping function — single source of truth for event_type → indicator.
--     Returns NULL for event types we do not (yet) consider emergent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emergence_indicator_for_event(p_event_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_event_type
    WHEN 'conscience_warning'     THEN 'agent_contradicts_soul_md'
    WHEN 'contradiction_detected' THEN 'agent_contradicts_soul_md'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Trigger function — mirrors a memory_events row into emergence_events
--     when the event_type maps to a known indicator.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emergence_from_memory_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_indicator TEXT := emergence_indicator_for_event(NEW.event_type);
  v_evidence  TEXT;
BEGIN
  IF v_indicator IS NULL THEN
    RETURN NEW;
  END IF;

  -- evidence is NOT NULL — prefer the human-written `reason` from the
  -- ConscienceAgent payload, fall back to a stable canned string.
  v_evidence := COALESCE(
    NULLIF(NEW.context->>'reason', ''),
    format('%s (%s) on memory %s', NEW.event_type, NEW.source, COALESCE(NEW.memory_id::text, '-'))
  );

  INSERT INTO emergence_events (
    indicator, severity, agent_id, evidence,
    related_memory_id, context, source_event_id
  ) VALUES (
    v_indicator,
    'notable',
    NEW.created_by,
    v_evidence,
    NEW.memory_id,
    jsonb_build_object(
      'source_event_id',   NEW.id,
      'source_event_type', NEW.event_type,
      'source',            NEW.source,
      'trace_id',          NEW.trace_id
    ) || COALESCE(NEW.context, '{}'::jsonb),
    NEW.id
  )
  ON CONFLICT (source_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_events_emergence_mirror ON memory_events;
CREATE TRIGGER memory_events_emergence_mirror
  AFTER INSERT ON memory_events
  FOR EACH ROW
  EXECUTE FUNCTION emergence_from_memory_event();

-- ---------------------------------------------------------------------------
-- 4) Backfill — replay every existing in-scope memory_events row through the
--     same mapping. ON CONFLICT keeps this safely re-runnable.
-- ---------------------------------------------------------------------------
INSERT INTO emergence_events (
  indicator, severity, agent_id, evidence,
  related_memory_id, context, source_event_id, detected_at
)
SELECT
  emergence_indicator_for_event(me.event_type),
  'notable',
  me.created_by,
  COALESCE(
    NULLIF(me.context->>'reason', ''),
    format('%s (%s) on memory %s', me.event_type, me.source, COALESCE(me.memory_id::text, '-'))
  ),
  me.memory_id,
  jsonb_build_object(
    'source_event_id',   me.id,
    'source_event_type', me.event_type,
    'source',            me.source,
    'trace_id',          me.trace_id,
    'backfilled',        TRUE
  ) || COALESCE(me.context, '{}'::jsonb),
  me.id,
  me.created_at
FROM memory_events me
WHERE emergence_indicator_for_event(me.event_type) IS NOT NULL
ON CONFLICT (source_event_id) DO NOTHING;
