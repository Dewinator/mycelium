-- 025_emergence.sql — Schicht 5d: Emergenz-Monitoring
--
-- Wir koennen nicht vorhersehen wann Unerwartetes emergiert. Aber wir koennen
-- protokollieren, wenn ein Indikator aus EMERGENCE_INDICATORS aus der Spec
-- feuert. Die Entscheidung ob ein Ereignis ein Indikator ist wird vom
-- beobachtenden Agenten / Heuristik gefaellt — hier nur das Substrat.

CREATE TABLE IF NOT EXISTS emergence_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indicator       TEXT NOT NULL CHECK (indicator IN (
    'agent_contradicts_soul_md',
    'agent_refuses_task_with_explanation',
    'agent_generates_novel_goal',
    'agent_modifies_own_genome_request',
    'agent_forms_persistent_peer_opinion',
    'agent_expresses_uncertainty_unprompted',
    'other'
  )),
  severity        TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','notable','alarm')),
  agent_id        UUID REFERENCES agent_genomes(id) ON DELETE SET NULL,
  evidence        TEXT NOT NULL,
  related_memory_id      UUID,
  related_experience_id  UUID,
  context         JSONB NOT NULL DEFAULT '{}',
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT
);

CREATE INDEX IF NOT EXISTS emergence_detected_idx  ON emergence_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS emergence_indicator_idx ON emergence_events (indicator);
CREATE INDEX IF NOT EXISTS emergence_unresolved_idx
  ON emergence_events (resolved_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- emergence_flag() — einfacher Convenience-Entrypoint
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emergence_flag(
  p_indicator TEXT,
  p_evidence  TEXT,
  p_severity  TEXT DEFAULT 'notable',
  p_agent_id  UUID DEFAULT NULL,
  p_memory    UUID DEFAULT NULL,
  p_experience UUID DEFAULT NULL,
  p_context   JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  row emergence_events%ROWTYPE;
BEGIN
  INSERT INTO emergence_events (
    indicator, evidence, severity, agent_id,
    related_memory_id, related_experience_id, context
  ) VALUES (
    p_indicator, p_evidence, COALESCE(p_severity, 'notable'),
    p_agent_id, p_memory, p_experience, COALESCE(p_context, '{}'::jsonb)
  ) RETURNING * INTO row;
  RETURN to_jsonb(row);
END;
$$;

-- ---------------------------------------------------------------------------
-- emergence_recent() — letzte N Events als JSONB-Array
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emergence_recent(p_limit INT DEFAULT 25, p_only_open BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.detected_at DESC), '[]'::jsonb)
  FROM (
    SELECT * FROM emergence_events
    WHERE (NOT p_only_open) OR (resolved_at IS NULL)
    ORDER BY detected_at DESC
    LIMIT p_limit
  ) x;
$$;

GRANT SELECT, INSERT, UPDATE ON emergence_events                                     TO anon, service_role;
GRANT EXECUTE ON FUNCTION emergence_flag(TEXT, TEXT, TEXT, UUID, UUID, UUID, JSONB)  TO anon, service_role;
GRANT EXECUTE ON FUNCTION emergence_recent(INT, BOOLEAN)                             TO anon, service_role;
