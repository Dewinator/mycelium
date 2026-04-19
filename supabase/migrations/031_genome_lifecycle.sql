-- 031_genome_lifecycle.sql — Archive / Cull / Reactivate Lifecycle
--
-- Genome-Status-Uebergaenge:
--   active    → paused     (jederzeit, reversibel)
--   active    → archived   (soft stop, Historie bleibt)
--   active    → culled     (hartes Ende — braucht typed confirmation + Begruendung)
--   paused    → active     (reaktivieren)
--   archived  → active     (reaktivieren)
--   culled    → — (final, nicht reaktivierbar)
--
-- Beim Cullen werden Fitness-History und inherited_*_ids NICHT geloescht —
-- das ist Audit-Trail + Nachkommen koennen noch Wissen tracen.

CREATE OR REPLACE FUNCTION genome_set_status(
  p_label   TEXT,
  p_status  TEXT,
  p_reason  TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row     agent_genomes%ROWTYPE;
  v_prev    TEXT;
  v_allowed BOOLEAN;
BEGIN
  SELECT * INTO v_row FROM agent_genomes WHERE label = p_label;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  v_prev := v_row.status;

  -- State-machine: was ist erlaubt?
  v_allowed := CASE
    WHEN v_prev = 'culled'                                               THEN FALSE
    WHEN p_status = 'active'   AND v_prev IN ('paused','archived')       THEN TRUE
    WHEN p_status = 'paused'   AND v_prev = 'active'                     THEN TRUE
    WHEN p_status = 'archived' AND v_prev IN ('active','paused')         THEN TRUE
    WHEN p_status = 'culled'   AND v_prev IN ('active','paused','archived') THEN TRUE
    ELSE FALSE
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'transition % → % not allowed (or genome is culled)', v_prev, p_status;
  END IF;
  IF p_status = 'culled' AND (p_reason IS NULL OR length(trim(p_reason)) < 5) THEN
    RAISE EXCEPTION 'cull requires a reason (≥5 chars)';
  END IF;

  UPDATE agent_genomes SET
    status     = p_status,
    updated_at = NOW(),
    notes      = COALESCE(notes, '') ||
                 E'\n[' || NOW()::TEXT || '] ' || v_prev || ' → ' || p_status ||
                 COALESCE(' — ' || p_reason, '')
  WHERE label = p_label
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- Convenience wrappers
CREATE OR REPLACE FUNCTION genome_archive(p_label TEXT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql AS $$ SELECT genome_set_status(p_label, 'archived', p_reason); $$;

CREATE OR REPLACE FUNCTION genome_pause(p_label TEXT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql AS $$ SELECT genome_set_status(p_label, 'paused', p_reason); $$;

CREATE OR REPLACE FUNCTION genome_reactivate(p_label TEXT)
RETURNS JSONB LANGUAGE sql AS $$ SELECT genome_set_status(p_label, 'active', NULL); $$;

CREATE OR REPLACE FUNCTION genome_cull(p_label TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE sql AS $$ SELECT genome_set_status(p_label, 'culled', p_reason); $$;

-- ---------------------------------------------------------------------------
-- Fitness-History abrufen (sortiert, fuer Dashboard-Line-Chart)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fitness_history(p_label TEXT, p_limit INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM agent_genomes WHERE label = p_label;
  IF v_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.computed_at), '[]'::jsonb)
    FROM (
      SELECT id, computed_at, fitness, avg_outcome, growth, breadth, autonomy,
             based_on_n, window_days
      FROM agent_fitness_history
      WHERE genome_id = v_id
      ORDER BY computed_at DESC
      LIMIT p_limit
    ) x
  );
END;
$$;

GRANT EXECUTE ON FUNCTION genome_set_status(TEXT, TEXT, TEXT)  TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_archive(TEXT, TEXT)           TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_pause(TEXT, TEXT)             TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_reactivate(TEXT)              TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_cull(TEXT, TEXT)              TO anon, service_role;
GRANT EXECUTE ON FUNCTION fitness_history(TEXT, INT)           TO anon, service_role;
