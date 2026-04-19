-- 042_neurochemistry.sql — Biologisch fundierte Affekt-Engine (3 Systeme)
--
-- Ersetzt die 4-Variablen-affect-engine durch Dopamin/Serotonin/Noradrenalin.
-- Rückwärtskompatibilität: affect_get/apply/reset bleiben exponiert, leiten
-- aber intern auf neurochemistry-RPCs um.
--
-- Granularität: pro agent_genome (Kinder erben eigenen Zustand, Eltern behalten
-- ihren). 'main' wird aus existing agent_affect row initialisiert (Inverse der
-- derive*-Formeln aus der Spec).

-- ---------------------------------------------------------------------------
-- Tabelle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_neurochemistry (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_genome_id        UUID NOT NULL UNIQUE REFERENCES agent_genomes(id) ON DELETE CASCADE,

  -- Dopamin (Prediction Error / TD-Learning)
  dopamine_current       DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (dopamine_current BETWEEN 0 AND 1),
  dopamine_baseline      DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (dopamine_baseline BETWEEN 0 AND 1),
  dopamine_prediction    DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (dopamine_prediction BETWEEN 0 AND 1),
  dopamine_lr            DOUBLE PRECISION NOT NULL DEFAULT 0.1
                         CHECK (dopamine_lr BETWEEN 0 AND 1),

  -- Serotonin (Zeithorizont / Geduld)
  serotonin_current      DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (serotonin_current BETWEEN 0 AND 1),
  serotonin_decay_rate   DOUBLE PRECISION NOT NULL DEFAULT 0.02
                         CHECK (serotonin_decay_rate BETWEEN 0 AND 0.5),

  -- Noradrenalin (Arousal / Yerkes-Dodson)
  noradrenaline_current  DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (noradrenaline_current BETWEEN 0 AND 1),
  noradrenaline_optimal  DOUBLE PRECISION NOT NULL DEFAULT 0.5
                         CHECK (noradrenaline_optimal BETWEEN 0 AND 1),

  -- Hilfsvariablen
  consecutive_failures   INT NOT NULL DEFAULT 0
                         CHECK (consecutive_failures >= 0),
  last_event             TEXT,
  last_outcome           DOUBLE PRECISION,
  history                JSONB NOT NULL DEFAULT '[]',   -- max 30 snapshots

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_neurochemistry_genome_idx
  ON agent_neurochemistry (agent_genome_id);

-- ---------------------------------------------------------------------------
-- Clamp helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _nc_clamp(p DOUBLE PRECISION, lo DOUBLE PRECISION DEFAULT 0, hi DOUBLE PRECISION DEFAULT 1)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(lo, LEAST(hi, p));
$$;

-- ---------------------------------------------------------------------------
-- neurochem_get_or_init(label) — ensure row exists, return its id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_get_or_init(p_label TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_gid UUID;
  v_nc_id UUID;
BEGIN
  SELECT id INTO v_gid FROM agent_genomes WHERE label = p_label;
  IF v_gid IS NULL THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  SELECT id INTO v_nc_id FROM agent_neurochemistry WHERE agent_genome_id = v_gid;
  IF v_nc_id IS NULL THEN
    INSERT INTO agent_neurochemistry (agent_genome_id) VALUES (v_gid) RETURNING id INTO v_nc_id;
  END IF;
  RETURN v_nc_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_init_from_parents — Breeding: Kind erbt gewichteten Mittelwert
-- der Eltern-Neurochemie + Gauss-Noise (sigma = mutation_rate).
-- Falls die Eltern noch keine Neurochemie haben, werden sie zuerst initialisiert
-- (mit Defaults — und 'main' hat einen besonderen Backfill aus agent_affect).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_init_from_parents(
  p_child_label     TEXT,
  p_parent_a_label  TEXT,
  p_parent_b_label  TEXT,
  p_mutation_rate   DOUBLE PRECISION DEFAULT 0.05
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_c_id UUID; v_a_id UUID; v_b_id UUID;
  v_a agent_neurochemistry%ROWTYPE;
  v_b agent_neurochemistry%ROWTYPE;
  v_sigma DOUBLE PRECISION := GREATEST(0, LEAST(0.3, p_mutation_rate));
  v_new   agent_neurochemistry%ROWTYPE;
BEGIN
  PERFORM neurochem_get_or_init(p_parent_a_label);
  PERFORM neurochem_get_or_init(p_parent_b_label);
  v_c_id := neurochem_get_or_init(p_child_label);

  SELECT * INTO v_a FROM agent_neurochemistry
    WHERE agent_genome_id = (SELECT id FROM agent_genomes WHERE label = p_parent_a_label);
  SELECT * INTO v_b FROM agent_neurochemistry
    WHERE agent_genome_id = (SELECT id FROM agent_genomes WHERE label = p_parent_b_label);

  -- Gaussian noise via Box-Muller (using PG's random())
  UPDATE agent_neurochemistry SET
    dopamine_current      = _nc_clamp( (v_a.dopamine_current      + v_b.dopamine_current)      / 2.0
                                       + sqrt(-2 * ln(random()+1e-9)) * cos(2 * pi() * random()) * v_sigma),
    dopamine_baseline     = _nc_clamp( (v_a.dopamine_baseline     + v_b.dopamine_baseline)     / 2.0 ),
    dopamine_prediction   = _nc_clamp( (v_a.dopamine_prediction   + v_b.dopamine_prediction)   / 2.0 ),
    dopamine_lr           = _nc_clamp( (v_a.dopamine_lr           + v_b.dopamine_lr)           / 2.0 ),
    serotonin_current     = _nc_clamp( (v_a.serotonin_current     + v_b.serotonin_current)     / 2.0
                                       + sqrt(-2 * ln(random()+1e-9)) * cos(2 * pi() * random()) * v_sigma),
    serotonin_decay_rate  = _nc_clamp( (v_a.serotonin_decay_rate  + v_b.serotonin_decay_rate)  / 2.0, 0, 0.5),
    noradrenaline_current = _nc_clamp( (v_a.noradrenaline_current + v_b.noradrenaline_current) / 2.0
                                       + sqrt(-2 * ln(random()+1e-9)) * cos(2 * pi() * random()) * v_sigma),
    noradrenaline_optimal = _nc_clamp( (v_a.noradrenaline_optimal + v_b.noradrenaline_optimal) / 2.0 ),
    consecutive_failures  = 0,
    last_event            = 'born_from_breeding',
    last_outcome          = NULL,
    history               = '[]'::jsonb,
    updated_at            = NOW()
  WHERE id = v_c_id
  RETURNING * INTO v_new;

  RETURN to_jsonb(v_new);
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_apply — alle drei Systeme in einem Aufruf updaten.
-- Events: task_complete | task_failed | novel_stimulus | familiar_task |
--         idle | error | teacher_consulted
-- outcome ist [0..1] oder NULL für rein arousal-basierte Events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_apply(
  p_label       TEXT,
  p_event       TEXT,
  p_outcome     DOUBLE PRECISION DEFAULT NULL,
  p_intensity   DOUBLE PRECISION DEFAULT 1.0
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  s agent_neurochemistry%ROWTYPE;
  v_delta DOUBLE PRECISION := 0;
  v_new_dopamine    DOUBLE PRECISION;
  v_new_prediction  DOUBLE PRECISION;
  v_new_serotonin   DOUBLE PRECISION;
  v_na_delta        DOUBLE PRECISION := 0;
  v_new_na          DOUBLE PRECISION;
  v_new_history     JSONB;
  v_consecutive     INT;
BEGIN
  v_id := neurochem_get_or_init(p_label);
  SELECT * INTO s FROM agent_neurochemistry WHERE id = v_id;

  ----- Dopamin (nur bei Events mit Outcome)
  IF p_outcome IS NOT NULL THEN
    v_delta := p_outcome - s.dopamine_prediction;
    v_new_dopamine   := _nc_clamp(s.dopamine_baseline + v_delta * 2.0);
    v_new_prediction := _nc_clamp(s.dopamine_prediction + s.dopamine_lr * v_delta);
  ELSE
    v_new_dopamine   := s.dopamine_current;
    v_new_prediction := s.dopamine_prediction;
  END IF;

  ----- Serotonin (langsamer Trend Richtung outcome)
  IF p_outcome IS NOT NULL THEN
    v_new_serotonin := _nc_clamp(s.serotonin_current + 0.05 * (p_outcome - s.serotonin_current));
  ELSIF p_event = 'idle' THEN
    v_new_serotonin := _nc_clamp(s.serotonin_current - s.serotonin_decay_rate);
  ELSE
    v_new_serotonin := s.serotonin_current;
  END IF;

  ----- Noradrenalin (Event-getrieben, plus Decay Richtung optimal)
  v_na_delta := CASE p_event
    WHEN 'novel_stimulus'    THEN  0.20 * p_intensity
    WHEN 'error'             THEN  0.25 * p_intensity
    WHEN 'task_failed'       THEN  0.18 * p_intensity
    WHEN 'task_complete'     THEN -0.05 * p_intensity
    WHEN 'familiar_task'     THEN -0.05 * p_intensity
    WHEN 'teacher_consulted' THEN -0.08 * p_intensity
    WHEN 'idle'              THEN -0.10 * p_intensity
    ELSE 0
  END;
  -- Bayesian pull toward optimal
  v_new_na := _nc_clamp(s.noradrenaline_current + v_na_delta + (s.noradrenaline_optimal - s.noradrenaline_current) * 0.10);

  ----- Consecutive-Failures Counter
  v_consecutive := CASE
    WHEN p_event IN ('task_failed', 'error') THEN s.consecutive_failures + 1
    WHEN p_event IN ('task_complete', 'familiar_task') THEN 0
    ELSE s.consecutive_failures
  END;

  ----- History (append snapshot, cap at 30)
  v_new_history := (
    SELECT jsonb_agg(x) FROM (
      SELECT * FROM jsonb_array_elements(s.history)
      UNION ALL
      SELECT jsonb_build_object(
        't',   to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'e',   p_event,
        'o',   p_outcome,
        'd',   ROUND(v_delta::numeric, 4),
        'da',  ROUND(v_new_dopamine::numeric, 4),
        'dp',  ROUND(v_new_prediction::numeric, 4),
        'se',  ROUND(v_new_serotonin::numeric, 4),
        'na',  ROUND(v_new_na::numeric, 4),
        'cf',  v_consecutive
      )
    ) x
  );
  IF jsonb_array_length(v_new_history) > 30 THEN
    -- Keep the 30 newest entries, preserving chronological order (oldest first).
    v_new_history := (
      SELECT jsonb_agg(value ORDER BY ordinality ASC)
      FROM (
        SELECT value, ordinality
        FROM jsonb_array_elements(v_new_history) WITH ORDINALITY
        ORDER BY ordinality DESC LIMIT 30
      ) t
    );
  END IF;

  UPDATE agent_neurochemistry SET
    dopamine_current      = v_new_dopamine,
    dopamine_prediction   = v_new_prediction,
    serotonin_current     = v_new_serotonin,
    noradrenaline_current = v_new_na,
    consecutive_failures  = v_consecutive,
    last_event            = p_event,
    last_outcome          = p_outcome,
    history               = v_new_history,
    updated_at            = NOW()
  WHERE id = v_id
  RETURNING * INTO s;

  RETURN to_jsonb(s);
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_get(label) — full state
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_get(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE s agent_neurochemistry%ROWTYPE;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    -- Kein Init hier — rein stable. Aufrufer soll neurochem_get_or_init() nutzen.
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;
  RETURN jsonb_build_object(
    'exists',       true,
    'label',        p_label,
    'dopamine',     jsonb_build_object(
                       'current',    s.dopamine_current,
                       'baseline',   s.dopamine_baseline,
                       'prediction', s.dopamine_prediction,
                       'lr',         s.dopamine_lr),
    'serotonin',    jsonb_build_object(
                       'current',    s.serotonin_current,
                       'decay_rate', s.serotonin_decay_rate),
    'noradrenaline',jsonb_build_object(
                       'current',    s.noradrenaline_current,
                       'optimal',    s.noradrenaline_optimal),
    'consecutive_failures', s.consecutive_failures,
    'last_event',   s.last_event,
    'last_outcome', s.last_outcome,
    'updated_at',   s.updated_at,
    'history_n',    jsonb_array_length(s.history)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_get_compat — die 4 alten Variablen als Derivate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_get_compat(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s agent_neurochemistry%ROWTYPE;
  v_curiosity DOUBLE PRECISION;
  v_frustration DOUBLE PRECISION;
  v_satisfaction DOUBLE PRECISION;
  v_confidence DOUBLE PRECISION;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;
  v_curiosity    := _nc_clamp((1 - s.noradrenaline_current) * 0.6
                              + (1 - ABS(s.dopamine_current - s.dopamine_baseline)) * 0.4);
  v_frustration  := _nc_clamp((1 - s.dopamine_current) * 0.5
                              + LEAST(1.0, s.consecutive_failures::DOUBLE PRECISION / 5.0) * 0.5);
  v_satisfaction := _nc_clamp(0.5 + (s.dopamine_current - s.dopamine_baseline));
  v_confidence   := _nc_clamp(s.serotonin_current * 0.6 + s.dopamine_prediction * 0.4);
  RETURN jsonb_build_object(
    'exists',       true,
    'label',        p_label,
    'curiosity',    v_curiosity,
    'frustration',  v_frustration,
    'satisfaction', v_satisfaction,
    'confidence',   v_confidence,
    'last_event',   s.last_event,
    'updated_at',   s.updated_at
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_get_recall_params — Yerkes-Dodson-abhängige Recall-Parameter
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_get_recall_params(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s agent_neurochemistry%ROWTYPE;
  v_performance DOUBLE PRECISION;
  v_k INT; v_thresh DOUBLE PRECISION; v_adj BOOLEAN;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;
  -- Invertierte U: optimal bei noradrenaline=0.5
  v_performance := 1 - POW((s.noradrenaline_current - 0.5) * 2, 2);
  v_performance := GREATEST(0, v_performance);
  v_k       := 3 + GREATEST(0, ROUND((1 - v_performance) * 7))::INT;
  v_thresh  := 0.5 + v_performance * 0.3;
  v_adj     := s.noradrenaline_current < 0.3;
  RETURN jsonb_build_object(
    'exists',          true,
    'label',           p_label,
    'k',               v_k,
    'score_threshold', v_thresh,
    'include_adjacent',v_adj,
    'performance',     v_performance
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_get_horizon — Planungshorizont in Tagen (Serotonin-abhängig)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_get_horizon(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE s agent_neurochemistry%ROWTYPE;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;
  RETURN jsonb_build_object(
    'exists', true, 'label', p_label,
    'days', 1 + s.serotonin_current * 13,
    'patience_threshold', 0.3 + s.serotonin_current * 0.4
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_history — letzte N Snapshots aus JSONB
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_history(p_label TEXT, p_limit INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE s agent_neurochemistry%ROWTYPE;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (SELECT jsonb_agg(value ORDER BY ordinality DESC)
          FROM (SELECT * FROM jsonb_array_elements(s.history) WITH ORDINALITY) x
          LIMIT p_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- neurochem_reset — zurück auf Defaults
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_reset(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  s    agent_neurochemistry%ROWTYPE;
BEGIN
  v_id := neurochem_get_or_init(p_label);
  UPDATE agent_neurochemistry SET
    dopamine_current      = 0.5, dopamine_baseline     = 0.5,
    dopamine_prediction   = 0.5, dopamine_lr           = 0.1,
    serotonin_current     = 0.5, serotonin_decay_rate  = 0.02,
    noradrenaline_current = 0.5, noradrenaline_optimal = 0.5,
    consecutive_failures  = 0,   last_event            = 'reset',
    last_outcome          = NULL,history               = '[]'::jsonb,
    updated_at            = NOW()
  WHERE id = v_id RETURNING * INTO s;
  RETURN to_jsonb(s);
END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: für ALLE genomes eine Zeile erstellen. Für 'main' die existierende
-- agent_affect-Zeile übersetzen (Inverse der derive*-Formeln).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_old agent_affect%ROWTYPE;
BEGIN
  FOR r IN SELECT id, label FROM agent_genomes LOOP
    IF NOT EXISTS (SELECT 1 FROM agent_neurochemistry WHERE agent_genome_id = r.id) THEN
      INSERT INTO agent_neurochemistry (agent_genome_id) VALUES (r.id);
    END IF;
  END LOOP;
  SELECT * INTO v_old FROM agent_affect WHERE id = 1;
  IF FOUND THEN
    UPDATE agent_neurochemistry n SET
      dopamine_current      = _nc_clamp(0.5 + (v_old.satisfaction - 0.5)),
      dopamine_prediction   = _nc_clamp(0.5 + (v_old.satisfaction - 0.5) * 0.5),
      serotonin_current     = v_old.confidence,
      noradrenaline_current = _nc_clamp(0.5 - (v_old.curiosity - 0.5) * 0.3),
      last_event            = 'backfill_from_agent_affect',
      updated_at            = NOW()
    FROM agent_genomes g
    WHERE n.agent_genome_id = g.id AND g.label = 'main';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Legacy-RPCs umbiegen: schreiben nicht mehr in agent_affect, sondern auf
-- 'main' (einziger singleton-Agent). Semantik des event-Namens wird gemapt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION affect_get()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT neurochem_get_compat('main');
$$;

CREATE OR REPLACE FUNCTION affect_apply(p_event TEXT, p_intensity DOUBLE PRECISION DEFAULT 0.1)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_outcome DOUBLE PRECISION;
  v_new_event TEXT;
BEGIN
  -- Old events → new (outcome, event)
  CASE p_event
    WHEN 'success'        THEN v_outcome := 0.8; v_new_event := 'task_complete';
    WHEN 'failure'        THEN v_outcome := 0.2; v_new_event := 'task_failed';
    WHEN 'unknown'        THEN v_outcome := NULL; v_new_event := 'novel_stimulus';
    WHEN 'recall_empty'   THEN v_outcome := 0.3; v_new_event := 'novel_stimulus';
    WHEN 'recall_rich'    THEN v_outcome := 0.7; v_new_event := 'familiar_task';
    WHEN 'novel_encoding' THEN v_outcome := NULL; v_new_event := 'novel_stimulus';
    ELSE v_outcome := NULL; v_new_event := p_event;
  END CASE;
  PERFORM neurochem_apply('main', v_new_event, v_outcome, GREATEST(0.5, LEAST(2.0, p_intensity * 10)));
  RETURN neurochem_get_compat('main');
END;
$$;

CREATE OR REPLACE FUNCTION affect_reset()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM neurochem_reset('main');
  RETURN neurochem_get_compat('main');
END;
$$;

-- Grants
GRANT SELECT, INSERT, UPDATE ON agent_neurochemistry TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_get_or_init(TEXT)                         TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_init_from_parents(TEXT, TEXT, TEXT, DOUBLE PRECISION) TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_apply(TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_get(TEXT)                                 TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_get_compat(TEXT)                          TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_get_recall_params(TEXT)                   TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_get_horizon(TEXT)                         TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_history(TEXT, INT)                        TO anon, service_role;
GRANT EXECUTE ON FUNCTION neurochem_reset(TEXT)                               TO anon, service_role;

-- Schema reload reminder (manually):
-- docker exec vectormemory-db psql -U postgres -d vectormemory -c "NOTIFY pgrst, 'reload schema';"
