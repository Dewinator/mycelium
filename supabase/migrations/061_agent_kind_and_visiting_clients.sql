-- 061_agent_kind_and_visiting_clients.sql
--
-- Per-client agents in the registry.
--
-- Until now the `agents` table held one row per *server process* (label='main').
-- Every connected MCP client (Claude Code, openClaw, Cursor, Codex, …) was
-- invisible — they all shared the same row because the label was hardcoded
-- via OPENCLAW_AGENT_LABEL.
--
-- This migration:
--   1. Adds `agents.kind` ('server' | 'client-session') so the dashboard can
--      distinguish always-on backend processes from transient LLM sessions.
--   2. Seeds a fallback genome `visiting-client` so unknown client labels can
--      register without manual genome creation.
--   3. Adds an optional p_kind parameter to `agent_register(...)`.
--   4. Surfaces `kind` from `agents_live()`.
--   5. Adds `sweep_stale_client_sessions(p_max_age_hours)` for nightly GC.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'server'
    CHECK (kind IN ('server','client-session'));

CREATE INDEX IF NOT EXISTS agents_kind_idx ON agents (kind);

-- Fallback genome for visiting MCP clients. Neutral defaults; provenance is
-- documented in `notes`. Idempotent.
INSERT INTO agent_genomes (
  label, generation, values, interests,
  curiosity_baseline, frustration_threshold, exploration_rate, risk_tolerance,
  mutation_rate, notes
) VALUES (
  'visiting-client',
  1,
  ARRAY['ehrlich','konkret','ownership','neugierig','respektvoll','praktisch'],
  ARRAY['mcp-client','llm-session'],
  0.55, 0.70, 0.55, 0.45,
  0.05,
  'Auto-fallback genome for MCP clients (Claude Code / Cursor / Codex / openClaw / …) that connect without an explicit genome. Inherits Gen-1 main traits.'
)
ON CONFLICT (label) DO NOTHING;

-- ---------------------------------------------------------------------------
-- agent_register(...) — now accepts p_kind and (optionally) auto-creates the
-- genome when a client connects with a fresh label and no genome exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_register(
  p_label           TEXT,
  p_genome_label    TEXT,
  p_workspace_path  TEXT,
  p_host            TEXT,
  p_version         TEXT DEFAULT NULL,
  p_gateway_url     TEXT DEFAULT NULL,
  p_ports           JSONB DEFAULT '{}'::jsonb,
  p_capabilities    TEXT[] DEFAULT '{}',
  p_metadata        JSONB DEFAULT '{}'::jsonb,
  p_kind            TEXT DEFAULT 'server'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_genome_id UUID;
  v_row       agents%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('server','client-session') THEN
    RAISE EXCEPTION 'invalid kind %, expected server|client-session', p_kind;
  END IF;

  SELECT id INTO v_genome_id FROM agent_genomes WHERE label = p_genome_label;

  -- Client sessions get a transparent fallback to `visiting-client` if the
  -- requested genome doesn't exist. Server kind keeps the strict check —
  -- backend processes must run a defined genome.
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
$$;

-- ---------------------------------------------------------------------------
-- agents_live() — now includes kind
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agents_live()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.live DESC, x.kind, x.label), '[]'::jsonb)
  FROM (
    SELECT
      a.id, a.label, a.kind, a.workspace_path, a.host, a.version, a.gateway_url,
      a.ports, a.status, a.last_heartbeat, a.started_at, a.stopped_at,
      a.capabilities, a.metadata,
      _agent_is_live(a.last_heartbeat) AS live,
      g.id    AS genome_id,
      g.label AS genome_label,
      g.generation,
      (SELECT f.fitness FROM agent_fitness_history f
         WHERE f.genome_id = g.id
         ORDER BY f.computed_at DESC LIMIT 1) AS latest_fitness
    FROM agents a
    JOIN agent_genomes g ON g.id = a.genome_id
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- sweep_stale_client_sessions(...) — hard-delete client-session rows that
-- have been offline longer than p_max_age_hours. Server rows are never
-- deleted by this sweep (they may be intentionally idle).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sweep_stale_client_sessions(p_max_age_hours INT DEFAULT 24)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  n INT;
BEGIN
  DELETE FROM agents
  WHERE kind = 'client-session'
    AND (last_heartbeat IS NULL OR last_heartbeat < NOW() - (p_max_age_hours || ' hours')::INTERVAL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION agent_register(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], JSONB, TEXT
) TO anon, service_role;
GRANT EXECUTE ON FUNCTION sweep_stale_client_sessions(INT) TO anon, service_role;
