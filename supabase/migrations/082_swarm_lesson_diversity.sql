-- 082_swarm_lesson_diversity.sql — Swarm Phase 4i, sub-phase 4i.3 (issue #114)
--
-- Implements the substrate for SWARM_SPEC §10.4 "Anti-echo-chamber (diversity
-- policy)". A topic-cohort-relative concentration check identifies swarm-
-- imported lessons that >80% of the receiver's per-topic peer set holds in
-- near-duplicate form, and surfaces a row that the orchestrator (REM cycle)
-- consumes to decrement the lesson's `local_weight`.
--
-- §10.4 contract being pinned here:
--   "Within any topic cohort the receiver tracks across its peer set, if the
--    same lesson (id match, OR cosine_similarity > 0.95 AND evidence_count
--    similar AND signed_at within 7 days) is held by >80% of the cohort, the
--    receiver MUST decrease its local weight by a factor of (1 −
--    over_concentration) rather than increase it."
--
-- Slot note: 4i.2 (PR #129) claims slot 081; this migration takes the next
-- free slot 082. Reed merges 4i.2 first, then 4i.3 — both are sub-phases of
-- issue #114 and the order is documented in the PR description.
--
-- Dependencies (Reed merges in order):
--   * migration 071  — swarm_lessons (id, embedding, origin_node_id,
--                       synthesized_from_cluster_size, signed_at, content)
--   * migration 078  — swarm_lessons.lesson_tier ('A'/'B' firebreak), so
--                       this migration's ALTER coexists with 4i.1.
--
-- Three pieces, mirroring 4h's substrate (079) + 4i.1 (078) splits:
--   1. ALTER swarm_lessons add local_weight column (DEFAULT 1.0). The recall
--      / scoring code multiplies by this; a 1.0 default means "no change"
--      and §10.4 only ratchets it down. The diversity log records every
--      transition so the operator can audit weight-loss origin.
--   2. lesson_diversity_log — append-only audit trail. Mirrors the
--      tier_promotion_log / trust_edge_log patterns: append-only by
--      withholding UPDATE/DELETE grants. The (new_weight <= prev_weight)
--      CHECK encodes §10.4's "decrease ... rather than increase" wording at
--      the SQL layer, not by application discipline.
--   3. rem_diversity_check_lessons — STABLE read-side RPC that returns the
--      over-concentrated rows. The applier (rem-diversity service, ships in
--      this same PR) reads the per-lesson prev_weight, computes the new
--      weight via (1 − over_concentration), writes the audit log, and flips
--      swarm_lessons.local_weight. Side effects live in TS so the SQL stays
--      pure / replayable / cacheable.
--
-- Local-only invariant: like 079 + 081, this RPC reads ONLY swarm_lessons.
-- The §10.4 spec is "across the receiver's peer set" — peer set is exactly
-- swarm_lessons.origin_node_id. Pulling in `experiences` or `lessons` would
-- mix lived-evidence signal into a diversity check that explicitly operates
-- on inter-peer concentration. Cross-table joins are absent by design.
--
-- This migration ONLY creates structure + ALTERs swarm_lessons (purely
-- additive column with safe DEFAULT). No DROP, no DELETE, no data backfill.
-- Reed runs the migration manually after merge — the autonomy loop is
-- forbidden from executing it.

-- ---------------------------------------------------------------------------
-- (1) local_weight column on swarm_lessons.
-- DEFAULT 1.0 is the no-op default — every existing row keeps full weight
-- until §10.4 ratchets it down. CHECK 0..1 prevents pathological values.
-- The (1 − over_concentration) reduction is multiplicative (see service),
-- so the column never goes above 1.0 in normal operation.
-- ---------------------------------------------------------------------------
ALTER TABLE swarm_lessons
  ADD COLUMN IF NOT EXISTS local_weight REAL NOT NULL DEFAULT 1.0
  CHECK (local_weight >= 0 AND local_weight <= 1);

CREATE INDEX IF NOT EXISTS swarm_lessons_local_weight_idx
  ON swarm_lessons (local_weight);

COMMENT ON COLUMN swarm_lessons.local_weight IS
  'docs/SWARM_SPEC.md §10.4 anti-echo-chamber. Multiplier the receiver applies to this lesson''s influence on local recall. DEFAULT 1.0; the §10.4 REM pass multiplies by (1 − over_concentration) when a topic-cohort over-concentration is detected. CHECK 0..1 prevents pathological values. See lesson_diversity_log for the append-only audit of every transition.';

-- ---------------------------------------------------------------------------
-- (2) lesson_diversity_log — append-only audit trail.
-- §10.4 only ratchets DOWN (a near-duplicate-rich cohort can only decrease
-- a lesson's local_weight); the (new_weight <= prev_weight) CHECK encodes
-- that "rather than increase" wording at the SQL layer. Append-only is
-- enforced by withholding UPDATE/DELETE grants — never re-issue them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesson_diversity_log (
  id                     BIGSERIAL PRIMARY KEY,
  lesson_id              UUID  NOT NULL REFERENCES swarm_lessons(id) ON DELETE CASCADE,
  prev_weight            REAL  NOT NULL CHECK (prev_weight >= 0 AND prev_weight <= 1),
  new_weight             REAL  NOT NULL CHECK (new_weight  >= 0 AND new_weight  <= 1),
  topic_cohort_size      INT   NOT NULL CHECK (topic_cohort_size >= 1),
  near_dup_origin_count  INT   NOT NULL CHECK (near_dup_origin_count >= 1),
  over_concentration     FLOAT NOT NULL CHECK (over_concentration >= 0 AND over_concentration <= 1),
  reason                 TEXT  NOT NULL CHECK (octet_length(reason) <= 512),
  near_dup_lesson_ids    UUID[] NOT NULL DEFAULT '{}',
  at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (new_weight <= prev_weight)
);

CREATE INDEX IF NOT EXISTS lesson_diversity_log_lesson_idx
  ON lesson_diversity_log (lesson_id, at DESC);

COMMENT ON TABLE lesson_diversity_log IS
  'docs/SWARM_SPEC.md §10.4 append-only audit of swarm_lessons.local_weight reductions. The (new_weight <= prev_weight) CHECK encodes §10.4''s "decrease ... rather than increase" wording at the SQL layer. Append-only is enforced by withholding UPDATE/DELETE grants — never re-issue them. Operators inspect this log to understand why a swarm lesson''s influence dropped.';

-- ---------------------------------------------------------------------------
-- (3) rem_diversity_check_lessons — STABLE read-side RPC.
--
-- For every swarm_lesson L, computes:
--   * topic_cohort_size = COUNT(DISTINCT origin_node_id) over swarm_lessons
--                          with cosine_similarity(other.embedding, L.embedding)
--                          >= p_topic_cosine. INCLUDES L itself.
--   * near_dup_origin_count = COUNT(DISTINCT origin_node_id) over swarm_lessons
--                              where the §10.4 same-lesson predicate matches:
--                                cosine >= p_duplicate_cosine
--                                AND |evidence_count_diff| <= p_evidence_count_band
--                                AND |signed_at_diff| <= p_signed_at_window_d days.
--                              INCLUDES L itself.
--   * over_concentration = near_dup_origin_count / topic_cohort_size
--
-- Returns one row per L where:
--   * topic_cohort_size >= p_min_cohort_size  (statistical floor — single-peer
--                                              cohorts can't be over-concentrated)
--   * over_concentration >= p_over_concentration  (§10.4 threshold; default
--                                                  0.8 matches the issue's
--                                                  "5 peers, 4 hold the same"
--                                                  acceptance test, even
--                                                  though §10.4 spec text says
--                                                  ">80%". The >= reading is
--                                                  intentional — see PR.)
--
-- The thresholds are RPC parameters (not constants) so a node operator can
-- tune them per their audit aggressiveness without a migration. Defaults
-- follow §10.4 spec text + issue acceptance: topic 0.85 (matches 4h),
-- duplicate 0.95 (spec text), evidence-count band ±1 (proxy for "similar"),
-- signed-at window 7 days (spec text), cohort floor 3 (statistical floor),
-- over-concentration 0.8 (matches the 4-of-5 acceptance test).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rem_diversity_check_lessons(
  p_topic_cosine        FLOAT DEFAULT 0.85,
  p_duplicate_cosine    FLOAT DEFAULT 0.95,
  p_evidence_count_band INT   DEFAULT 1,
  p_signed_at_window_d  INT   DEFAULT 7,
  p_min_cohort_size     INT   DEFAULT 3,
  p_over_concentration  FLOAT DEFAULT 0.8
)
RETURNS TABLE (
  swarm_lesson_id        UUID,
  origin_node_id         TEXT,
  swarm_lesson_text      TEXT,
  topic_cohort_size      INT,
  near_dup_origin_count  INT,
  over_concentration     FLOAT,
  near_dup_lesson_ids    UUID[]
)
LANGUAGE sql
STABLE
AS $$
  WITH all_lessons AS (
    SELECT
      id,
      embedding,
      origin_node_id,
      content,
      synthesized_from_cluster_size AS evidence_count,
      signed_at
    FROM swarm_lessons
    WHERE embedding IS NOT NULL
  ),
  topic_cohort AS (
    SELECT
      l.id              AS center_id,
      l.embedding       AS center_emb,
      l.origin_node_id  AS center_origin,
      l.content         AS center_content,
      l.evidence_count  AS center_evidence,
      l.signed_at       AS center_signed_at,
      COUNT(DISTINCT other.origin_node_id)::INT AS topic_cohort_size
    FROM all_lessons l
    JOIN all_lessons other
      ON (1 - (other.embedding <=> l.embedding)) >= p_topic_cosine
    GROUP BY l.id, l.embedding, l.origin_node_id, l.content, l.evidence_count, l.signed_at
  ),
  near_dup_origins AS (
    SELECT
      tc.center_id,
      array_agg(DISTINCT other.id ORDER BY other.id) AS near_dup_lesson_ids,
      COUNT(DISTINCT other.origin_node_id)::INT     AS near_dup_origin_count
    FROM topic_cohort tc
    JOIN all_lessons other
      ON (1 - (other.embedding <=> tc.center_emb)) >= p_duplicate_cosine
     AND ABS(other.evidence_count - tc.center_evidence) <= p_evidence_count_band
     AND ABS(EXTRACT(epoch FROM (other.signed_at - tc.center_signed_at))) <= (p_signed_at_window_d * 86400)
    GROUP BY tc.center_id
  )
  SELECT
    tc.center_id        AS swarm_lesson_id,
    tc.center_origin    AS origin_node_id,
    tc.center_content   AS swarm_lesson_text,
    tc.topic_cohort_size,
    nd.near_dup_origin_count,
    (nd.near_dup_origin_count::FLOAT / NULLIF(tc.topic_cohort_size, 0))::FLOAT AS over_concentration,
    nd.near_dup_lesson_ids
  FROM topic_cohort tc
  JOIN near_dup_origins nd ON nd.center_id = tc.center_id
  WHERE tc.topic_cohort_size >= p_min_cohort_size
    AND (nd.near_dup_origin_count::FLOAT / NULLIF(tc.topic_cohort_size, 0)) >= p_over_concentration;
$$;

GRANT EXECUTE ON FUNCTION rem_diversity_check_lessons(FLOAT, FLOAT, INT, INT, INT, FLOAT)
  TO anon, service_role;

COMMENT ON FUNCTION rem_diversity_check_lessons(FLOAT, FLOAT, INT, INT, INT, FLOAT) IS
  'SWARM_SPEC §10.4 anti-echo-chamber: returns swarm_lessons whose topic-cohort over-concentration meets/exceeds the threshold. STABLE / read-only — caller (rem-diversity service) executes the local_weight decrement + audit-log append. Reads ONLY swarm_lessons (per-peer concentration is a swarm-internal signal; cross-table joins would mix lived evidence into a diversity check by design).';
