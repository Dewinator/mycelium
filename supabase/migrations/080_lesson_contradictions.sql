-- 080_lesson_contradictions.sql — Swarm Phase 4g (issue #108)
--
-- §10.3 Contradicts-trigger storage floor: when two ingested swarm lessons
-- with cosine_similarity > 0.85 disagree by polarity, the receiver MUST mark
-- both as Tier-B (`swarm_lessons.lesson_tier = 'B'`) and emit a contradicts
-- edge between them. Tier-B is the §10.6 firebreak from migration 078 — a
-- contradicted lesson stays out of the broadcast view until the conflict is
-- resolved (per §10.3: by new evidence, operator decision, or REM-audit
-- §10.5 falsifying one side).
--
-- Slot note: this migration started life as 076 in PR #121 with its own
-- `swarm_lessons.tier` column ('tentative'/'pinned'). PR #124's 078 then
-- added `swarm_lessons.lesson_tier` ('A'/'B') as the canonical §10.6
-- column. The two columns named the same concept twice — and 4g's
-- `tier='tentative'` demotion never reached the broadcast firewall view
-- that reads `lesson_tier='A'`. The fix: drop 4g's redundant column and
-- have the RPC write `lesson_tier='B'` directly. This means migration
-- order matters — 080 runs after 078 so `lesson_tier` exists when the
-- RPC body resolves it. PL/pgSQL parses function bodies lazily on first
-- call, so the safety net is the apply-order guarantee, not the function
-- definition.
--
-- Why a dedicated `swarm_lesson_contradictions` table rather than reusing
-- `memory_relations`:
--
--   * `memory_relations.{a_id,b_id}` carry FOREIGN KEY references to
--     `memories(id)` (migration 046). Swarm lessons live in the dedicated
--     `swarm_lessons` table from migration 071 and are NOT (yet) atomized
--     into `memories` — the planned `056_atomize_lessons` migration that
--     would fold them in is still deferred (migration 055 only added the
--     `kind` discriminator, no data move).
--   * Loosening `memory_relations`' FK to satisfy 4g would weaken the
--     contract on a load-bearing table that powers `memory_why`,
--     `memory_neighbors`, `chain_memories`, the relations.test.ts contract
--     pin, and ConscienceAgent's existing local-memory contradict path.
--   * SWARM_SPEC §10.3 says "emit a memory_relations.type='contradicts'
--     edge". The intent is the **relation type** ('contradicts'), not the
--     storage table. We honour the type literally and isolate the swarm-
--     side rows in their own table so the wire-validator and the local
--     ConscienceAgent paths stay independent. When 056_atomize_lessons
--     eventually lands, this table can fold back into memory_relations
--     (single-rewrite migration, all consumers go through chain_swarm_-
--     lesson_contradicts() RPC today so the swap surface is small).
--
-- Receiver-side only. Producer-side (this node's own published lessons)
-- never touches Tier-B — locally-generated lessons are Tier-A by §10.6
-- definition and that default lives on `lessons.tier` below.
--
-- This migration ONLY creates structure + a single idempotent RPC. No
-- DROP, no DELETE, no data backfill. Reed runs the migration manually
-- after merge — the autonomy loop is forbidden from executing it.

-- ---------------------------------------------------------------------------
-- (1) lessons.tier — §10.6 mirror on locally-generated lessons.
-- Default 'pinned' because §10.6 declares locally-generated lessons Tier-A
-- by construction (the local node is, definitionally, its own ground
-- truth). This default does NOT auto-publish anything — re-broadcast
-- eligibility is gated separately by 4i's policy + the producer-side
-- privacy gates. We just stamp the tier so 4h's REM self-audit can scan
-- across both swarm-imported and local lessons. The local table uses the
-- 'tentative'/'pinned' alphabet because it predates §10.6's A/B naming;
-- a future cleanup migration can unify the two without changing semantics.
-- The §10.6 firebreak does NOT depend on this column — it reads
-- `swarm_lessons.lesson_tier` (migration 078). This local mirror exists
-- only so 4h can scan one column across both source tables symmetrically.
-- ---------------------------------------------------------------------------
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'pinned';

ALTER TABLE lessons
  ADD CONSTRAINT lessons_tier_whitelist
  CHECK (tier IN ('tentative', 'pinned'))
  NOT VALID;

ALTER TABLE lessons VALIDATE CONSTRAINT lessons_tier_whitelist;

CREATE INDEX IF NOT EXISTS lessons_tier_idx ON lessons (tier);

COMMENT ON COLUMN lessons.tier IS
  'SWARM_SPEC §10.6 two-tier pinning state for locally-generated lessons. Default ''pinned'' (Tier-A by construction). §10.3 contradiction detection can demote to ''tentative'' if a swarm-ingested lesson is found to contradict it in a future cross-source scan. Naming differs from swarm_lessons.lesson_tier (A/B) for legacy reasons; semantics are aligned (pinned↔A, tentative↔B).';

-- ---------------------------------------------------------------------------
-- (2) swarm_lesson_contradictions — receiver-side §10.3 edges.
-- One row per ordered pair (a_id, b_id) of contradicting swarm lessons.
-- The pair is intentionally ORDERED (a_id < b_id by lexicographic UUID
-- compare) so the UNIQUE constraint catches re-detection in either
-- ingest direction. The RPC below sorts before insert.
--
-- `cosine_similarity` is captured at detection time so a future audit
-- can re-rank stale edges without re-embedding. `confidence` is the
-- polarity-detector confidence (0..1). `reason` is a short rationale
-- truncated at 500 chars, mirroring the conscience_warning convention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swarm_lesson_contradictions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id               UUID NOT NULL REFERENCES swarm_lessons(id) ON DELETE CASCADE,
  b_id               UUID NOT NULL REFERENCES swarm_lessons(id) ON DELETE CASCADE,
  cosine_similarity  REAL NOT NULL CHECK (cosine_similarity >= -1 AND cosine_similarity <= 1),
  confidence         REAL NOT NULL DEFAULT 0.5
                       CHECK (confidence >= 0 AND confidence <= 1),
  reason             TEXT NOT NULL DEFAULT '',
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence_count     INT  NOT NULL DEFAULT 1
                       CHECK (evidence_count >= 1),
  CHECK (a_id <> b_id),
  CHECK (a_id < b_id),                  -- canonical ordering, see RPC below
  UNIQUE (a_id, b_id)
);

CREATE INDEX IF NOT EXISTS swarm_lesson_contradictions_a_idx
  ON swarm_lesson_contradictions (a_id);
CREATE INDEX IF NOT EXISTS swarm_lesson_contradictions_b_idx
  ON swarm_lesson_contradictions (b_id);
CREATE INDEX IF NOT EXISTS swarm_lesson_contradictions_detected_at_idx
  ON swarm_lesson_contradictions (detected_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON swarm_lesson_contradictions TO service_role;
GRANT SELECT
  ON swarm_lesson_contradictions TO anon;

COMMENT ON TABLE swarm_lesson_contradictions IS
  'SWARM_SPEC §10.3 Contradicts-trigger edges between two swarm lessons. ConscienceAgent populates this on ingest when cosine > 0.85 AND polarity inversion detected. Both endpoints are forced to swarm_lessons.lesson_tier=''B'' (the §10.6 firebreak from migration 078). Resolution comes from new evidence, operator decision, or §10.5 REM falsification — never auto-resolved by 4g alone.';

-- ---------------------------------------------------------------------------
-- (3) chain_swarm_lesson_contradicts — idempotent upsert + tier demotion.
-- Single round-trip from the ConscienceAgent gate. Sorts the pair to the
-- canonical (a_id < b_id) order so duplicate detection from either ingest
-- direction collapses on the UNIQUE constraint. Demotes both endpoints
-- to lesson_tier='B' atomically with the edge insert (if either was
-- already 'A' via a §10.5 REM promotion or producer-side default, this
-- contradicts demotion wins per §10.3 "Neither lesson is eligible for
-- §10.6 Tier-A pinning until the conflict is resolved").
--
-- Returns the edge row plus the prior tier of each endpoint, so the
-- caller can record an experience that captures the demotion delta
-- (which is the observable §10.5 REM-audit will later re-evaluate).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chain_swarm_lesson_contradicts(
  p_lesson_a_id  UUID,
  p_lesson_b_id  UUID,
  p_cosine       REAL,
  p_confidence   REAL DEFAULT 0.5,
  p_reason       TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_a_id        UUID;
  v_b_id        UUID;
  v_row         swarm_lesson_contradictions%ROWTYPE;
  v_prior_a     TEXT;
  v_prior_b     TEXT;
BEGIN
  IF p_lesson_a_id = p_lesson_b_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self-contradiction not allowed');
  END IF;
  IF p_cosine IS NULL OR p_cosine < -1 OR p_cosine > 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cosine out of range');
  END IF;

  -- Canonical ordering so (A,B) and (B,A) collide on the UNIQUE constraint.
  IF p_lesson_a_id < p_lesson_b_id THEN
    v_a_id := p_lesson_a_id;
    v_b_id := p_lesson_b_id;
  ELSE
    v_a_id := p_lesson_b_id;
    v_b_id := p_lesson_a_id;
  END IF;

  -- Capture prior tiers BEFORE the demotion (used by record_experience).
  -- Reads `lesson_tier` from migration 078 — the §10.6 canonical column.
  SELECT lesson_tier INTO v_prior_a FROM swarm_lessons WHERE id = v_a_id;
  SELECT lesson_tier INTO v_prior_b FROM swarm_lessons WHERE id = v_b_id;

  IF v_prior_a IS NULL OR v_prior_b IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'one or both swarm_lessons rows not found'
    );
  END IF;

  -- Atomic edge upsert + tier demotion. The UNIQUE constraint on
  -- (a_id, b_id) makes re-detection a no-op on edge identity, but we
  -- still bump evidence_count so repeated independent triggers (e.g.
  -- two distinct ingest paths spotting the same pair) are visible.
  INSERT INTO swarm_lesson_contradictions
    (a_id, b_id, cosine_similarity, confidence, reason)
  VALUES
    (v_a_id, v_b_id, p_cosine, GREATEST(0, LEAST(1, COALESCE(p_confidence, 0.5))), LEFT(COALESCE(p_reason, ''), 500))
  ON CONFLICT (a_id, b_id) DO UPDATE
    SET evidence_count    = swarm_lesson_contradictions.evidence_count + 1,
        confidence        = LEAST(1.0,
                              swarm_lesson_contradictions.confidence
                              + 0.15 * (1.0 - swarm_lesson_contradictions.confidence)),
        cosine_similarity = EXCLUDED.cosine_similarity,
        reason            = CASE
                              WHEN EXCLUDED.reason <> ''
                              THEN EXCLUDED.reason
                              ELSE swarm_lesson_contradictions.reason
                            END,
        detected_at       = NOW()
  RETURNING * INTO v_row;

  -- Tier demotion: §10.3 "MUST mark both as tentative" ↔ §10.6 Tier-B.
  -- Idempotent — already-B lessons stay B. This update flows through to
  -- the swarm_lessons_broadcast_eligible view from migration 078, which
  -- means a contradicted lesson is immediately removed from the
  -- broadcast pool (the firebreak is now SQL-layer enforced, not
  -- application-trust).
  UPDATE swarm_lessons SET lesson_tier = 'B' WHERE id IN (v_a_id, v_b_id);

  RETURN jsonb_build_object(
    'ok',                    true,
    'id',                    v_row.id,
    'a_id',                  v_row.a_id,
    'b_id',                  v_row.b_id,
    'cosine_similarity',     v_row.cosine_similarity,
    'confidence',            v_row.confidence,
    'reason',                v_row.reason,
    'evidence_count',        v_row.evidence_count,
    'detected_at',           v_row.detected_at,
    'prior_lesson_tier_a',   v_prior_a,
    'prior_lesson_tier_b',   v_prior_b,
    'demoted',               (v_prior_a = 'A' OR v_prior_b = 'A')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION chain_swarm_lesson_contradicts(UUID, UUID, REAL, REAL, TEXT)
  TO anon, service_role;
