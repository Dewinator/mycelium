-- 061_agent_kind.sql
-- Drift-Reparatur: agents.kind + visiting-client genome + 10-param agent_register.
-- Existiert bereits in der historischen main-DB (manuell eingebracht), war aber nie
-- als Migration getrackt. Idempotent — sicher fuer beide DBs.

-- ── 1. agents.kind Spalte ──────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS kind TEXT;
UPDATE agents SET kind = 'server' WHERE kind IS NULL;
ALTER TABLE agents ALTER COLUMN kind SET DEFAULT 'server';
ALTER TABLE agents ALTER COLUMN kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agents'::regclass AND conname = 'agents_kind_check'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_kind_check
      CHECK (kind IN ('server', 'client-session'));
  END IF;
END $$;

-- ── 2. visiting-client Fallback-Genome ────────────────
INSERT INTO agent_genomes (
  label, generation, status, values, interests,
  curiosity_baseline, frustration_threshold, exploration_rate,
  risk_tolerance, mutation_rate, base_model, teacher_model, provider,
  inheritance_mode, notes
) VALUES (
  'visiting-client', 1, 'active',
  ARRAY['ehrlich','konkret','ownership','neugierig','respektvoll','praktisch'],
  ARRAY['mcp-client','llm-session'],
  0.55, 0.7, 0.55, 0.45, 0.05,
  'claude-sonnet-4-6', 'claude-opus-4-7', 'anthropic',
  'full',
  'Auto-fallback genome for MCP clients (Claude Code / Cursor / Codex / openClaw / …) that connect without an explicit genome. Inherits Gen-1 main traits.'
)
ON CONFLICT (label) DO NOTHING;

-- ── 3. agent_register mit p_kind ──────────────────────
CREATE OR REPLACE FUNCTION public.agent_register(
  p_label          TEXT,
  p_genome_label   TEXT,
  p_workspace_path TEXT,
  p_host           TEXT,
  p_version        TEXT  DEFAULT NULL,
  p_gateway_url    TEXT  DEFAULT NULL,
  p_ports          JSONB DEFAULT '{}'::jsonb,
  p_capabilities   TEXT[] DEFAULT '{}'::text[],
  p_metadata       JSONB DEFAULT '{}'::jsonb,
  p_kind           TEXT  DEFAULT 'server'
) RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_genome_id UUID;
  v_row       agents%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('server','client-session') THEN
    RAISE EXCEPTION 'invalid kind %, expected server|client-session', p_kind;
  END IF;

  SELECT id INTO v_genome_id FROM agent_genomes WHERE label = p_genome_label;

  -- Client-Sessions fallen transparent auf 'visiting-client' zurueck, wenn der
  -- gewuenschte Genome nicht existiert. Server-kind bleibt strict.
  IF v_genome_id IS NULL AND p_kind = 'client-session' THEN
    SELECT id INTO v_genome_id FROM agent_genomes WHERE label = 'visiting-client';
  END IF;

  IF v_genome_id IS NULL THEN
    RAISE EXCEPTION 'genome % not found', p_genome_label;
  END IF;

  INSERT INTO agents (
    genome_id, label, workspace_path, host, version,
    gateway_url, ports, status, last_heartbeat, started_at,
    capabilities, metadata, kind
  ) VALUES (
    v_genome_id, p_label, p_workspace_path, p_host, p_version,
    p_gateway_url, p_ports, 'online', NOW(), NOW(),
    COALESCE(p_capabilities, '{}'), COALESCE(p_metadata, '{}'::jsonb), p_kind
  )
  ON CONFLICT (label) DO UPDATE SET
    genome_id      = EXCLUDED.genome_id,
    workspace_path = EXCLUDED.workspace_path,
    host           = EXCLUDED.host,
    version        = COALESCE(EXCLUDED.version, agents.version),
    gateway_url    = COALESCE(EXCLUDED.gateway_url, agents.gateway_url),
    ports          = EXCLUDED.ports,
    status         = 'online',
    last_heartbeat = NOW(),
    started_at     = NOW(),
    stopped_at     = NULL,
    capabilities   = EXCLUDED.capabilities,
    metadata       = agents.metadata || EXCLUDED.metadata,
    kind           = EXCLUDED.kind
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_register(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT[],JSONB,TEXT)
  TO anon, service_role;

NOTIFY pgrst, 'reload schema';
