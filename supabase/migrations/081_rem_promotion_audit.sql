-- 081_rem_promotion_audit.sql — Swarm Phase 4i, sub-phase 4i.2 (issue #114)
--
-- Implements the symmetric counterpart to 4h's §10.5 falsification path
-- (migration 079): instead of *contradicting* clusters that justify forget,
-- this migration surfaces *corroborating* clusters of local experience that
-- justify promoting a tentative (Tier-B) swarm-imported lesson to Tier-A
-- per SWARM_SPEC §10.6:
--
--     "Tier A — pinned. Eligible for re-broadcast … OR ingested from
--      the swarm AND independently corroborated by ≥ 2 of this node's
--      local experiences via §10.5 self-audit."
--
-- Without a promotion path, no swarm-ingested lesson can ever escape Tier-B
-- — the broadcast firewall (migration 078) becomes a permanent dead-end and
-- §10.6's "broadcast-eligible if corroborated" clause is unreachable. The
-- whole self-healing-immunity story (§10) closes only when both arrows are
-- wired.
--
-- Dependencies (Reed merges in order):
--   * migration 071  — swarm_lessons        (id, embedding, origin_node_id, content)
--   * migration 078  — swarm_lessons.lesson_tier ('A'/'B' firebreak)
--                      + tier_promotion_log (append-only audit trail)
--   * migration 079  — rem_audit_swarm_lessons (the falsification mirror)
--
-- This migration is purely additive: a single STABLE read-side RPC. No DDL on
-- existing tables, no DML, no GRANT revocations. Reed runs it manually after
-- merge — the autonomy loop is forbidden from executing migrations.
--
-- Why "local-only" matters (mirrors 079's acceptance #2): a tentative swarm
-- lesson promoted to Tier-A becomes broadcast-eligible. If the corroborating
-- cluster were allowed to come from another swarm-imported lesson, two peers
-- could mutually-promote each other's claims to Tier-A without any local
-- ground truth — the §10.4 echo-chamber attack would have a clean entry
-- point straight through 4i.2. The RPC therefore reads ONLY the local
-- `experiences` table — never `swarm_lessons`, never `lessons`.
--
-- Why outcome IN ('success','partial') AND valence >= +0.3 is the right
-- "corroboration" proxy (mirrors 079's contradiction proxy): a cluster of
-- local experiences that (a) sit cosine-near the swarm_lesson's topic AND
-- (b) recorded a *good* outcome with positive valence is exactly what "the
-- node's own life confirms what the swarm is teaching" maps to operationally.
-- Symmetric to 079, where the cluster needed (a) cosine-near AND (b) a
-- *bad* outcome with negative valence. Without BOTH polarity signals, an
-- emotionally-neutral 'success' or a high-valence 'unknown' would slip
-- through and let an under-evidenced lesson reach Tier-A — the broadcast
-- amplification surface that the §10.6 firebreak exists to deny.
--
-- Why 'partial' is included (same as 079): a `partial` outcome with
-- *positive* valence (>= 0.3) IS a corroborating data point — the
-- experience trended positive even if the success criterion wasn't fully
-- met. Excluding it would require a sharper success/failure boundary than
-- the experience-recording pipeline actually produces.

-- ---------------------------------------------------------------------------
-- (1) rem_promote_swarm_lessons — STABLE read-side RPC
--
-- For each tentative (Tier-B) swarm_lesson, computes a "corroborating local
-- cluster" by joining experiences within `p_min_cosine` of the lesson's
-- embedding AND with `valence >= p_min_local_valence` AND outcome in
-- ('success','partial'). Returns one row per lesson that crosses the
-- `p_min_cluster_size` threshold.
--
-- Symmetric to rem_audit_swarm_lessons (079) by design: same parameter
-- shape, same return shape minus `mean_local_valence` → renamed to make
-- the polarity unambiguous in the JS layer. The orchestrator (services
-- layer) consumes both RPCs the same way.
--
-- Defaults follow §10.6 acceptance: cluster size ≥ 2, mean cosine > 0.8.
-- The valence floor (+0.3) and age window (90 days) mirror 079's
-- conservative bounds (long-tail audit; stale lived evidence is still
-- valid ground truth for whether a swarm claim corroborates).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rem_promote_swarm_lessons(
  p_min_cluster_size  INT   DEFAULT 2,
  p_min_cosine        FLOAT DEFAULT 0.8,
  p_min_local_valence FLOAT DEFAULT 0.3,
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
  corroborating_neighbors AS (
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
      AND e.valence >= p_min_local_valence
      AND e.outcome IN ('success', 'partial')
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
  FROM corroborating_neighbors cn
  GROUP BY cn.swarm_lesson_id, cn.origin_node_id
  HAVING COUNT(*) >= p_min_cluster_size;
$$;

GRANT EXECUTE ON FUNCTION rem_promote_swarm_lessons(INT, FLOAT, FLOAT, INT)
  TO anon, service_role;

COMMENT ON FUNCTION rem_promote_swarm_lessons(INT, FLOAT, FLOAT, INT) IS
  'SWARM_SPEC §10.6 promotion path: returns tentative (Tier-B) swarm lessons that a high-confidence cluster of local experiences with positive valence + success/partial outcome corroborates. STABLE / read-only — caller (digest.ts step 3.6) executes the UPDATE swarm_lessons SET lesson_tier=''A'' + INSERT INTO tier_promotion_log side effects.';
