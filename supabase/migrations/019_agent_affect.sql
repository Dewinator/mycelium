-- 019_agent_affect.sql — Agent-wide Affective State (Ebene 1b der Cognitive Architecture)
--
-- Bisher: `mood()` berechnet Stimmung aus dem Rolling-Window der letzten N Stunden
-- Experiences. Das ist reaktiv und nicht persistent — jeder Aufruf liest neu aus.
--
-- Neu: vier persistente Regelvariablen (curiosity, frustration, satisfaction,
-- confidence) die als Singleton-Row gehalten werden. Sie werden durch
-- Memory-Events (remember / recall / experience outcomes) additiv aktualisiert
-- und beeinflussen im Gegenzug das Recall-Verhalten (k, score-threshold,
-- include-adjacent-tags). Das ist funktionale Äquivalenz zur Amygdala-Schleife:
-- Frustration triggert breitere Suche, Confidence verengt Suche, Curiosity
-- explodiert den Radius.

-- ---------------------------------------------------------------------------
-- Tabelle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_affect (
  id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  curiosity             DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (curiosity    BETWEEN 0 AND 1),
  frustration           DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (frustration  BETWEEN 0 AND 1),
  satisfaction          DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (satisfaction BETWEEN 0 AND 1),
  confidence            DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (confidence   BETWEEN 0 AND 1),
  decay_half_life_hours DOUBLE PRECISION NOT NULL DEFAULT 12,
  updated_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  last_event            TEXT
);

-- Singleton-Row anlegen falls nicht vorhanden. idempotent.
INSERT INTO agent_affect (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Hilfsfunktion: sanftes Clampen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _affect_clamp(v DOUBLE PRECISION)
RETURNS DOUBLE PRECISION
LANGUAGE SQL IMMUTABLE AS $$
  SELECT GREATEST(0.0, LEAST(1.0, v));
$$;

-- ---------------------------------------------------------------------------
-- affect_get() — aktuellen Zustand lesen (mit impliziter Zeit-Dekay auf
-- frustration, damit Stress nicht ewig hängen bleibt)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION affect_get()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s agent_affect%ROWTYPE;
  hours_since DOUBLE PRECISION;
  decay_factor DOUBLE PRECISION;
BEGIN
  SELECT * INTO s FROM agent_affect WHERE id = 1;
  hours_since  := EXTRACT(EPOCH FROM NOW() - s.updated_at) / 3600.0;
  decay_factor := power(0.5, hours_since / GREATEST(0.1, s.decay_half_life_hours));
  RETURN jsonb_build_object(
    'curiosity',     s.curiosity,
    'frustration',   _affect_clamp(s.frustration * decay_factor),
    'satisfaction',  s.satisfaction,
    'confidence',    s.confidence,
    'decay_factor',  decay_factor,
    'updated_at',    s.updated_at,
    'hours_since',   hours_since,
    'last_event',    s.last_event
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- affect_apply(event, intensity) — Update-Regeln (siehe CLAUDE.md der
-- Erweiterung, Ebene 1b). Gibt den neuen State zurück.
--
-- Events:
--   'success'         → satisfaction↑, frustration↓, confidence↑
--   'failure'         → frustration↑, satisfaction↓, confidence↓, curiosity↑
--   'unknown'         → curiosity↑
--   'recall_empty'    → curiosity↑, confidence↓
--   'recall_rich'     → confidence↑, curiosity↓ (leichte Satisfaction)
--   'recall_touch'    → kein State-Change, nur updated_at refreshen
--   'novel_encoding'  → curiosity↑ (etwas Neues wurde gespeichert)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION affect_apply(p_event TEXT, p_intensity DOUBLE PRECISION DEFAULT 0.1)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  i DOUBLE PRECISION := GREATEST(0.0, LEAST(1.0, COALESCE(p_intensity, 0.1)));
BEGIN
  UPDATE agent_affect SET
    curiosity = CASE p_event
      WHEN 'success'        THEN _affect_clamp(curiosity - 0.05 * i)
      WHEN 'failure'        THEN _affect_clamp(curiosity + 0.10 * i)
      WHEN 'unknown'        THEN _affect_clamp(curiosity + 0.20 * i)
      WHEN 'recall_empty'   THEN _affect_clamp(curiosity + 0.20 * i)
      WHEN 'recall_rich'    THEN _affect_clamp(curiosity - 0.05 * i)
      WHEN 'novel_encoding' THEN _affect_clamp(curiosity + 0.05 * i)
      ELSE curiosity
    END,
    frustration = CASE p_event
      WHEN 'success'        THEN _affect_clamp(frustration * (1.0 - 0.40 * i))
      WHEN 'failure'        THEN _affect_clamp(frustration + 0.15 * i)
      WHEN 'recall_empty'   THEN _affect_clamp(frustration + 0.05 * i)
      WHEN 'recall_rich'    THEN _affect_clamp(frustration * (1.0 - 0.10 * i))
      ELSE frustration
    END,
    satisfaction = CASE p_event
      WHEN 'success'        THEN _affect_clamp(satisfaction + 0.20 * i)
      WHEN 'failure'        THEN _affect_clamp(satisfaction - 0.10 * i)
      WHEN 'recall_rich'    THEN _affect_clamp(satisfaction + 0.05 * i)
      ELSE satisfaction
    END,
    confidence = CASE p_event
      WHEN 'success'        THEN _affect_clamp(confidence + 0.10 * i)
      WHEN 'failure'        THEN _affect_clamp(confidence - 0.10 * i)
      WHEN 'recall_empty'   THEN _affect_clamp(confidence - 0.10 * i)
      WHEN 'recall_rich'    THEN _affect_clamp(confidence + 0.10 * i)
      ELSE confidence
    END,
    last_event = p_event,
    updated_at = NOW()
  WHERE id = 1;

  RETURN affect_get();
END;
$$;

-- ---------------------------------------------------------------------------
-- affect_reset() — Notbremse (für Dev/Tests). Setzt alles auf Defaults zurück.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION affect_reset()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agent_affect SET
    curiosity    = 0.5,
    frustration  = 0.0,
    satisfaction = 0.5,
    confidence   = 0.5,
    last_event   = 'reset',
    updated_at   = NOW()
  WHERE id = 1;
  RETURN affect_get();
END;
$$;

-- ---------------------------------------------------------------------------
-- Berechtigungen — dieselbe Konvention wie 011_service_role.sql / 005_anon
-- ---------------------------------------------------------------------------
GRANT SELECT, UPDATE ON agent_affect TO anon, service_role;
GRANT EXECUTE ON FUNCTION affect_get()                                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION affect_apply(TEXT, DOUBLE PRECISION)          TO anon, service_role;
GRANT EXECUTE ON FUNCTION affect_reset()                                TO anon, service_role;
