-- 043_motivation_neurochem_coupling.sql — Phase M (Motivation × Neurochemie)
--
-- Drei Kopplungen hinzufügen (alle read-only auf Seite der Neurochemie —
-- das Feedback an DA/5-HT/NE passiert über neurochem_apply im Python-Sidecar
-- bzw. TS-Engine, nicht hier):
--
--   1) motivation_neurochem_hint(label) — liefert kompakte Felder (serotonin,
--      noradrenalin, dopamine_prediction, curiosity_compat) für den Scorer.
--   2) motivation_drift_scan(p_serotonin) — overload mit optionalem 5-HT-Wert,
--      der die gefühlte Zeit moduliert: effective_days = days × (2 − 5-HT).
--      Niedriges 5-HT ≙ ungeduldig, Drift wächst schneller.
--
-- motivation_dynamic_bands(p_ne) als JSON-Helper für den Scorer: liefert die
-- Schwellen basierend auf aktuellem Noradrenalin. Hoher NE → enger (nur
-- urgent feuert), niedriger NE → breiter (mehr wird act).

-- ---------------------------------------------------------------------------
-- 1. Hint: kompakte Neurochemie-Sicht für den Motivation-Sidecar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motivation_neurochem_hint(p_label TEXT DEFAULT 'main')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s agent_neurochemistry%ROWTYPE;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;
  RETURN jsonb_build_object(
    'exists',              true,
    'label',               p_label,
    'serotonin',           s.serotonin_current,
    'noradrenaline',       s.noradrenaline_current,
    'dopamine_prediction', s.dopamine_prediction,
    'consecutive_failures', s.consecutive_failures
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Drift-Scan mit Serotonin-Akzeleration.
--    Alte Variante (kein Parameter) bleibt erhalten — wir OVERLOADen nur.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motivation_drift_scan(p_serotonin DOUBLE PRECISION)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  updated INT;
  urgent  INT;
  v_mult  DOUBLE PRECISION := GREATEST(1.0, 2.0 - GREATEST(0, LEAST(1, p_serotonin)));
BEGIN
  UPDATE generated_tasks
  SET drift_score = LEAST(1.0,
                          LN(EXTRACT(EPOCH FROM (NOW() - dormant_since)) / 86400.0 * v_mult + 1.0)
                          / LN(30.0))
  WHERE status = 'proposed';
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT COUNT(*) INTO urgent FROM generated_tasks
  WHERE status = 'proposed' AND drift_score > 0.7;

  RETURN jsonb_build_object(
    'updated',        updated,
    'urgent',         urgent,
    'serotonin',      p_serotonin,
    'time_multiplier', v_mult,
    'scanned_at',     NOW()
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Dynamic Bands: Scorer kann die Thresholds relativ zum NE-Level shiften.
--    Hoher NE (angespannt) → shift up (+0.05): nur sehr relevante Stimuli
--      reißen die urgent-Schwelle. Enge Fokussierung.
--    Niedriger NE (entspannt/kreativ) → shift down (−0.05): breitere
--      Explorationsbereitschaft.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motivation_dynamic_bands(p_noradrenaline DOUBLE PRECISION DEFAULT 0.5)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_shift DOUBLE PRECISION := GREATEST(-0.08, LEAST(0.08, (p_noradrenaline - 0.5) * 0.16));
  v_urgent   DOUBLE PRECISION := GREATEST(0.60, LEAST(0.95, 0.85 + v_shift));
  v_act      DOUBLE PRECISION := GREATEST(0.50, LEAST(0.85, 0.70 + v_shift));
  v_explore  DOUBLE PRECISION := GREATEST(0.40, LEAST(0.70, 0.55 + v_shift));
  v_log      DOUBLE PRECISION := GREATEST(0.20, LEAST(0.55, 0.35 + v_shift));
BEGIN
  RETURN jsonb_build_object(
    'noradrenaline',  p_noradrenaline,
    'shift',          v_shift,
    'thresholds', jsonb_build_object(
      'urgent',  v_urgent,
      'act',     v_act,
      'explore', v_explore,
      'log',     v_log
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION motivation_neurochem_hint(TEXT)                TO anon, service_role;
GRANT EXECUTE ON FUNCTION motivation_drift_scan(DOUBLE PRECISION)        TO anon, service_role;
GRANT EXECUTE ON FUNCTION motivation_dynamic_bands(DOUBLE PRECISION)     TO anon, service_role;
