-- 086_swarm_operator_actions.sql — Swarm Phase 4, issue #142 (backend slice)
--
-- Operator-decision substrate for SWARM_SPEC §10.3 (Contradicts) and §10.6
-- (Tier-A pinning). Without an operator path, contradicted lessons sit in
-- swarm_lesson_contradictions forever (the §10.3 firebreak resolves only
-- "by new evidence, operator decision, or §10.5 REM falsification" — the
-- middle clause was never wired). This migration ships the DB-level
-- structure + RPCs that the dashboard's POST endpoints (issue #142
-- frontend slice) will call. The frontend buttons themselves land in a
-- follow-up that depends on PR #133 (schwarm tab scaffolding).
--
-- Three operator surfaces, one PR — same packaging as 075/078/080:
--   1. resolve a contradict pair → "behalten A" / "behalten B" / "beide parken"
--   2. override peer trust → "vertrauen aufheben" / "vertrauen wiederherstellen"
--      (composes existing record_trust_edge_change + quarantine_origin from
--       migration 075 — no new RPC; the dashboard POST handler chains them)
--   3. pin a Tier-B swarm lesson to Tier-A → operator-override of §10.6 path
--
-- Scope discipline:
--   * No DROP, no DELETE on existing tables, no GRANT revocations.
--   * Two new nullable columns on swarm_lesson_contradictions, one new view,
--     two new SECURITY-INVOKER RPCs.
--   * Local-lesson pin (lessons.tier='pinned' override) is OUT OF SCOPE
--     here — local lessons have no append-only audit table to mirror
--     tier_promotion_log, and bolting one on would expand this PR beyond
--     "operator backend for the existing audit-logged surfaces."
--   * Reed runs the migration manually after merge — the autonomy loop is
--     forbidden from executing migrations (075–085 discipline).

-- ---------------------------------------------------------------------------
-- (1) swarm_lesson_contradictions.resolved_at + resolution_decision
--
-- Both nullable so existing rows keep working without backfill. NULL means
-- "still active, awaiting decision". The §10.3 active-list view (below)
-- filters on resolved_at IS NULL so a row resolved by ANY mechanism (the
-- §10.5 REM-audit can also stamp these in a future migration) drops out.
--
-- resolution_decision is whitelisted to {'a','b','park'} — the three
-- operator outcomes from issue #142 acceptance. A future REM-audit
-- resolution path can extend the whitelist with 'rem-falsified' without
-- breaking this column's contract.
-- ---------------------------------------------------------------------------
ALTER TABLE swarm_lesson_contradictions
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE swarm_lesson_contradictions
  ADD COLUMN IF NOT EXISTS resolution_decision TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'swarm_lesson_contradictions_resolution_decision_whitelist'
  ) THEN
    ALTER TABLE swarm_lesson_contradictions
      ADD CONSTRAINT swarm_lesson_contradictions_resolution_decision_whitelist
      CHECK (resolution_decision IS NULL
             OR resolution_decision IN ('a', 'b', 'park'));
  END IF;
  -- Both columns travel together — a row with one set and the other NULL
  -- would mean "resolved without saying how" or "decision recorded without
  -- a timestamp," neither of which the operator UI can produce.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'swarm_lesson_contradictions_resolution_paired'
  ) THEN
    ALTER TABLE swarm_lesson_contradictions
      ADD CONSTRAINT swarm_lesson_contradictions_resolution_paired
      CHECK ((resolved_at IS NULL AND resolution_decision IS NULL)
             OR (resolved_at IS NOT NULL AND resolution_decision IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS swarm_lesson_contradictions_active_idx
  ON swarm_lesson_contradictions (detected_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON COLUMN swarm_lesson_contradictions.resolved_at IS
  'SWARM_SPEC §10.3 resolution timestamp. NULL = still active. Set by operator_resolve_contradict (operator decision) or by future §10.5 REM-audit falsification path.';
COMMENT ON COLUMN swarm_lesson_contradictions.resolution_decision IS
  'Discriminator for resolved_at: ''a'' = kept lesson a (b deleted), ''b'' = kept lesson b (a deleted), ''park'' = both kept at Tier-B. Whitelist extensible for future REM-audit reasons.';

-- ---------------------------------------------------------------------------
-- (2) swarm_lesson_contradictions_active — the dashboard's read view
--
-- The /swarm-overview handler (PR #133) currently SELECTs straight from
-- swarm_lesson_contradictions and would keep showing resolved pairs after
-- this migration ships. The follow-up dashboard PR switches the read to
-- this view; in the meantime existing reads continue to work unchanged
-- (resolved_at defaults to NULL, so historical rows stay visible).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW swarm_lesson_contradictions_active AS
  SELECT *
    FROM swarm_lesson_contradictions
   WHERE resolved_at IS NULL;

GRANT SELECT ON swarm_lesson_contradictions_active TO anon, service_role;

COMMENT ON VIEW swarm_lesson_contradictions_active IS
  'docs/SWARM_SPEC.md §10.3 active-pairs view. Filters out rows resolved by operator decision or REM-audit. Dashboard /swarm-overview should switch to this view in the issue #142 frontend slice.';

-- ---------------------------------------------------------------------------
-- (3) operator_resolve_contradict — atomic resolve + audit
--
-- One round-trip from POST /swarm/contradict-resolve. Three branches:
--
--   * 'a' → keep lesson a, delete lesson b. Promote a to Tier-A and write
--     a tier_promotion_log row (B->A) with the operator reason. The
--     swarm_lessons FK ON DELETE CASCADE means the contradiction edge
--     itself disappears with b — but we still need to stamp resolved_at
--     BEFORE the delete so the audit row order is correct (delete fires
--     CASCADE cleanup, not an UPDATE).
--   * 'b' → mirror.
--   * 'park' → keep both at Tier-B, just mark the pair resolved with
--     decision='park'. No tier_promotion_log entry (no tier change).
--
-- §10.6 audit invariant: every B->A transition MUST have a tier_promotion_log
-- row with non-empty justification. Operator path provides
-- evidence_ids='{}' (no §10.5 cluster — the operator IS the evidence) and
-- a reason that begins with 'operator-resolved-contradict'. The empty
-- evidence_ids array is allowed by the column DEFAULT '{}' from migration
-- 078 — application-level non-empty enforcement was for §10.5 promotions
-- only.
--
-- Returns JSONB with the action taken so the caller can render an
-- operator-visible confirmation without a re-fetch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_resolve_contradict(
  p_pair_id  UUID,
  p_decision TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair      swarm_lesson_contradictions%ROWTYPE;
  v_keep_id   UUID;
  v_drop_id   UUID;
  v_now       TIMESTAMPTZ := NOW();
BEGIN
  IF p_decision NOT IN ('a', 'b', 'park') THEN
    RAISE EXCEPTION 'operator_resolve_contradict: decision must be a/b/park, got %', p_decision;
  END IF;

  SELECT * INTO v_pair FROM swarm_lesson_contradictions WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_resolve_contradict: unknown pair_id %', p_pair_id;
  END IF;
  IF v_pair.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'operator_resolve_contradict: pair % already resolved at %',
      p_pair_id, v_pair.resolved_at;
  END IF;

  IF p_decision = 'park' THEN
    -- §10.3 "beide parken": no lesson modifications, no audit row in
    -- tier_promotion_log (no tier change happened). The resolved_at stamp
    -- alone moves the row out of the active view; operator can re-open
    -- by setting resolved_at back to NULL via DB if needed (UI surface
    -- for un-park is out of scope here).
    UPDATE swarm_lesson_contradictions
       SET resolved_at = v_now,
           resolution_decision = 'park'
     WHERE id = p_pair_id;

    RETURN jsonb_build_object(
      'ok',          true,
      'pair_id',     p_pair_id,
      'decision',    'park',
      'a_id',        v_pair.a_id,
      'b_id',        v_pair.b_id,
      'resolved_at', v_now
    );
  END IF;

  -- 'a' or 'b' → keep one, delete the other, promote the kept one to A.
  IF p_decision = 'a' THEN
    v_keep_id := v_pair.a_id;
    v_drop_id := v_pair.b_id;
  ELSE
    v_keep_id := v_pair.b_id;
    v_drop_id := v_pair.a_id;
  END IF;

  -- Stamp the resolution BEFORE the delete so the row state reflects the
  -- operator decision even if the delete fires CASCADE cleanup. Once the
  -- losing lesson is gone, the contradiction row goes with it (FK ON
  -- DELETE CASCADE from migration 080) — but the kept lesson's audit row
  -- in tier_promotion_log preserves the full history.
  UPDATE swarm_lesson_contradictions
     SET resolved_at = v_now,
         resolution_decision = p_decision
   WHERE id = p_pair_id;

  -- Tier promotion for the kept lesson. Only emit a log row if the lesson
  -- actually changes tier — operator may have resolved a pair where the
  -- kept side was already Tier-A (e.g. a §10.5 REM-audit promoted it
  -- between detection and resolution).
  IF (SELECT lesson_tier FROM swarm_lessons WHERE id = v_keep_id) = 'B' THEN
    UPDATE swarm_lessons SET lesson_tier = 'A' WHERE id = v_keep_id;
    INSERT INTO tier_promotion_log (lesson_id, from_tier, to_tier, reason, evidence_ids)
    VALUES (
      v_keep_id, 'B', 'A',
      'operator-resolved-contradict (kept-' || p_decision || ', dropped peer ' || v_drop_id || ')',
      ARRAY[]::UUID[]
    );
  END IF;

  -- Delete the losing lesson. CASCADE removes the contradiction row and
  -- any other FKs into swarm_lessons(id) (chain hashes, evidence rows).
  -- The dropped lesson's tier_promotion_log entries are preserved (the FK
  -- there is ON DELETE CASCADE too — but operator audit-of-deletion is
  -- captured by the kept lesson's row above).
  DELETE FROM swarm_lessons WHERE id = v_drop_id;

  RETURN jsonb_build_object(
    'ok',          true,
    'pair_id',     p_pair_id,
    'decision',    p_decision,
    'kept_id',     v_keep_id,
    'dropped_id',  v_drop_id,
    'resolved_at', v_now,
    'promoted_to_a', (SELECT lesson_tier FROM swarm_lessons WHERE id = v_keep_id) = 'A'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION operator_resolve_contradict(UUID, TEXT)
  TO anon, service_role;

COMMENT ON FUNCTION operator_resolve_contradict(UUID, TEXT) IS
  'docs/SWARM_SPEC.md §10.3 operator-decision branch. Atomically resolves a contradict pair with one of three outcomes (kept-a / kept-b / park) and writes the §10.6 tier_promotion_log audit row when a tier change actually occurs. Backend for issue #142.';

-- ---------------------------------------------------------------------------
-- (4) operator_pin_swarm_lesson — manual Tier-B → Tier-A override
--
-- Bypasses the §10.6 REM promotion path (rem_promote_swarm_lessons) for
-- cases where the operator has out-of-band evidence the cluster algorithm
-- can't see. evidence_ids stays empty (operator IS the evidence), and the
-- reason is fixed to 'operator-pinned' so a future audit query can split
-- automated promotions from manual ones with a simple LIKE filter.
--
-- Idempotent: pinning an already-Tier-A lesson is a no-op + ok=true with
-- a `noop` flag, so the operator UI can treat double-clicks gracefully.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_pin_swarm_lesson(
  p_lesson_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_prior_tier TEXT;
BEGIN
  SELECT lesson_tier INTO v_prior_tier
    FROM swarm_lessons
   WHERE id = p_lesson_id;

  IF v_prior_tier IS NULL THEN
    RAISE EXCEPTION 'operator_pin_swarm_lesson: unknown lesson_id %', p_lesson_id;
  END IF;

  IF v_prior_tier = 'A' THEN
    RETURN jsonb_build_object(
      'ok',         true,
      'noop',       true,
      'lesson_id',  p_lesson_id,
      'lesson_tier', 'A'
    );
  END IF;

  UPDATE swarm_lessons SET lesson_tier = 'A' WHERE id = p_lesson_id;
  INSERT INTO tier_promotion_log (lesson_id, from_tier, to_tier, reason, evidence_ids)
  VALUES (p_lesson_id, 'B', 'A', 'operator-pinned', ARRAY[]::UUID[]);

  RETURN jsonb_build_object(
    'ok',         true,
    'noop',       false,
    'lesson_id',  p_lesson_id,
    'from_tier',  'B',
    'to_tier',    'A'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION operator_pin_swarm_lesson(UUID)
  TO anon, service_role;

COMMENT ON FUNCTION operator_pin_swarm_lesson(UUID) IS
  'docs/SWARM_SPEC.md §10.6 manual operator-override of the Tier-B → Tier-A promotion path. Skips the rem_promote_swarm_lessons cluster requirement for cases where the operator has out-of-band evidence. Logged with reason=''operator-pinned'' so a query can split automated vs manual promotions. Backend for issue #142.';
