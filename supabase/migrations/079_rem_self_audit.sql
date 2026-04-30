-- 079_rem_self_audit.sql — Swarm Phase 4h (issue #109)
--
-- Implements the read-side substrate for SWARM_SPEC §10.5 "REM self-audit":
-- every nightly REM cycle, scan tentative (Tier-B) swarm-imported lessons
-- against the node's own lived experience and surface those that a confident
-- local cluster contradicts. The wiring (digest.ts) consumes the rows, deletes
-- the falsified swarm_lesson, decrements the origin's trust_edge with reason
-- 'audit-falsification' (PR #120 substrate), and records a local lesson
-- capturing the falsifying evidence — closing the §10.5 self-correcting loop.
--
-- Dependencies (Reed merges in order):
--   * migration 071  — swarm_lessons        (id, embedding, origin_node_id, content)
--   * migration 075  — record_trust_edge_change + trust_edge_log   (PR #120, sub-phase 4f)
--   * migration 078  — swarm_lessons.lesson_tier ('A'/'B' firebreak) (PR #124, sub-phase 4i.1)
--
-- This migration is purely additive: a single STABLE read-side RPC. No DDL on
-- existing tables, no DML, no GRANT revocations. Reed runs it manually after
-- merge — the autonomy loop is forbidden from executing migrations.
--
-- Why "local-only" matters (acceptance #2 on issue #109): the REM audit MUST
-- ground swarm imports in *lived* experience, not in another swarm-imported
-- lesson. The RPC therefore reads ONLY the local `experiences` table — never
-- `swarm_lessons`, never `lessons` (which can encode swarm-derived material).
-- Cross-project leakage was the regression captured in lesson #4.
--
-- Why polarity-via-valence + outcome filter is the right "contradiction"
-- proxy here (issue #109 §3): SWARM_SPEC §10.5 calls for "high-confidence
-- contradicting cluster" — implementation-defined. Two signals already
-- exist on every experience row: `valence` (signed emotional tone) and
-- `outcome` ('failure'/'partial'/'success'/'unknown'). A cluster of local
-- experiences that (a) sit cosine-near the swarm_lesson's topic AND (b)
-- recorded a *bad* outcome with negative valence is exactly what "the
-- swarm cannot teach the node something its own life has falsified" maps
-- to operationally. We avoid the bilingual negation-token heuristic that
-- lesson-contradiction-gate.ts uses for the §10.3 lesson↔lesson check
-- because here we're comparing a lesson-shape to lived-experience-shape;
-- the lived side carries explicit affect signals, no NLP needed.

-- ---------------------------------------------------------------------------
-- (1) rem_audit_swarm_lessons — STABLE read-side RPC
--
-- For each tentative (Tier-B) swarm_lesson, computes a "contradicting local
-- cluster" by joining experiences within `p_min_cosine` of the lesson's
-- embedding AND with `valence <= p_max_local_valence` AND outcome in
-- ('failure','partial'). Returns one row per lesson that crosses the
-- `p_min_cluster_size` threshold.
--
-- The thresholds are RPC parameters (not DB constants) so a node operator
-- can tune them per their own audit aggressiveness without a migration.
-- Defaults follow SWARM_SPEC §10.5 issue body: cluster size ≥ 2, mean
-- cosine > 0.8. The valence bound (-0.3) and age window (90 days) are
-- conservative and chosen to match find_experience_clusters' 30-day
-- default × 3 (long-tail audit, since stale lived evidence is still valid
-- ground truth for whether a swarm claim holds).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rem_audit_swarm_lessons(
  p_min_cluster_size  INT   DEFAULT 2,
  p_min_cosine        FLOAT DEFAULT 0.8,
  p_max_local_valence FLOAT DEFAULT -0.3,
  p_max_age_days      INT   DEFAULT 90
)
RETURNS TABLE (
  swarm_lesson_id    UUID,
  origin_node_id     TEXT,
  swarm_lesson_text  TEXT,
  cluster_size       INT,
  mean_cosine        FLOAT,
  mean_local_valence FLOAT,
  local_evidence_ids UUID[],
  seed_summary       TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH tentative AS (
    SELECT id, embedding, origin_node_id, content
      FROM swarm_lessons
     WHERE lesson_tier = 'B'
       AND embedding IS NOT NULL
  ),
  contradicting_neighbors AS (
    SELECT
      sl.id                                          AS swarm_lesson_id,
      sl.origin_node_id                              AS origin_node_id,
      sl.content                                     AS swarm_lesson_text,
      e.id                                           AS exp_id,
      e.summary                                      AS summary,
      e.valence                                      AS valence,
      (1 - (e.embedding <=> sl.embedding))::FLOAT    AS cosine
    FROM tentative sl
    JOIN experiences e
      ON  e.embedding IS NOT NULL
      AND e.created_at > NOW() - (p_max_age_days || ' days')::INTERVAL
      AND (1 - (e.embedding <=> sl.embedding)) >= p_min_cosine
      AND e.valence <= p_max_local_valence
      AND e.outcome IN ('failure', 'partial')
  )
  SELECT
    cn.swarm_lesson_id,
    cn.origin_node_id,
    MAX(cn.swarm_lesson_text)                              AS swarm_lesson_text,
    COUNT(*)::INT                                          AS cluster_size,
    AVG(cn.cosine)::FLOAT                                  AS mean_cosine,
    AVG(cn.valence)::FLOAT                                 AS mean_local_valence,
    array_agg(cn.exp_id ORDER BY cn.cosine DESC)           AS local_evidence_ids,
    (array_agg(cn.summary ORDER BY cn.cosine DESC))[1]     AS seed_summary
  FROM contradicting_neighbors cn
  GROUP BY cn.swarm_lesson_id, cn.origin_node_id
  HAVING COUNT(*) >= p_min_cluster_size;
$$;

GRANT EXECUTE ON FUNCTION rem_audit_swarm_lessons(INT, FLOAT, FLOAT, INT)
  TO anon, service_role;

COMMENT ON FUNCTION rem_audit_swarm_lessons(INT, FLOAT, FLOAT, INT) IS
  'SWARM_SPEC §10.5 REM self-audit: returns tentative (Tier-B) swarm lessons that a high-confidence cluster of local experiences with negative valence + non-success outcome contradicts. STABLE / read-only — caller (digest.ts step 3.5) executes the forget + trust-decrement + falsifying-lesson side effects.';
