-- 022_motivation.sql — Schicht 4 der Cognitive Architecture: Motivation Engine
--
-- Reibung mit der Aussenwelt erzeugt Motivation. Ohne externe Reize lebt der
-- Agent im Vakuum. Diese Migration legt drei Tabellen an:
--
--   stimulus_sources  — wo Reize herkommen (HackerNews, RSS, git activity, ...)
--   stimuli           — einzelne eingesammelte Reize, gescored nach Relevanz
--   generated_tasks   — wenn ein Stimulus die 'act'-Schwelle reisst, formuliert
--                       die Engine einen Task. Dieser wartet auf Approval.
--
-- Die eigentliche Schleife (collect → score → generate → drift) laeuft im
-- Python-Sidecar ai.openclaw.motivation. Dieser hier stellt nur das
-- persistente Substrat + ein paar Hilfs-RPCs bereit.

-- ---------------------------------------------------------------------------
-- stimulus_sources — konfigurierbare Reiz-Quellen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stimulus_sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type       TEXT NOT NULL,
  label             TEXT NOT NULL,
  url               TEXT,
  interval_minutes  INTEGER NOT NULL DEFAULT 60,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  last_fetched_at   TIMESTAMPTZ,
  last_error        TEXT,
  config            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, label)
);

-- Defaults. HackerNews + GitHub Trending + git activity reichen als Startset.
-- RSS-Feeds kann der Operator jederzeit dazunehmen via dashboard.
INSERT INTO stimulus_sources (source_type, label, url, interval_minutes, config) VALUES
  ('hackernews',      'HackerNews Top 20',           NULL, 60,
    '{"limit": 20}'::jsonb),
  ('github_trending', 'GitHub Trending (daily)',     NULL, 360,
    '{"since": "daily"}'::jsonb),
  ('git_activity',    'Local repos (~/Developer)',   NULL, 60,
    '{"max_depth": 2, "window_hours": 24}'::jsonb)
ON CONFLICT (source_type, label) DO NOTHING;

-- ---------------------------------------------------------------------------
-- stimuli — eingesammelte Reize (mit Embedding + Score)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stimuli (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      UUID REFERENCES stimulus_sources(id) ON DELETE SET NULL,
  source_type    TEXT NOT NULL,
  external_id    TEXT,                             -- Dedup-Schluessel (HN-id, URL, commit-sha)
  title          TEXT,
  content        TEXT,
  url            TEXT,
  embedding      VECTOR(768),
  metadata       JSONB NOT NULL DEFAULT '{}',
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Scoring (4 Komponenten + Gesamt + Band)
  memory_score   DOUBLE PRECISION,
  affect_score   DOUBLE PRECISION,
  soul_score     DOUBLE PRECISION,
  task_score     DOUBLE PRECISION,
  relevance      DOUBLE PRECISION,
  band           TEXT CHECK (band IN ('ignore','log','explore','act','urgent')),
  scored_at      TIMESTAMPTZ,
  -- Lifecycle
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','scored','task_generated','dismissed','acted')),
  UNIQUE (source_type, external_id)
);

CREATE INDEX IF NOT EXISTS stimuli_collected_idx  ON stimuli (collected_at DESC);
CREATE INDEX IF NOT EXISTS stimuli_band_idx       ON stimuli (band);
CREATE INDEX IF NOT EXISTS stimuli_status_idx     ON stimuli (status);
CREATE INDEX IF NOT EXISTS stimuli_source_idx     ON stimuli (source_type);
CREATE INDEX IF NOT EXISTS stimuli_embedding_hnsw
  ON stimuli USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- generated_tasks — vom Agenten selbst formulierte Aufgaben
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generated_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stimulus_id    UUID REFERENCES stimuli(id) ON DELETE SET NULL,
  task_text      TEXT NOT NULL,
  rationale      TEXT,
  relevance      DOUBLE PRECISION,
  source_type    TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','approved','dismissed','in_progress','done','abandoned')),
  drift_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
  approved_by    TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dormant_since  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS generated_tasks_status_idx ON generated_tasks (status);
CREATE INDEX IF NOT EXISTS generated_tasks_created_idx ON generated_tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS generated_tasks_drift_idx   ON generated_tasks (drift_score DESC);

-- ---------------------------------------------------------------------------
-- motivation_stats() — Panel-Daten fuers Dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motivation_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  by_band JSONB;
  by_status JSONB;
  by_task_status JSONB;
  sources JSONB;
BEGIN
  SELECT COALESCE(jsonb_object_agg(band, n), '{}'::jsonb) INTO by_band
    FROM (
      SELECT band, COUNT(*) n FROM stimuli
      WHERE band IS NOT NULL
        AND collected_at > NOW() - INTERVAL '7 days'
      GROUP BY band
    ) t;

  SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) INTO by_status
    FROM (SELECT status, COUNT(*) n FROM stimuli GROUP BY status) t;

  SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) INTO by_task_status
    FROM (SELECT status, COUNT(*) n FROM generated_tasks GROUP BY status) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'source_type', source_type, 'label', label,
    'enabled', enabled, 'interval_minutes', interval_minutes,
    'last_fetched_at', last_fetched_at, 'last_error', last_error
  ) ORDER BY source_type, label), '[]'::jsonb) INTO sources
  FROM stimulus_sources;

  RETURN jsonb_build_object(
    'stimuli_by_band_7d',     by_band,
    'stimuli_by_status_total', by_status,
    'tasks_by_status',        by_task_status,
    'sources',                sources,
    'generated_at',           NOW()
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- motivation_drift_scan() — aktualisiert drift_score fuer alle 'proposed' Tasks
--
-- Formel: drift = min(1, log(days_dormant + 1) / log(30))
-- dormant_since wird bei Status-Change vom Sidecar/MCP gesetzt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motivation_drift_scan()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  updated INT;
  urgent INT;
BEGIN
  UPDATE generated_tasks
  SET drift_score = LEAST(1.0,
                          LN(EXTRACT(EPOCH FROM (NOW() - dormant_since))/86400.0 + 1.0)
                          / LN(30.0))
  WHERE status = 'proposed';
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT COUNT(*) INTO urgent FROM generated_tasks
  WHERE status = 'proposed' AND drift_score > 0.7;

  RETURN jsonb_build_object(
    'scanned_at', NOW(),
    'proposed_updated', updated,
    'urgent', urgent
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- update_generated_task_status() — Helper: sauberer Status-Change (bumped
-- updated_at + dormant_since-Reset bei Approval)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_generated_task_status(
  p_task_id UUID,
  p_status  TEXT,
  p_approved_by TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  row generated_tasks%ROWTYPE;
BEGIN
  UPDATE generated_tasks SET
    status        = p_status,
    approved_by   = COALESCE(p_approved_by, approved_by),
    updated_at    = NOW(),
    dormant_since = CASE WHEN p_status <> 'proposed' THEN NOW() ELSE dormant_since END,
    drift_score   = CASE WHEN p_status <> 'proposed' THEN 0 ELSE drift_score END
  WHERE id = p_task_id
  RETURNING * INTO row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'generated_task % not found', p_task_id;
  END IF;

  RETURN to_jsonb(row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Berechtigungen
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON stimulus_sources  TO anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON stimuli           TO anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON generated_tasks   TO anon, service_role;
GRANT EXECUTE ON FUNCTION motivation_stats()                                 TO anon, service_role;
GRANT EXECUTE ON FUNCTION motivation_drift_scan()                            TO anon, service_role;
GRANT EXECUTE ON FUNCTION update_generated_task_status(UUID, TEXT, TEXT)     TO anon, service_role;
