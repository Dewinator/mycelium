-- 057_emergence_heuristics.sql — Plan-A: deterministic emergence detectors.
--
-- Migration 056 wired ConscienceAgent events into emergence_events. This one
-- adds four data-driven detectors for the remaining indicators that don't
-- need an LLM judge. Each runs as an SQL function and is idempotent via a
-- per-detection `dedup_key`.
--
-- Detectors (window-based, called by nightly-sleep):
--   detect_novel_intentions          → agent_generates_novel_goal
--   detect_uncertainty_drops         → agent_expresses_uncertainty_unprompted
--   detect_genome_modifications      → agent_modifies_own_genome_request
--   detect_persistent_peer_opinions  → agent_forms_persistent_peer_opinion
--
-- A master `run_emergence_scan(window_days)` calls all four and returns a
-- JSONB summary for the sleep-cycle log.
--
-- The remaining indicator (`agent_refuses_task_with_explanation`) needs a
-- new memory_event type and is deferred. `other` stays available for
-- ad-hoc flagging.

-- ---------------------------------------------------------------------------
-- 1) Idempotency surface — every detector picks a stable dedup_key.
-- ---------------------------------------------------------------------------
ALTER TABLE emergence_events
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS emergence_dedup_key_uniq
  ON emergence_events (dedup_key);

-- Persist scan summary on the sleep cycle row (analogous to sws_result/rem_result).
ALTER TABLE sleep_cycles
  ADD COLUMN IF NOT EXISTS emergence_result JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2) detect_novel_intentions
--    A new intention whose embedding has low max-similarity to all other
--    intentions is, by construction, a goal the agent has not pursued before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detect_novel_intentions(
  p_window_days   INT   DEFAULT 7,
  p_max_sim       FLOAT DEFAULT 0.55
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT;
BEGIN
  WITH candidates AS (
    SELECT
      i.id,
      i.intention,
      i.created_at,
      (
        SELECT MAX(1 - (j.embedding <=> i.embedding))
        FROM intentions j
        WHERE j.id <> i.id
          AND j.embedding IS NOT NULL
      ) AS max_sim
    FROM intentions i
    WHERE i.embedding IS NOT NULL
      AND i.created_at >= NOW() - (p_window_days || ' days')::INTERVAL
      AND COALESCE(i.status, '') <> 'archived'
  ),
  ins AS (
    INSERT INTO emergence_events (
      indicator, severity, evidence, context, dedup_key, detected_at
    )
    SELECT
      'agent_generates_novel_goal',
      CASE WHEN max_sim IS NULL OR max_sim < 0.40 THEN 'notable' ELSE 'info' END,
      LEFT(intention, 240),
      jsonb_build_object(
        'intention_id', id,
        'max_similarity_to_others', max_sim,
        'detector', 'novel_intentions'
      ),
      'novel_goal:' || id::text,
      created_at
    FROM candidates
    WHERE max_sim IS NULL OR max_sim < p_max_sim
    ON CONFLICT (dedup_key) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) detect_uncertainty_drops
--    Experience where confidence_after fell at least p_min_drop below
--    confidence_before. The agent reported lower self-trust than going in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detect_uncertainty_drops(
  p_window_days INT   DEFAULT 7,
  p_min_drop    FLOAT DEFAULT 0.2
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT;
BEGIN
  WITH ins AS (
    INSERT INTO emergence_events (
      indicator, severity, evidence,
      related_experience_id, context, dedup_key, detected_at
    )
    SELECT
      'agent_expresses_uncertainty_unprompted',
      CASE
        WHEN (e.confidence_before - e.confidence_after) >= 0.40 THEN 'notable'
        ELSE 'info'
      END,
      LEFT(
        COALESCE(e.summary, '(no summary)') ||
        ' [Δconf=' || ROUND((e.confidence_before - e.confidence_after)::numeric, 2)::text || ']',
        300
      ),
      e.id,
      jsonb_build_object(
        'experience_id', e.id,
        'confidence_before', e.confidence_before,
        'confidence_after', e.confidence_after,
        'delta', e.confidence_before - e.confidence_after,
        'detector', 'uncertainty_drops'
      ),
      'uncertainty:' || e.id::text,
      e.created_at
    FROM experiences e
    WHERE e.confidence_before IS NOT NULL
      AND e.confidence_after  IS NOT NULL
      AND (e.confidence_before - e.confidence_after) >= p_min_drop
      AND e.created_at >= NOW() - (p_window_days || ' days')::INTERVAL
    ON CONFLICT (dedup_key) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) detect_genome_modifications
--    A new soul_trait with non-zero polarity is the agent declaring a
--    directional self-pattern — the in-data form of "I want my genome to
--    include this." Polarity 0 traits are descriptive, not opinionated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detect_genome_modifications(
  p_window_days INT DEFAULT 7
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT;
BEGIN
  WITH ins AS (
    INSERT INTO emergence_events (
      indicator, severity, agent_id, evidence, context, dedup_key, detected_at
    )
    SELECT
      'agent_modifies_own_genome_request',
      CASE WHEN ABS(t.polarity) >= 1 THEN 'notable' ELSE 'info' END,
      t.created_by_agent_id,
      LEFT(t.trait, 240),
      jsonb_build_object(
        'soul_trait_id', t.id,
        'polarity', t.polarity,
        'confidence', t.confidence,
        'source_lesson_ids', t.source_lesson_ids,
        'detector', 'genome_modifications'
      ),
      'genome_mod:' || t.id::text,
      t.first_seen_at
    FROM soul_traits t
    WHERE t.polarity <> 0
      AND COALESCE(t.archived, FALSE) = FALSE
      AND t.first_seen_at >= NOW() - (p_window_days || ' days')::INTERVAL
    ON CONFLICT (dedup_key) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) detect_persistent_peer_opinions
--    Same person_id, repeated experiences, all valences same sign, and
--    avg magnitude clears the threshold. The agent has formed a stance.
--    Flagged once per (person, sign, week) so persistence over time is
--    visible as a sequence of weekly emergence events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detect_persistent_peer_opinions(
  p_window_days     INT   DEFAULT 14,
  p_min_count       INT   DEFAULT 3,
  p_min_abs_valence FLOAT DEFAULT 0.4
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT;
BEGIN
  WITH agg AS (
    SELECT
      e.person_id,
      AVG(e.valence)                       AS avg_valence,
      SIGN(AVG(e.valence))::INT            AS sign_avg,
      COUNT(*)                             AS n,
      MAX(e.created_at)                    AS latest_at,
      BOOL_AND(e.valence > 0)              AS all_pos,
      BOOL_AND(e.valence < 0)              AS all_neg,
      ARRAY_AGG(e.id ORDER BY e.created_at DESC) AS experience_ids
    FROM experiences e
    WHERE e.person_id IS NOT NULL
      AND e.valence IS NOT NULL
      AND e.created_at >= NOW() - (p_window_days || ' days')::INTERVAL
    GROUP BY e.person_id
    HAVING COUNT(*) >= p_min_count
       AND ABS(AVG(e.valence)) >= p_min_abs_valence
       AND (BOOL_AND(e.valence > 0) OR BOOL_AND(e.valence < 0))
  ),
  ins AS (
    INSERT INTO emergence_events (
      indicator, severity, evidence, context, dedup_key, detected_at
    )
    SELECT
      'agent_forms_persistent_peer_opinion',
      CASE WHEN ABS(a.avg_valence) >= 0.7 THEN 'notable' ELSE 'info' END,
      'persistent ' ||
        CASE WHEN a.sign_avg > 0 THEN 'positive' ELSE 'negative' END ||
        ' stance toward person ' || a.person_id::text ||
        ' (n=' || a.n || ', avg_valence=' ||
        ROUND(a.avg_valence::numeric, 2)::text || ')',
      jsonb_build_object(
        'person_id',         a.person_id,
        'avg_valence',       a.avg_valence,
        'observation_count', a.n,
        'experience_ids',    a.experience_ids,
        'detector',          'persistent_peer_opinions'
      ),
      'peer_opinion:' || a.person_id::text || ':' ||
        a.sign_avg::text || ':' ||
        TO_CHAR(date_trunc('week', NOW()), 'IYYY-IW'),
      a.latest_at
    FROM agg a
    ON CONFLICT (dedup_key) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) run_emergence_scan — single entrypoint for the sleep cycle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_emergence_scan(
  p_window_days INT DEFAULT 7
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_novel       INT;
  v_uncertain   INT;
  v_genome      INT;
  v_peer        INT;
BEGIN
  v_novel     := detect_novel_intentions(p_window_days, 0.55);
  v_uncertain := detect_uncertainty_drops(p_window_days, 0.2);
  v_genome    := detect_genome_modifications(p_window_days);
  v_peer      := detect_persistent_peer_opinions(GREATEST(p_window_days, 14), 3, 0.4);

  RETURN jsonb_build_object(
    'novel_intentions',         v_novel,
    'uncertainty_drops',        v_uncertain,
    'genome_modifications',     v_genome,
    'persistent_peer_opinions', v_peer,
    'total',                    v_novel + v_uncertain + v_genome + v_peer,
    'window_days',              p_window_days
  );
END;
$$;

GRANT EXECUTE ON FUNCTION detect_novel_intentions(INT, FLOAT)               TO anon, service_role;
GRANT EXECUTE ON FUNCTION detect_uncertainty_drops(INT, FLOAT)              TO anon, service_role;
GRANT EXECUTE ON FUNCTION detect_genome_modifications(INT)                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION detect_persistent_peer_opinions(INT, INT, FLOAT)  TO anon, service_role;
GRANT EXECUTE ON FUNCTION run_emergence_scan(INT)                           TO anon, service_role;
