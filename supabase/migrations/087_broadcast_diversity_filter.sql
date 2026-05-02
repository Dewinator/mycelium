-- 087_broadcast_diversity_filter.sql — Swarm Phase 4, issue #139 closure slice
--
-- Closes the last open acceptance line of issue #139:
--   "Diversity-dampened lessons (`local_weight < 0.3`) are excluded."
--
-- Migration 078 set up the §10.6 firebreak view
-- (`swarm_lessons_broadcast_eligible`) but filtered ONLY on `lesson_tier='A'`.
-- Migration 082 then added `swarm_lessons.local_weight` (default 1.0,
-- ratcheted DOWN by the §10.4 anti-echo-chamber pass). Until now, enforcing
-- the §10.4-side exclusion was a contract on the loader: see
-- `mcp-server/src/swarm/endpoints/lesson-feed.ts` ("The loader MUST also
-- apply the §10.4 anti-echo-chamber filter (local_weight >= 0.3 …)").
-- Application-trust is exactly the failure mode the firebreak was designed
-- to eliminate; this migration moves the rule into the substrate.
--
-- §10.4 contract being pinned here:
--   "Within any topic cohort the receiver tracks across its peer set, if the
--    same lesson is held by >80% of the cohort, the receiver MUST decrease
--    its local weight ... rather than increase it."
--
-- Why this matters: a §10.4 over-concentration ratchet is a SIGNAL that the
-- receiver should pull back. Re-broadcasting a dampened row would amplify
-- exactly the inter-peer concentration §10.4 just detected, defeating the
-- anti-echo-chamber pass. Keeping it local is the correct behavior.
--
-- Threshold choice (0.3): mirrors the constant exported from
-- `lesson-feed.ts` as `MIN_LOCAL_WEIGHT_FOR_BROADCAST`. Picking the same
-- numeric threshold the handler doc has carried since #155 keeps the
-- per-lesson behavior identical to what callers documented; only the
-- enforcement layer moves.
--
-- Why a view re-create rather than a CHECK on the column:
--   * `local_weight` is a graded signal, not a binary firewall flag. Other
--     consumers (recall, scoring, dashboards) need to see ALL local_weight
--     values to surface dampened rows in their own contexts.
--   * The broadcast view is the single read-path for /swarm/lessons. Pushing
--     the filter into the view, without touching the underlying column,
--     keeps the §10.4 audit log readable while making the broadcast
--     firebreak strictly tighter.
--
-- This migration ONLY re-creates the view. No DROP, no DELETE, no data
-- backfill. Reed runs the migration manually after merge — the autonomy
-- loop is forbidden from executing it (migration discipline from 070-086).

-- ---------------------------------------------------------------------------
-- (1) Tighten swarm_lessons_broadcast_eligible — combined §10.6 + §10.4 firebreak.
--
-- The view now requires BOTH:
--   * lesson_tier = 'A'         — §10.6 two-tier pinning firebreak (078)
--   * local_weight >= 0.3       — §10.4 anti-echo-chamber threshold (082)
--
-- `>= 0.3` matches the constant the lesson-feed handler has documented as
-- the loader-side contract. Equality / threshold choice rationale:
--   * `>=` so a freshly-inserted row at the default 1.0 trivially qualifies.
--   * 0.3, not 0.0, because §10.4 ratchets multiplicatively; weights below
--     0.3 indicate the cohort signal has fired at least twice (factor
--     compounding), which is the receiver's "this rumor is over-represented
--     in our peer set" alarm.
--
-- The CREATE OR REPLACE form preserves the existing GRANT SELECT to anon
-- and service_role from migration 078 — Postgres keeps grants on
-- CREATE OR REPLACE VIEW unless we drop and recreate, which we don't.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW swarm_lessons_broadcast_eligible AS
  SELECT *
    FROM swarm_lessons
   WHERE lesson_tier   = 'A'
     AND local_weight >= 0.3;

COMMENT ON VIEW swarm_lessons_broadcast_eligible IS
  'docs/SWARM_SPEC.md §10.6 + §10.4 firebreak (tightened by migration 087). Any /swarm/lessons HTTP handler MUST select FROM this view, never from the underlying swarm_lessons table — that is the contract that prevents (a) re-broadcast of Tier-B (un-vetted) lessons per §10.6, and (b) re-broadcast of §10.4-dampened (local_weight < 0.3) lessons whose over-concentration the receiver already pulled back from. The view is a thin combined filter; predicates push to the indexes from migrations 071, 078, and 082.';
