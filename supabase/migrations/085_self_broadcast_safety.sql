-- 085_self_broadcast_safety.sql — Swarm self-broadcast safety guard
--
-- Closes the "Self-broadcast safety CHECK / trigger preventing a self-row from
-- carrying a foreign-looking origin_node_id" follow-up listed as out-of-scope
-- in PR #155 (issue #139, outbound /swarm/lessons feed handler substrate).
--
-- Bug class being prevented:
--   1. A producer-side typo, copy-paste, or variable swap stores a locally
--      produced lesson with origin_node_id = some_peer.node_id.
--   2. The row gets indexed at lesson_tier='A' (locally-produced shortcut from
--      §10.6 — locally-generated lessons skip Tier-B audit) and ends up in
--      swarm_lessons_broadcast_eligible (migration 078 firebreak view).
--   3. The /swarm/lessons feed serves the foreign-attributed row, falsely
--      claiming a peer's authorship and corrupting the swarm trust graph at
--      the receiver side.
--
-- The wire-validator and §10.2 quarantine handle the receiver-side trust
-- breach AFTER the row escapes; this trigger denies it at the source. Defense
-- in depth — the producer-side hook (PR #146) is supposed to set origin
-- correctly, but a SQL-side invariant catches the class of bugs that
-- application code alone cannot.
--
-- Identification of "self-row" at SQL level:
--   * A row whose id appears in lesson_chain (migration 074) IS by definition
--     a self-row. The 074 comment is explicit: "This table holds OUR
--     locally-published lessons only."
--   * Cross-checking origin_node_id against (SELECT node_id FROM nodes
--     WHERE is_self) closes the data-integrity gap.
--
-- Two triggers — symmetric, covers both insert orderings:
--   1. lesson_chain BEFORE INSERT — if the corresponding swarm_lessons row
--      already exists, its origin must match self.
--   2. swarm_lessons BEFORE INSERT OR UPDATE OF origin_node_id — if a
--      lesson_chain row already exists for this id, the origin must match
--      self.
--
-- Why both: the producer flow is allowed to insert in either order. A single
-- trigger on either table only catches inserts that come AFTER the other
-- side. Two triggers, one per table, converge on the invariant regardless of
-- ordering. In practice the producer should run both inserts in one
-- transaction so a rollback on either side rolls back the other.
--
-- Identity bootstrap requirement: in the bootstrap window before phase 1b
-- runs, `nodes WHERE is_self = TRUE` returns no row. We RAISE in that case
-- to force an explicit identity bootstrap before any self-publish. §3.7.2
-- semantics demand the producer flow run only after node identity exists,
-- so refusing here is preferable to silently allowing an unattributable
-- chain entry.
--
-- Foreign-row passthrough: rows that arrive via /swarm/lessons admission
-- (PR #154 substrate, future wiring PR) carry foreign origin_node_id by
-- design. They are NEVER added to lesson_chain (074 comment), so the
-- swarm_lessons trigger's "in_chain" check returns FALSE and admits them
-- unchanged. The wire-validator and §10.2 quarantine already vet those.
--
-- This migration is purely additive: two trigger functions, two triggers,
-- one shared assertion helper. No DDL on existing tables, no DML, no GRANT
-- changes. Reed runs the migration manually after merge — the autonomy
-- loop is forbidden from executing it (migration discipline from 070-082).

-- ---------------------------------------------------------------------------
-- (1) Shared assertion helper — single source of truth for the rule
--
-- Both triggers funnel through this helper so the error message stays
-- identical and the self-id lookup happens once per check. STABLE because
-- the lookup against `nodes` doesn't mutate; the planner can hoist repeated
-- calls within a statement (rare but possible on bulk INSERT).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION self_broadcast_assert_origin(
  p_lesson_id UUID,
  p_origin    TEXT
) RETURNS VOID AS $$
DECLARE
  v_self TEXT;
BEGIN
  SELECT node_id INTO v_self FROM nodes WHERE is_self = TRUE LIMIT 1;

  IF v_self IS NULL THEN
    RAISE EXCEPTION
      'self_broadcast_safety: no is_self row in nodes — node identity not bootstrapped, refusing self-publish for lesson %',
      p_lesson_id;
  END IF;

  IF p_origin IS DISTINCT FROM v_self THEN
    RAISE EXCEPTION
      'self_broadcast_safety: lesson % carries origin_node_id=% but local self is % — refusing to mis-attribute a self-row to a foreign producer',
      p_lesson_id, p_origin, v_self;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION self_broadcast_assert_origin(UUID, TEXT) IS
  'docs/SWARM_SPEC.md §3.1 + §10.6 self-broadcast safety: a row marked as self-published (id present in lesson_chain) MUST carry origin_node_id equal to the local self identity. Raises on misattribution. Called from the lesson_chain and swarm_lessons triggers in migration 085.';

-- ---------------------------------------------------------------------------
-- (2) lesson_chain trigger — chain-side self-row check
--
-- Fires BEFORE INSERT on lesson_chain. If the corresponding swarm_lessons
-- row already exists, its origin_node_id must match self. If it doesn't
-- exist yet, we still verify that node identity is bootstrapped — even a
-- chain-leads insert order requires a known self-id, and the swarm_lessons
-- trigger will then enforce the cross-row invariant on the later insert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lesson_chain_assert_self_origin() RETURNS TRIGGER AS $$
DECLARE
  v_origin TEXT;
  v_has_self BOOLEAN;
BEGIN
  SELECT origin_node_id INTO v_origin
    FROM swarm_lessons
   WHERE id = NEW.lesson_id;

  IF v_origin IS NULL THEN
    -- No swarm_lessons row yet. Identity must still be bootstrapped — the
    -- producer flow per §3.7.2 cannot run without a self-id, and admitting
    -- a chain entry that has no resolvable origin would defeat the rule.
    SELECT EXISTS (SELECT 1 FROM nodes WHERE is_self = TRUE) INTO v_has_self;
    IF NOT v_has_self THEN
      RAISE EXCEPTION
        'self_broadcast_safety: no is_self row in nodes — refusing lesson_chain INSERT for lesson %',
        NEW.lesson_id;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM self_broadcast_assert_origin(NEW.lesson_id, v_origin);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION lesson_chain_assert_self_origin() IS
  'BEFORE INSERT trigger function for lesson_chain (migration 085). Cross-checks origin_node_id against self identity if the corresponding swarm_lessons row already exists. Complementary swarm_lessons_assert_self_origin handles the reverse insert order.';

DROP TRIGGER IF EXISTS lesson_chain_assert_self_origin_trg ON lesson_chain;
CREATE TRIGGER lesson_chain_assert_self_origin_trg
  BEFORE INSERT ON lesson_chain
  FOR EACH ROW EXECUTE FUNCTION lesson_chain_assert_self_origin();

-- ---------------------------------------------------------------------------
-- (3) swarm_lessons trigger — storage-side self-row check
--
-- Fires BEFORE INSERT OR UPDATE OF origin_node_id on swarm_lessons. The
-- UPDATE OF clause narrows the trigger to the only column whose change
-- could break attribution; an UPDATE that touches signature_verified_at,
-- received_at, or lesson_tier won't fire it.
--
-- The "in_chain" gate is what keeps this from breaking foreign-row admission
-- via /swarm/lessons (PR #154 substrate). Foreign rows are never added to
-- lesson_chain (074 comment), so v_in_chain = FALSE and they pass through
-- unchanged. Only rows the producer claims as self-published — by also
-- inserting into lesson_chain — get the origin check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION swarm_lessons_assert_self_origin() RETURNS TRIGGER AS $$
DECLARE
  v_in_chain BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM lesson_chain WHERE lesson_id = NEW.id
  ) INTO v_in_chain;

  -- Foreign rows (no chain entry) are out-of-scope for this trigger. The
  -- wire-validator (PR #102 / #123) and §10.2 quarantine cover misattribution
  -- on the receiver side.
  IF NOT v_in_chain THEN
    RETURN NEW;
  END IF;

  PERFORM self_broadcast_assert_origin(NEW.id, NEW.origin_node_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION swarm_lessons_assert_self_origin() IS
  'BEFORE INSERT OR UPDATE OF origin_node_id trigger function for swarm_lessons (migration 085). If a lesson_chain row exists for NEW.id (the row IS a self-row), origin must equal local self. Foreign rows pass through — wire-validator and §10.2 quarantine cover that surface.';

DROP TRIGGER IF EXISTS swarm_lessons_assert_self_origin_trg ON swarm_lessons;
CREATE TRIGGER swarm_lessons_assert_self_origin_trg
  BEFORE INSERT OR UPDATE OF origin_node_id ON swarm_lessons
  FOR EACH ROW EXECUTE FUNCTION swarm_lessons_assert_self_origin();
