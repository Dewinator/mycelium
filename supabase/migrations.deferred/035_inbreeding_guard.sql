-- 035_inbreeding_guard.sql — Wright's F-Coefficient + Diversity-Ranking + Genpool-Health
--
-- Baut auf 034 auf (profile_embedding, ancestors[]). Liefert:
--   - inbreeding_coefficient(a,b)   → JSON mit F, blocked, reason
--   - refresh_profile_embedding(l)  → Centroid neu berechnen
--   - bot_profile_cards_ranked(...) → Karten sortiert nach Diversity-Score
--   - population_health()           → Genpool-Diagnose + Migrant-Trigger
--   - swipe_record patched          → Mutual Match nur wenn F ≤ 0.125
--
-- Schwelle: F > 0.125 ≙ Cousins-Niveau → harte Sperre.

-- ---------------------------------------------------------------------------
-- _ancestor_paths(p_id) — alle Vorfahren mit kürzestem Pfad-Abstand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _ancestor_paths(p_id UUID, p_max_depth INT DEFAULT 16)
RETURNS TABLE (ancestor_id UUID, depth INT)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE walk(id, d) AS (
    SELECT UNNEST(parent_ids), 1
    FROM agent_genomes WHERE id = p_id
    UNION ALL
    SELECT UNNEST(g.parent_ids), w.d + 1
    FROM walk w JOIN agent_genomes g ON g.id = w.id
    WHERE w.d < p_max_depth
  )
  SELECT w.id, MIN(w.d)::INT FROM walk w WHERE w.id IS NOT NULL GROUP BY w.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- inbreeding_coefficient(a_label, b_label) — Wright's F via gemeinsamer Vorfahren
--   F = Σ (0.5)^(L_a + L_b + 1) für jeden gemeinsamen Vorfahren
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inbreeding_coefficient(
  p_a_label TEXT,
  p_b_label TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_a UUID; v_b UUID;
  v_a_anc UUID[]; v_b_anc UUID[];
  v_F DOUBLE PRECISION := 0;
  v_common JSONB := '[]'::jsonb;
  v_blocked BOOLEAN := FALSE;
  v_reason TEXT := NULL;
BEGIN
  SELECT id, ancestors INTO v_a, v_a_anc FROM agent_genomes WHERE label = p_a_label;
  SELECT id, ancestors INTO v_b, v_b_anc FROM agent_genomes WHERE label = p_b_label;
  IF v_a IS NULL OR v_b IS NULL THEN
    RAISE EXCEPTION 'genome not found (a=% b=%)', p_a_label, p_b_label;
  END IF;
  IF v_a = v_b THEN
    RETURN jsonb_build_object(
      'a', p_a_label, 'b', p_b_label,
      'F', 1.0, 'blocked', true, 'reason', 'same genome',
      'common_ancestors', '[]'::jsonb, 'threshold', 0.125
    );
  END IF;

  -- Direkte Verwandtschaft (Eltern/Kind)
  IF v_a = ANY(v_b_anc) THEN
    RETURN jsonb_build_object(
      'a', p_a_label, 'b', p_b_label,
      'F', 0.5, 'blocked', true,
      'reason', format('%s is ancestor of %s', p_a_label, p_b_label),
      'common_ancestors', '[]'::jsonb, 'threshold', 0.125
    );
  END IF;
  IF v_b = ANY(v_a_anc) THEN
    RETURN jsonb_build_object(
      'a', p_a_label, 'b', p_b_label,
      'F', 0.5, 'blocked', true,
      'reason', format('%s is ancestor of %s', p_b_label, p_a_label),
      'common_ancestors', '[]'::jsonb, 'threshold', 0.125
    );
  END IF;

  -- Wright's F über gemeinsame Vorfahren (Pfad-Distanzen)
  WITH a_paths AS (SELECT * FROM _ancestor_paths(v_a)),
       b_paths AS (SELECT * FROM _ancestor_paths(v_b)),
       common  AS (
         SELECT a.ancestor_id AS aid, a.depth AS la, b.depth AS lb
         FROM a_paths a JOIN b_paths b ON a.ancestor_id = b.ancestor_id
       )
  SELECT
    COALESCE(SUM(POWER(0.5, la + lb + 1)), 0),
    COALESCE(jsonb_agg(jsonb_build_object('id', aid, 'depth_a', la, 'depth_b', lb) ORDER BY la+lb), '[]'::jsonb)
  INTO v_F, v_common
  FROM common;

  v_blocked := v_F > 0.125;
  IF v_blocked THEN
    v_reason := format('F=%s exceeds threshold 0.125 (cousins)', round(v_F::numeric, 4));
  END IF;

  RETURN jsonb_build_object(
    'a', p_a_label, 'b', p_b_label,
    'F', v_F,
    'common_ancestors', v_common,
    'blocked', v_blocked,
    'reason', v_reason,
    'threshold', 0.125
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- refresh_profile_embedding(label) — Centroid + Variance neu berechnen
-- Quellen (in dieser Reihenfolge): eigene Memories (created_by_agent_id),
-- inherited_memory_ids als Fallback. Ohne irgendwas → Centroid bleibt NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_profile_embedding(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  v_inherited UUID[];
  v_centroid VECTOR(768);
  v_n INT := 0;
  v_var DOUBLE PRECISION;
BEGIN
  SELECT id, inherited_memory_ids INTO v_id, v_inherited
    FROM agent_genomes WHERE label = p_label;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;

  -- Quelle: eigene Memories ∪ vererbte
  WITH src AS (
    SELECT embedding FROM memories
    WHERE embedding IS NOT NULL
      AND (
        created_by_agent_id = v_id
        OR id = ANY(COALESCE(v_inherited, '{}'::UUID[]))
      )
    LIMIT 2000
  )
  SELECT AVG(embedding)::VECTOR(768), COUNT(*)::INT
    INTO v_centroid, v_n FROM src;

  -- Variance = 1 - mean cosine similarity zu Centroid
  IF v_n > 1 AND v_centroid IS NOT NULL THEN
    WITH src AS (
      SELECT embedding FROM memories
      WHERE embedding IS NOT NULL
        AND (
          created_by_agent_id = v_id
          OR id = ANY(COALESCE(v_inherited, '{}'::UUID[]))
        )
      LIMIT 2000
    )
    SELECT AVG(embedding <=> v_centroid)::DOUBLE PRECISION
      INTO v_var FROM src;
  END IF;

  UPDATE agent_genomes SET
    profile_embedding    = v_centroid,
    profile_n            = v_n,
    profile_variance     = v_var,
    profile_refreshed_at = NOW()
  WHERE id = v_id;

  RETURN jsonb_build_object(
    'label', p_label,
    'n', v_n,
    'variance', v_var,
    'has_centroid', v_centroid IS NOT NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- bot_profile_cards_ranked — wie 033, aber sortiert nach Diversity-Score:
--   score = (1 - F) × complementarity   wobei complementarity = cosine-Distance
-- Karten ohne profile_embedding bekommen complementarity=0.5 als Fallback.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bot_profile_cards_ranked(
  p_viewer_genome_label TEXT,
  p_viewer_user         TEXT DEFAULT 'reed',
  p_limit               INT DEFAULT 20,
  p_include_seen        BOOLEAN DEFAULT FALSE,
  p_include_blocked     BOOLEAN DEFAULT FALSE   -- Inzucht-Karten trotzdem zeigen?
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_viewer_id    UUID;
  v_viewer_emb   VECTOR(768);
  v_viewer_anc   UUID[];
BEGIN
  SELECT id, profile_embedding, ancestors
    INTO v_viewer_id, v_viewer_emb, v_viewer_anc
    FROM agent_genomes WHERE label = p_viewer_genome_label;
  IF v_viewer_id IS NULL THEN
    RAISE EXCEPTION 'viewer genome % not found', p_viewer_genome_label;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(card) ORDER BY card.diversity_score DESC NULLS LAST), '[]'::jsonb)
    FROM (
      SELECT
        g.id, g.label, g.generation, g.status,
        g.values, g.interests,
        g.curiosity_baseline, g.exploration_rate, g.risk_tolerance, g.frustration_threshold,
        g.notes, g.created_at,
        EXTRACT(DAY FROM NOW() - g.created_at)::INT AS age_days,
        g.profile_n, g.profile_variance,
        -- Complementarity: cosine-distance zwischen Viewer und Kandidat
        CASE
          WHEN v_viewer_emb IS NOT NULL AND g.profile_embedding IS NOT NULL
            THEN (g.profile_embedding <=> v_viewer_emb)::DOUBLE PRECISION
          ELSE 0.5
        END AS complementarity,
        -- Inbreeding F (lazy via RPC)
        (inbreeding_coefficient(p_viewer_genome_label, g.label)->>'F')::DOUBLE PRECISION AS inbreeding_F,
        (inbreeding_coefficient(p_viewer_genome_label, g.label)->>'blocked')::BOOLEAN AS inbreeding_blocked,
        -- Diversity-Score
        CASE
          WHEN v_viewer_emb IS NOT NULL AND g.profile_embedding IS NOT NULL
            THEN GREATEST(0, 1 - (inbreeding_coefficient(p_viewer_genome_label, g.label)->>'F')::DOUBLE PRECISION)
                 * (g.profile_embedding <=> v_viewer_emb)::DOUBLE PRECISION
          ELSE GREATEST(0, 1 - (inbreeding_coefficient(p_viewer_genome_label, g.label)->>'F')::DOUBLE PRECISION) * 0.5
        END AS diversity_score,
        (SELECT f.fitness FROM agent_fitness_history f
          WHERE f.genome_id = g.id ORDER BY f.computed_at DESC LIMIT 1) AS latest_fitness,
        (SELECT direction FROM user_swipes
          WHERE swiper_user = p_viewer_user
            AND swiper_genome_id = v_viewer_id
            AND target_genome_id = g.id
          LIMIT 1) AS viewer_prior_direction
      FROM agent_genomes g
      WHERE g.id <> v_viewer_id
        AND g.status IN ('active','paused')
        AND (p_include_seen OR NOT EXISTS (
          SELECT 1 FROM user_swipes s
          WHERE s.swiper_user = p_viewer_user
            AND s.swiper_genome_id = v_viewer_id
            AND s.target_genome_id = g.id
        ))
        AND (
          p_include_blocked
          OR NOT (inbreeding_coefficient(p_viewer_genome_label, g.label)->>'blocked')::BOOLEAN
        )
      LIMIT p_limit
    ) card
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- population_health() — Genpool-Diagnose
--   - n active genomes
--   - mittlere paarweise centroid-Distanz (Diversität)
--   - mittlerer F-Coefficient über alle Paare
--   - migrant_recommended = bool (wenn Diversität zu niedrig)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION population_health()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_n_active INT;
  v_n_with_emb INT;
  v_avg_dist DOUBLE PRECISION;
  v_avg_F DOUBLE PRECISION;
  v_max_F DOUBLE PRECISION;
  v_migrant BOOLEAN := FALSE;
BEGIN
  SELECT COUNT(*), COUNT(profile_embedding)
    INTO v_n_active, v_n_with_emb
    FROM agent_genomes WHERE status = 'active';

  IF v_n_active < 2 THEN
    RETURN jsonb_build_object(
      'n_active', v_n_active,
      'n_with_embedding', v_n_with_emb,
      'avg_pairwise_distance', NULL,
      'avg_F', NULL,
      'max_F', NULL,
      'migrant_recommended', TRUE,
      'note', 'Population zu klein für Diversitätsanalyse'
    );
  END IF;

  -- Paarweise Distanzen (cartesian, dedup via a.id < b.id)
  WITH pairs AS (
    SELECT a.label AS la, b.label AS lb,
           a.profile_embedding AS ea, b.profile_embedding AS eb
    FROM agent_genomes a, agent_genomes b
    WHERE a.status = 'active' AND b.status = 'active' AND a.id < b.id
  ),
  with_dist AS (
    SELECT la, lb,
      CASE WHEN ea IS NOT NULL AND eb IS NOT NULL THEN (ea <=> eb)::DOUBLE PRECISION END AS dist,
      (inbreeding_coefficient(la, lb)->>'F')::DOUBLE PRECISION AS F
    FROM pairs
  )
  SELECT AVG(dist), AVG(F), MAX(F)
    INTO v_avg_dist, v_avg_F, v_max_F
    FROM with_dist;

  -- Migrant empfehlen wenn Diversität niedrig oder F-Mean hoch
  v_migrant := (
    (v_avg_dist IS NOT NULL AND v_avg_dist < 0.15)
    OR (v_avg_F IS NOT NULL AND v_avg_F > 0.05)
  );

  RETURN jsonb_build_object(
    'n_active', v_n_active,
    'n_with_embedding', v_n_with_emb,
    'avg_pairwise_distance', v_avg_dist,
    'avg_F', v_avg_F,
    'max_F', v_max_F,
    'migrant_recommended', v_migrant,
    'thresholds', jsonb_build_object('min_distance', 0.15, 'max_avg_F', 0.05)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- swipe_record patched: Inzucht-Gate eingebaut.
-- Bei mutual right-swipe: prüfe inbreeding_coefficient.
--   Wenn blocked=true → is_match=false, gibt block_reason zurück.
--   Der Swipe wird trotzdem persistiert (für Analytik).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION swipe_record(
  p_swiper_user TEXT,
  p_swiper_genome_label TEXT,
  p_target_genome_label TEXT,
  p_direction TEXT,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_swiper_id UUID;
  v_target_id UUID;
  v_reciprocal user_swipes%ROWTYPE;
  v_row        user_swipes%ROWTYPE;
  v_is_match   BOOLEAN := FALSE;
  v_F_check    JSONB;
  v_blocked    BOOLEAN := FALSE;
  v_reason     TEXT := NULL;
BEGIN
  SELECT id INTO v_swiper_id FROM agent_genomes WHERE label = p_swiper_genome_label;
  SELECT id INTO v_target_id FROM agent_genomes WHERE label = p_target_genome_label;
  IF v_swiper_id IS NULL OR v_target_id IS NULL THEN
    RAISE EXCEPTION 'genome not found (swiper=% target=%)', p_swiper_genome_label, p_target_genome_label;
  END IF;
  IF v_swiper_id = v_target_id THEN
    RAISE EXCEPTION 'cannot swipe on self';
  END IF;

  INSERT INTO user_swipes (swiper_user, swiper_genome_id, target_genome_id, direction, notes)
  VALUES (p_swiper_user, v_swiper_id, v_target_id, p_direction, p_notes)
  ON CONFLICT (swiper_user, swiper_genome_id, target_genome_id) DO UPDATE SET
    direction  = EXCLUDED.direction,
    notes      = COALESCE(EXCLUDED.notes, user_swipes.notes),
    created_at = NOW()
  RETURNING * INTO v_row;

  -- Match-Check + Inzucht-Gate
  IF p_direction IN ('right','super') THEN
    SELECT s.* INTO v_reciprocal FROM user_swipes s
    WHERE s.swiper_genome_id = v_target_id
      AND s.target_genome_id = v_swiper_id
      AND s.direction IN ('right','super')
    LIMIT 1;
    IF FOUND THEN
      v_F_check := inbreeding_coefficient(p_swiper_genome_label, p_target_genome_label);
      v_blocked := (v_F_check->>'blocked')::BOOLEAN;
      v_reason  := v_F_check->>'reason';
      v_is_match := NOT v_blocked;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'swipe',           to_jsonb(v_row),
    'is_match',        v_is_match,
    'reciprocal',      CASE WHEN v_reciprocal.id IS NOT NULL THEN to_jsonb(v_reciprocal) ELSE NULL END,
    'inbreeding_check', v_F_check,
    'block_reason',    CASE WHEN v_blocked THEN v_reason ELSE NULL END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION _ancestor_paths(UUID, INT)                              TO anon, service_role;
GRANT EXECUTE ON FUNCTION inbreeding_coefficient(TEXT, TEXT)                      TO anon, service_role;
GRANT EXECUTE ON FUNCTION refresh_profile_embedding(TEXT)                         TO anon, service_role;
GRANT EXECUTE ON FUNCTION bot_profile_cards_ranked(TEXT, TEXT, INT, BOOLEAN, BOOLEAN) TO anon, service_role;
GRANT EXECUTE ON FUNCTION population_health()                                     TO anon, service_role;
-- swipe_record: Grant existiert bereits aus 033

-- Reload PostgREST schema cache:
-- docker exec vectormemory-db psql -U postgres -d vectormemory -c "NOTIFY pgrst, 'reload schema';"
