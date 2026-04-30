-- 083_phase4_grants.sql — Swarm Phase 4 read-grant fixup (issue #134)
--
-- Migrations 070..082 introduced the Phase-4 swarm substrate (nodes,
-- swarm_lessons, trust_edge_log, lesson_evidence_origin, tier_promotion_log,
-- swarm_lessons_broadcast_eligible, swarm_lesson_contradictions,
-- lesson_diversity_log). Five of those tables ship without GRANT SELECT
-- to anon / service_role, so PostgREST returns HTTP 403 on every read
-- of those tables on a fresh install — the dashboard, MCP tools, and
-- any external client are locked out until a hand-fix is applied.
--
-- The two exceptions (swarm_lessons_broadcast_eligible already granted
-- in 078, swarm_lesson_contradictions already granted in 080) are
-- re-granted here for completeness; GRANT is idempotent in Postgres so
-- the redundancy is a no-op. Listing them here keeps the inventory of
-- "what Phase 4 publishes via PostgREST" in one place rather than
-- spread across seven migrations.
--
-- Scope discipline (matches the 071 / 078 / 081 / 082 hard rules):
--   * Read-only — only SELECT is granted. Writes still flow through the
--     existing RPC / trigger / RLS path.
--   * Additive — no DROP, no DELETE, no TRUNCATE, no REVOKE.
--   * Idempotent — re-running this migration is a no-op (GRANT is
--     idempotent at the SQL layer).
--
-- The trailing NOTIFY pgrst, 'reload schema' is the standard PostgREST
-- hot-reload signal: PostgREST picks up the new grants without a
-- service restart. Same pattern that 078's broadcast-eligible grant
-- relies on at the existing-deploy boundary.

-- ---------------------------------------------------------------------------
-- (1) nodes — created in 070_node_identity.sql, never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON nodes                            TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (2) swarm_lessons — created in 071_swarm_storage.sql, never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON swarm_lessons                    TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (3) trust_edge_log — created in 075_trust_edge_dynamics.sql, never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON trust_edge_log                   TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (4) lesson_evidence_origin — created in 077_lesson_evidence_origin.sql,
-- never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON lesson_evidence_origin           TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (5) tier_promotion_log — created in 078_lesson_tiers.sql, never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON tier_promotion_log               TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (6) swarm_lessons_broadcast_eligible — view created in 078_lesson_tiers.sql,
-- already granted at line 115; re-granted here for inventory completeness
-- (GRANT is idempotent — no-op on existing deploys).
-- ---------------------------------------------------------------------------
GRANT SELECT ON swarm_lessons_broadcast_eligible TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (7) swarm_lesson_contradictions — created in 080_lesson_contradictions.sql,
-- already granted at lines 117-120; re-granted here for inventory
-- completeness (GRANT is idempotent — no-op on existing deploys).
-- ---------------------------------------------------------------------------
GRANT SELECT ON swarm_lesson_contradictions      TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (8) lesson_diversity_log — created in 082_swarm_lesson_diversity.sql,
-- never granted.
-- ---------------------------------------------------------------------------
GRANT SELECT ON lesson_diversity_log             TO anon, service_role;

-- ---------------------------------------------------------------------------
-- PostgREST hot-reload — pick up the new grants without a service restart.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
