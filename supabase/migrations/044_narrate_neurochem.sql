-- 044_narrate_neurochem.sql — Prose-Selbstbeschreibung aus der Neurochemie
--
-- Ziel: eine EINE Quelle für die phänomenologische Stimmungs-Beschreibung,
-- die MCP-Tool `narrate_self` UND Dashboard `/narrate` identisch rendern.
--
-- Konvention: erste-Person Englisch, ein kurzer Absatz (2–4 Sätze), damit
-- er natürlich in die bestehende narrate_self-Prosa eingebettet werden kann.

CREATE OR REPLACE FUNCTION narrate_neurochem(p_label TEXT DEFAULT 'main')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s agent_neurochemistry%ROWTYPE;
  v_da DOUBLE PRECISION; v_pred DOUBLE PRECISION; v_base DOUBLE PRECISION; v_delta DOUBLE PRECISION;
  v_se DOUBLE PRECISION; v_ne DOUBLE PRECISION; v_cf INT;
  v_da_phrase TEXT;  v_se_phrase TEXT;  v_ne_phrase TEXT;  v_cf_phrase TEXT;
  v_text TEXT;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label, 'text', '');
  END IF;

  v_da := s.dopamine_current; v_pred := s.dopamine_prediction; v_base := s.dopamine_baseline;
  v_delta := v_da - v_base; v_se := s.serotonin_current; v_ne := s.noradrenaline_current;
  v_cf := s.consecutive_failures;

  -- Dopamin: δ vs baseline
  v_da_phrase := CASE
    WHEN v_delta >  0.30 THEN 'Something just clicked — reward is fresh.'
    WHEN v_delta >  0.10 THEN 'A small win lingers; I feel lightly encouraged.'
    WHEN v_delta < -0.30 THEN 'A letdown — things fell short of what I expected.'
    WHEN v_delta < -0.10 THEN 'Mild disappointment in my circuits.'
    ELSE                     'Dopamine is at baseline, no pull either way.'
  END;

  -- Serotonin: Zeithorizont / Geduld
  v_se_phrase := CASE
    WHEN v_se >= 0.75 THEN 'I feel patient enough to think in weeks.'
    WHEN v_se >= 0.55 THEN 'My horizon is comfortably wide.'
    WHEN v_se >= 0.35 THEN 'I want to make progress sooner than later.'
    ELSE                   'I feel restless — action now, planning later.'
  END;

  -- Noradrenalin: Arousal / Fokus (invertierte U)
  v_ne_phrase := CASE
    WHEN v_ne >= 0.80 THEN 'My attention is tight, almost clenched.'
    WHEN v_ne >= 0.60 THEN 'I am alert and focused.'
    WHEN v_ne >= 0.40 THEN 'My attention is sharp and balanced.'
    WHEN v_ne >= 0.20 THEN 'My mind is loose, making unusual connections.'
    ELSE                   'I feel drifty, attention wandering wide.'
  END;

  -- Serie aufeinanderfolgender Fehler (optional)
  v_cf_phrase := CASE
    WHEN v_cf >= 5 THEN ' A string of failures is weighing on me — I notice the pattern.'
    WHEN v_cf >= 3 THEN ' I have stumbled a few times in a row.'
    ELSE ''
  END;

  v_text := v_da_phrase || ' ' || v_se_phrase || ' ' || v_ne_phrase || v_cf_phrase;

  RETURN jsonb_build_object(
    'exists',    true,
    'label',     p_label,
    'text',      v_text,
    'dopamine',  jsonb_build_object('current', v_da, 'baseline', v_base, 'delta', v_delta),
    'serotonin', v_se,
    'noradrenaline', v_ne,
    'consecutive_failures', v_cf
  );
END;
$$;

GRANT EXECUTE ON FUNCTION narrate_neurochem(TEXT) TO anon, service_role;
