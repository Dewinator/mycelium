-- 020_experience_causes.sql — Kausale Annotation-Schicht.
--
-- Ziel: explizite Ursache→Wirkung-Kanten zwischen Experiences, mit Unterstützung
-- für auto-vorgeschlagene Kandidaten (confidence=0.3) und vom Agent/User
-- bestätigte Kanten (confidence ≥ 0.6). Folgen beim recall der Kette: "was
-- hat zu dieser Episode geführt" / "was ist daraus entstanden".
--
-- Kein echtes Pearl-Kausalmodell — das ist eine *Annotations-Schicht* auf
-- bestehenden Experiences. LLM-freundlich: der Agent sieht "A führte zu B"
-- statt nur "A und B sind beide passiert".

-- ---------------------------------------------------------------------------
-- Tabelle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experience_causes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cause_id       UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  effect_id      UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL DEFAULT 'caused'
                   CHECK (relation IN ('caused', 'enabled', 'prevented', 'contributed')),
  confidence     DOUBLE PRECISION NOT NULL DEFAULT 0.3 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count INTEGER NOT NULL DEFAULT 1 CHECK (evidence_count >= 1),
  source         TEXT NOT NULL DEFAULT 'auto_suggest'
                   CHECK (source IN ('auto_suggest', 'digest_extracted', 'explicit', 'user_confirmed')),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_cause CHECK (cause_id <> effect_id),
  CONSTRAINT unique_relation UNIQUE (cause_id, effect_id, relation)
);

CREATE INDEX IF NOT EXISTS experience_causes_cause_idx     ON experience_causes (cause_id);
CREATE INDEX IF NOT EXISTS experience_causes_effect_idx    ON experience_causes (effect_id);
CREATE INDEX IF NOT EXISTS experience_causes_confidence_idx ON experience_causes (confidence DESC);

-- ---------------------------------------------------------------------------
-- suggest_causes(effect_id, window_hours) — plausible Ursachen für eine
-- Episode finden: Experiences vor dem Effekt, innerhalb eines Zeitfensters,
-- mit hoher semantischer Ähnlichkeit. Returned nur *Kandidaten*, fügt nicht
-- automatisch ein.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION suggest_causes(
  p_effect_id    UUID,
  p_window_hours DOUBLE PRECISION DEFAULT 48.0,
  p_min_similarity DOUBLE PRECISION DEFAULT 0.55,
  p_max_results  INT DEFAULT 5
)
RETURNS TABLE (
  cause_id    UUID,
  summary     TEXT,
  similarity  DOUBLE PRECISION,
  age_hours   DOUBLE PRECISION,
  outcome     TEXT,
  confidence_hint DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_embedding VECTOR(768);
  v_created_at TIMESTAMPTZ;
BEGIN
  SELECT embedding, created_at INTO v_embedding, v_created_at
    FROM experiences WHERE id = p_effect_id;

  IF v_embedding IS NULL THEN
    RETURN;  -- no embedding → can't compute similarity
  END IF;

  RETURN QUERY
    SELECT
      e.id,
      LEFT(e.summary, 160),
      (1 - (e.embedding <=> v_embedding))::DOUBLE PRECISION AS sim,
      (EXTRACT(EPOCH FROM (v_created_at - e.created_at)) / 3600.0)::DOUBLE PRECISION,
      e.outcome,
      -- Confidence-Hint: Zeitnähe × Similarity × (stärker wenn cause=failure und
      -- effect=failure, oder cause=success und effect=success).
      LEAST(
        0.9,
        (1 - (e.embedding <=> v_embedding)) * 0.7
        + (1.0 - LEAST(1.0, EXTRACT(EPOCH FROM (v_created_at - e.created_at)) / 3600.0 / p_window_hours)) * 0.3
      )::DOUBLE PRECISION
    FROM experiences e
    WHERE e.id <> p_effect_id
      AND e.embedding IS NOT NULL
      AND e.created_at < v_created_at
      AND e.created_at > v_created_at - (p_window_hours * INTERVAL '1 hour')
      AND (1 - (e.embedding <=> v_embedding)) >= p_min_similarity
    ORDER BY (1 - (e.embedding <=> v_embedding)) DESC
    LIMIT p_max_results;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_cause(cause, effect, relation, confidence, source, note) — idempotent.
-- Bei existierender Kante: evidence_count++, confidence gewichtet gemittelt,
-- last_reinforced_at = NOW(). Kein Duplikat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_cause(
  p_cause_id   UUID,
  p_effect_id  UUID,
  p_relation   TEXT DEFAULT 'caused',
  p_confidence DOUBLE PRECISION DEFAULT 0.6,
  p_source     TEXT DEFAULT 'explicit',
  p_note       TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_cause_id = p_effect_id THEN
    RAISE EXCEPTION 'cause and effect cannot be the same experience';
  END IF;

  INSERT INTO experience_causes (cause_id, effect_id, relation, confidence, source, note)
  VALUES (p_cause_id, p_effect_id, COALESCE(p_relation, 'caused'), p_confidence, p_source, p_note)
  ON CONFLICT (cause_id, effect_id, relation) DO UPDATE SET
    evidence_count     = experience_causes.evidence_count + 1,
    confidence         = LEAST(0.95,
                          (experience_causes.confidence * experience_causes.evidence_count
                           + EXCLUDED.confidence) / (experience_causes.evidence_count + 1)),
    last_reinforced_at = NOW(),
    -- Wenn die neue Quelle stärker ist als die alte, übernehmen
    source             = CASE
                           WHEN EXCLUDED.source IN ('user_confirmed', 'explicit')
                            AND experience_causes.source IN ('auto_suggest', 'digest_extracted')
                           THEN EXCLUDED.source
                           ELSE experience_causes.source
                         END,
    note               = COALESCE(EXCLUDED.note, experience_causes.note)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- causal_chain(root_id, direction, max_depth) — BFS über Kanten, gibt die
-- vollständige Kette mit Tiefe + kumulativer Konfidenz zurück.
-- direction: 'causes' = was hat zu root geführt (rückwärts)
--            'effects' = was ist aus root entstanden (vorwärts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION causal_chain(
  p_root_id   UUID,
  p_direction TEXT DEFAULT 'causes',
  p_max_depth INT  DEFAULT 3
)
RETURNS TABLE (
  experience_id  UUID,
  summary        TEXT,
  outcome        TEXT,
  depth          INT,
  relation       TEXT,
  edge_confidence DOUBLE PRECISION,
  path_confidence DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  WITH RECURSIVE walk AS (
    SELECT
      p_root_id AS experience_id,
      0         AS depth,
      NULL::TEXT AS relation,
      1.0::DOUBLE PRECISION AS edge_confidence,
      1.0::DOUBLE PRECISION AS path_confidence,
      ARRAY[p_root_id] AS visited
    UNION ALL
    SELECT
      CASE WHEN p_direction = 'causes' THEN ec.cause_id ELSE ec.effect_id END,
      walk.depth + 1,
      ec.relation,
      ec.confidence,
      walk.path_confidence * ec.confidence,
      walk.visited || CASE WHEN p_direction = 'causes' THEN ec.cause_id ELSE ec.effect_id END
    FROM walk
    JOIN experience_causes ec
      ON (p_direction = 'causes' AND ec.effect_id = walk.experience_id)
      OR (p_direction = 'effects' AND ec.cause_id  = walk.experience_id)
    WHERE walk.depth < p_max_depth
      AND NOT (CASE WHEN p_direction = 'causes' THEN ec.cause_id ELSE ec.effect_id END
               = ANY (walk.visited))
  )
  SELECT
    w.experience_id,
    LEFT(e.summary, 160) AS summary,
    e.outcome,
    w.depth,
    w.relation,
    w.edge_confidence,
    w.path_confidence
  FROM walk w
  JOIN experiences e ON e.id = w.experience_id
  ORDER BY w.depth, w.path_confidence DESC;
$$;

-- ---------------------------------------------------------------------------
-- Berechtigungen
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON experience_causes TO anon, service_role;
GRANT EXECUTE ON FUNCTION suggest_causes(UUID, DOUBLE PRECISION, DOUBLE PRECISION, INT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION record_cause(UUID, UUID, TEXT, DOUBLE PRECISION, TEXT, TEXT)  TO anon, service_role;
GRANT EXECUTE ON FUNCTION causal_chain(UUID, TEXT, INT)                                  TO anon, service_role;
