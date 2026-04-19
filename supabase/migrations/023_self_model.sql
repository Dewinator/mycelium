-- 023_self_model.sql — Schicht 5a: Dynamisches Selbstmodell
--
-- Der Agent beobachtet sein eigenes Verhalten (ueber Experiences + Memories)
-- und pflegt daraus ein sich wandelndes Selbstbild. Diese Migration legt:
--
--   self_model_snapshots  — Historie der abgeleiteten Selbstbeschreibungen
--   self_model_current()  — RPC: liefert die jeweils letzte Version
--   self_model_record()   — RPC: persistiert ein neues Snapshot-Set
--
-- Die Extraktion selbst macht der MCP-Server (nutzt experiences / memories /
-- traits). Hier liegt nur das Substrat + eine sprechende View.

CREATE TABLE IF NOT EXISTS self_model_snapshots (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_days        INTEGER NOT NULL DEFAULT 30,
  based_on_n         INTEGER NOT NULL DEFAULT 0,
  strengths          TEXT[] NOT NULL DEFAULT '{}',
  weaknesses         TEXT[] NOT NULL DEFAULT '{}',
  growth_areas       TEXT[] NOT NULL DEFAULT '{}',
  open_questions     TEXT[] NOT NULL DEFAULT '{}',
  method             TEXT NOT NULL DEFAULT 'heuristic',
  summary            TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS self_model_snapshots_time_idx
  ON self_model_snapshots (created_at DESC);

-- ---------------------------------------------------------------------------
-- self_model_current() — letzter Snapshot + bisher unveraenderte Statik-Felder
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION self_model_current()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  row self_model_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO row FROM self_model_snapshots
    ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'exists', false,
      'strengths', '[]'::jsonb,
      'weaknesses', '[]'::jsonb,
      'growth_areas', '[]'::jsonb,
      'open_questions', '[]'::jsonb
    );
  END IF;
  RETURN jsonb_build_object(
    'exists',          true,
    'id',              row.id,
    'created_at',      row.created_at,
    'window_days',     row.window_days,
    'based_on_n',      row.based_on_n,
    'strengths',       to_jsonb(row.strengths),
    'weaknesses',      to_jsonb(row.weaknesses),
    'growth_areas',    to_jsonb(row.growth_areas),
    'open_questions',  to_jsonb(row.open_questions),
    'method',          row.method,
    'summary',         row.summary,
    'metadata',        row.metadata
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- self_model_record(...) — neuen Snapshot persistieren
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION self_model_record(
  p_window_days INTEGER,
  p_based_on_n  INTEGER,
  p_strengths   TEXT[],
  p_weaknesses  TEXT[],
  p_growth      TEXT[],
  p_questions   TEXT[],
  p_method      TEXT,
  p_summary     TEXT,
  p_metadata    JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  row self_model_snapshots%ROWTYPE;
BEGIN
  INSERT INTO self_model_snapshots (
    window_days, based_on_n, strengths, weaknesses,
    growth_areas, open_questions, method, summary, metadata
  )
  VALUES (
    COALESCE(p_window_days, 30), COALESCE(p_based_on_n, 0),
    COALESCE(p_strengths, '{}'), COALESCE(p_weaknesses, '{}'),
    COALESCE(p_growth, '{}'),    COALESCE(p_questions, '{}'),
    COALESCE(p_method, 'heuristic'), p_summary,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO row;
  RETURN to_jsonb(row);
END;
$$;

GRANT SELECT, INSERT ON self_model_snapshots TO anon, service_role;
GRANT EXECUTE ON FUNCTION self_model_current() TO anon, service_role;
GRANT EXECUTE ON FUNCTION self_model_record(
  INTEGER, INTEGER, TEXT[], TEXT[], TEXT[], TEXT[], TEXT, TEXT, JSONB
) TO anon, service_role;
