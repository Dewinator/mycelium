-- 026_sleep_cycles.sql — Biomimetischer Nightly Consolidation Audit-Trail
--
-- Jeder nightly-Lauf persistiert was er gemacht hat. Das erlaubt dem Dashboard
-- zu zeigen "letztes Mal X Memories consolidiert, Y weak-forgotten, Z Lessons
-- promoted" — wie ein Schlaftagebuch.
--
-- Biologisches Vorbild: SWS (Slow-Wave Sleep) fuer Memory-Consolidation +
-- Synaptic Downscaling (Tononi SHY), REM fuer Pattern-Extraktion und
-- emotionale Verarbeitung. Wir trennen die Phasen, loggen pro Phase eine
-- kurze Struktur, und haben einen Gesamtstatus.

CREATE TABLE IF NOT EXISTS sleep_cycles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  duration_ms        INTEGER,
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','ok','partial','failed')),
  -- phasen-resultate als strukturiertes JSON
  sws_result         JSONB NOT NULL DEFAULT '{}',
  rem_result         JSONB NOT NULL DEFAULT '{}',
  metacog_result     JSONB NOT NULL DEFAULT '{}',
  fitness_result     JSONB NOT NULL DEFAULT '{}',
  -- optionale errors
  errors             JSONB NOT NULL DEFAULT '[]',
  -- host / agent-label das den zyklus ausgefuehrt hat
  agent_label        TEXT NOT NULL DEFAULT 'main',
  trigger_source     TEXT NOT NULL DEFAULT 'launchd'
                     CHECK (trigger_source IN ('launchd','manual','api'))
);

CREATE INDEX IF NOT EXISTS sleep_cycles_started_idx
  ON sleep_cycles (started_at DESC);
CREATE INDEX IF NOT EXISTS sleep_cycles_status_idx
  ON sleep_cycles (status);

-- ---------------------------------------------------------------------------
-- sleep_recent() — letzte N Zyklen als JSONB-Array fuer Dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sleep_recent(p_limit INT DEFAULT 14)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.started_at DESC), '[]'::jsonb)
  FROM (
    SELECT * FROM sleep_cycles
    ORDER BY started_at DESC
    LIMIT p_limit
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- sleep_summary() — aggregierter Ueberblick fuer die letzten 14 Tage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sleep_summary()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  last_run     JSONB;
  stats14      JSONB;
BEGIN
  SELECT to_jsonb(x) INTO last_run
  FROM (
    SELECT * FROM sleep_cycles ORDER BY started_at DESC LIMIT 1
  ) x;

  SELECT jsonb_build_object(
    'runs_total', COUNT(*),
    'runs_ok',    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),
    'runs_fail',  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
    'avg_duration_ms', COALESCE(ROUND(AVG(duration_ms))::INT, 0)
  ) INTO stats14
  FROM sleep_cycles
  WHERE started_at > NOW() - INTERVAL '14 days';

  RETURN jsonb_build_object(
    'last_run', last_run,
    'last_14d', stats14,
    'generated_at', NOW()
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE ON sleep_cycles TO anon, service_role;
GRANT EXECUTE ON FUNCTION sleep_recent(INT)  TO anon, service_role;
GRANT EXECUTE ON FUNCTION sleep_summary()    TO anon, service_role;
