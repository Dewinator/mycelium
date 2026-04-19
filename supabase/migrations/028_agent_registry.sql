-- 028_agent_registry.sql — Live-Registry aller OpenClaw-Instanzen
--
-- Jede Instanz registriert sich beim Start (agent_register), pingt alle 30s
-- (agent_heartbeat), und de-registriert sich bei sauberem Shutdown. Das
-- Dashboard zeigt "wer ist gerade online" + "mit wem kann ich paaren".
--
-- Separation agent_genomes (DNA) vs. agents (Runtime-Instanzen):
--   - agent_genomes: persistentes "Wesen" (values, traits, vererbtes Wissen)
--   - agents:        die gerade laufende Instanz eines Genoms auf einem Host,
--                    mit Ports und Heartbeat. Mehrere Hosts koennen dasselbe
--                    Genome fahren (Replikation); Paarung bezieht sich auf
--                    genome_id, nicht agent_id.

CREATE TABLE IF NOT EXISTS agents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genome_id           UUID NOT NULL REFERENCES agent_genomes(id) ON DELETE CASCADE,
  label               TEXT NOT NULL UNIQUE,           -- z.b. "main", "dev-agent", "aios-lead"
  workspace_path      TEXT NOT NULL,                  -- ~/.openclaw/workspace etc.
  host                TEXT NOT NULL,                  -- hostname des Mac/Mini
  version             TEXT,                           -- MCP-Server-Version
  gateway_url         TEXT,                           -- ws:// oder http:// Gateway des Agenten
  ports               JSONB NOT NULL DEFAULT '{}',    -- { gateway, belief, motivation, cockpit, dashboard }
  status              TEXT NOT NULL DEFAULT 'starting'
                      CHECK (status IN ('starting','online','idle','stopping','offline')),
  last_heartbeat      TIMESTAMPTZ,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at          TIMESTAMPTZ,
  capabilities        TEXT[] NOT NULL DEFAULT '{}',   -- "vision", "cockpit", "gateway", ...
  metadata            JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS agents_status_idx     ON agents (status);
CREATE INDEX IF NOT EXISTS agents_heartbeat_idx  ON agents (last_heartbeat DESC);
CREATE INDEX IF NOT EXISTS agents_genome_idx     ON agents (genome_id);

-- Freshness-Fenster: wenn 120s kein heartbeat, gilt der Agent als offline.
-- Das ist grosszuegig genug dass ein 30s-Heartbeat einmal ausfallen kann.
CREATE OR REPLACE FUNCTION _agent_is_live(p_last TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE AS $$
  SELECT p_last IS NOT NULL AND p_last > NOW() - INTERVAL '120 seconds';
$$;

-- ---------------------------------------------------------------------------
-- agent_register(...) — Instanz-Start
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
  p_metadata        JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_genome_id UUID;
  v_row       agents%ROWTYPE;
BEGIN
  SELECT id INTO v_genome_id FROM agent_genomes WHERE label = p_genome_label;
  IF v_genome_id IS NULL THEN
    RAISE EXCEPTION 'genome % not found', p_genome_label;
  END IF;

  INSERT INTO agents (
    genome_id, label, workspace_path, host, version,
    gateway_url, ports, status, last_heartbeat, started_at,
    capabilities, metadata
  ) VALUES (
    v_genome_id, p_label, p_workspace_path, p_host, p_version,
    p_gateway_url, p_ports, 'online', NOW(), NOW(),
    COALESCE(p_capabilities, '{}'), COALESCE(p_metadata, '{}'::jsonb)
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
    metadata       = agents.metadata || EXCLUDED.metadata
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- agent_heartbeat(...) — nur Zeit aktualisieren, idempotent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_heartbeat(
  p_label   TEXT,
  p_status  TEXT DEFAULT NULL        -- 'online' | 'idle' | 'stopping'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row agents%ROWTYPE;
BEGIN
  UPDATE agents SET
    last_heartbeat = NOW(),
    status         = COALESCE(p_status, status)
  WHERE label = p_label
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent % not registered', p_label;
  END IF;
  RETURN jsonb_build_object(
    'label', v_row.label,
    'status', v_row.status,
    'last_heartbeat', v_row.last_heartbeat,
    'live', _agent_is_live(v_row.last_heartbeat)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- agent_deregister(...) — sauberer Shutdown
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_deregister(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agents SET
    status     = 'offline',
    stopped_at = NOW()
  WHERE label = p_label;
  RETURN jsonb_build_object('label', p_label, 'status', 'offline');
END;
$$;

-- ---------------------------------------------------------------------------
-- agents_live() — Dashboard-Ansicht: alle Agenten + Live-Flag + Genome-Joins
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agents_live()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.live DESC, x.label), '[]'::jsonb)
  FROM (
    SELECT
      a.id, a.label, a.workspace_path, a.host, a.version, a.gateway_url,
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
-- sweep_stale_agents() — Cron-Helper: setzt alte Agenten auf offline
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sweep_stale_agents(p_stale_minutes INT DEFAULT 5)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  n INT;
BEGIN
  UPDATE agents SET status = 'offline', stopped_at = NOW()
  WHERE status <> 'offline'
    AND (last_heartbeat IS NULL OR last_heartbeat < NOW() - (p_stale_minutes || ' minutes')::INTERVAL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON agents  TO anon, service_role;
GRANT EXECUTE ON FUNCTION _agent_is_live(TIMESTAMPTZ)                                            TO anon, service_role;
GRANT EXECUTE ON FUNCTION agent_register(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], JSONB) TO anon, service_role;
GRANT EXECUTE ON FUNCTION agent_heartbeat(TEXT, TEXT)                                            TO anon, service_role;
GRANT EXECUTE ON FUNCTION agent_deregister(TEXT)                                                 TO anon, service_role;
GRANT EXECUTE ON FUNCTION agents_live()                                                          TO anon, service_role;
GRANT EXECUTE ON FUNCTION sweep_stale_agents(INT)                                                TO anon, service_role;
