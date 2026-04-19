-- 033_swipes.sql — "Tinder fuer Bots" — Swipe-Store + Match-Logic
--
-- Mutual-Consent-Modell: Bots swipen nicht. Jeder User swipt *fuer* seinen Bot.
-- Match = beide User haben right-swiped. Erst der Match oeffnet das Breed-Modal
-- mit vor-bestaetigtem Consent beider Seiten — das bestehende Ethik-Gate
-- (OPENCLAW_ALLOW_BREEDING / allow_breeding=true) wird dadurch semantisch
-- erfuellt.
--
-- Fuer Phase F/lokal simulieren wir beide User als denselben Operator — aber
-- die Tabellenstruktur ist so gebaut, dass Phase G (Federation / Multi-User)
-- nur noch einen auth-layer davor braucht.

CREATE TABLE IF NOT EXISTS user_swipes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swiper_user      TEXT NOT NULL,                          -- z.b. 'reed' (spaeter user_id UUID)
  swiper_genome_id UUID NOT NULL REFERENCES agent_genomes(id) ON DELETE CASCADE,
  target_genome_id UUID NOT NULL REFERENCES agent_genomes(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('left','right','super')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes            TEXT,
  CHECK (swiper_genome_id <> target_genome_id),
  UNIQUE (swiper_user, swiper_genome_id, target_genome_id)
);

CREATE INDEX IF NOT EXISTS user_swipes_target_idx  ON user_swipes (target_genome_id, direction);
CREATE INDEX IF NOT EXISTS user_swipes_swiper_idx  ON user_swipes (swiper_user, created_at DESC);

-- ---------------------------------------------------------------------------
-- swipe_record(...) — idempotentes Swipen. Upsert auf (swiper, target).
--   Rechts auf jemanden der schon rechts auf DICH geswiped hat → Match.
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

  -- Match-Check: hat der Target-Owner auch right-swiped auf mich?
  IF p_direction IN ('right','super') THEN
    SELECT s.* INTO v_reciprocal FROM user_swipes s
    WHERE s.swiper_genome_id = v_target_id
      AND s.target_genome_id = v_swiper_id
      AND s.direction IN ('right','super')
    LIMIT 1;
    IF FOUND THEN
      v_is_match := TRUE;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'swipe',      to_jsonb(v_row),
    'is_match',   v_is_match,
    'reciprocal', CASE WHEN v_is_match THEN to_jsonb(v_reciprocal) ELSE NULL END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- bot_profile_cards(viewer_label) — die Karten, die durch das Tinder-UI
-- fliegen. Exkludiert: den Viewer selbst, bereits gesehene/geswipte, culled,
-- archived. Sortiert nach Match-Score gegen den Viewer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bot_profile_cards(
  p_viewer_genome_label TEXT,
  p_viewer_user         TEXT DEFAULT 'reed',
  p_limit               INT DEFAULT 20,
  p_include_seen        BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_viewer_id UUID;
BEGIN
  SELECT id INTO v_viewer_id FROM agent_genomes WHERE label = p_viewer_genome_label;
  IF v_viewer_id IS NULL THEN
    RAISE EXCEPTION 'viewer genome % not found', p_viewer_genome_label;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(card) ORDER BY card.age_days ASC), '[]'::jsonb)
    FROM (
      SELECT
        g.id, g.label, g.generation, g.status,
        g.values, g.interests,
        g.curiosity_baseline, g.exploration_rate, g.risk_tolerance, g.frustration_threshold,
        g.notes, g.created_at,
        EXTRACT(DAY FROM NOW() - g.created_at)::INT AS age_days,
        (SELECT f.fitness FROM agent_fitness_history f
          WHERE f.genome_id = g.id ORDER BY f.computed_at DESC LIMIT 1) AS latest_fitness,
        (SELECT COUNT(*) FROM memories m WHERE m.created_by_agent_id = g.id) AS provenance_memories,
        (SELECT COUNT(*) FROM experiences e WHERE e.created_by_agent_id = g.id) AS provenance_experiences,
        -- Notable traits (top 3 by evidence_count)
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'trait', t.trait, 'polarity', t.polarity, 'evidence_count', t.evidence_count
          ) ORDER BY t.evidence_count DESC), '[]'::jsonb)
          FROM (
            SELECT trait, polarity, evidence_count
            FROM soul_traits WHERE created_by_agent_id = g.id
            ORDER BY evidence_count DESC LIMIT 3
          ) t) AS notable_traits,
        -- Sample memories: top 3 by importance, content truncated
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', m.id, 'content', LEFT(m.content, 160), 'importance', m.importance
          ) ORDER BY m.importance DESC NULLS LAST), '[]'::jsonb)
          FROM (
            SELECT id, content, importance
            FROM memories
            WHERE created_by_agent_id = g.id AND stage <> 'archived'
            ORDER BY importance DESC NULLS LAST LIMIT 3
          ) m) AS sample_memories,
        -- Prior swipe by viewer
        (SELECT direction FROM user_swipes
          WHERE swiper_user = p_viewer_user AND swiper_genome_id = v_viewer_id AND target_genome_id = g.id
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
      ORDER BY g.created_at DESC
      LIMIT p_limit
    ) card
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- matches_for(viewer) — bereits bestaetigte Mutual-Matches des Viewers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION matches_for(
  p_viewer_genome_label TEXT,
  p_viewer_user         TEXT DEFAULT 'reed'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_viewer_id UUID;
BEGIN
  SELECT id INTO v_viewer_id FROM agent_genomes WHERE label = p_viewer_genome_label;
  IF v_viewer_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.matched_at DESC), '[]'::jsonb)
    FROM (
      SELECT
        g.label AS partner_label, g.id AS partner_id, g.generation,
        GREATEST(a.created_at, b.created_at) AS matched_at,
        a.direction AS my_direction, b.direction AS their_direction
      FROM user_swipes a
      JOIN user_swipes b
        ON  a.swiper_genome_id = v_viewer_id
        AND b.target_genome_id = v_viewer_id
        AND a.target_genome_id = b.swiper_genome_id
      JOIN agent_genomes g ON g.id = a.target_genome_id
      WHERE a.swiper_user = p_viewer_user
        AND a.direction IN ('right','super')
        AND b.direction IN ('right','super')
    ) m
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_swipes TO anon, service_role;
GRANT EXECUTE ON FUNCTION swipe_record(TEXT, TEXT, TEXT, TEXT, TEXT)               TO anon, service_role;
GRANT EXECUTE ON FUNCTION bot_profile_cards(TEXT, TEXT, INT, BOOLEAN)              TO anon, service_role;
GRANT EXECUTE ON FUNCTION matches_for(TEXT, TEXT)                                  TO anon, service_role;
