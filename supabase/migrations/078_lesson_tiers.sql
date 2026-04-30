-- 078_lesson_tiers.sql — Swarm Phase 4i, sub-phase 4i.1 (issue #114)
--
-- Implements the storage + SQL-layer firewall half of §10.6 two-tier pinning
-- from docs/SWARM_SPEC.md. The §10.4 anti-echo-chamber pass and the
-- promotion-trigger plumbing run in REM and depend on 4h (issue #109);
-- they ship separately as 4i.2.
--
-- Slot note: the 4i issue body referenced `076_lesson_tiers.sql`, but slot
-- 076 was claimed by PR #121 (4g lesson_contradictions) before this work
-- started. 074..077 are claimed by the 4c/4d/4e/4f/4g sub-phase PRs; 078 is
-- the next free slot and matches the existing convention of running
-- migrations in numeric order.
--
-- §10.6 contract being pinned here:
--   * Tier A — pinned, broadcast-eligible. Required: lesson was either
--     generated locally by this node, OR ingested from the swarm AND
--     independently corroborated by ≥ 2 of this node's local experiences
--     via §10.5 self-audit.
--   * Tier B — tentative, MUST NOT be re-broadcast. Includes contested
--     lessons (§10.3) and freshly-ingested swarm lessons before audit.
--
-- Default is Tier B. This is the firebreak: any swarm_lessons row inserted
-- without an explicit tier override gets Tier B and is therefore invisible
-- to the broadcast view. The §10.6 spec wording — "MUST NOT be re-broadcast
-- ... This is the firebreak that prevents the node from amplifying un-vetted
-- content" — is satisfied at the SQL layer, not by application discipline.
--
-- Verfassung pillar 6 (cyber security): a TEXT + CHECK column matches the
-- existing convention (migrations 024, 025, 030, 047, 055) and avoids the
-- coupling that an enum TYPE introduces (renaming an enum value requires a
-- multi-step migration). The trade-off is that every CHECK is duplicated on
-- the audit log; that's intentional and small.
--
-- This migration ONLY creates structure. No DROP, no DELETE, no data
-- backfill. Reed runs the migration manually after merge — the autonomy
-- loop is forbidden from executing it (per migration 071 hard-rule).

-- ---------------------------------------------------------------------------
-- (1) lesson_tier column on swarm_lessons.
-- DEFAULT 'B' is the firebreak: a fresh INSERT without an explicit tier
-- never lands in the broadcast view. Locally-generated lessons that are
-- mirrored into swarm_lessons by the producer pipeline (4e) MUST set
-- lesson_tier = 'A' explicitly at insert time.
-- ---------------------------------------------------------------------------
ALTER TABLE swarm_lessons
  ADD COLUMN IF NOT EXISTS lesson_tier TEXT NOT NULL DEFAULT 'B'
  CHECK (lesson_tier IN ('A', 'B'));

-- Tier-filtered lookups (the broadcast view + any future operator dashboard
-- that wants "show me my Tier-B intake") are the dominant access pattern
-- besides the existing (signed_at) and (origin_node_id, signed_at) indexes
-- from migration 071. A partial index on tier='A' would be smaller but
-- would not help the operator's "show me Tier-B" view, so use a plain btree.
CREATE INDEX IF NOT EXISTS swarm_lessons_tier_idx
  ON swarm_lessons (lesson_tier);

COMMENT ON COLUMN swarm_lessons.lesson_tier IS
  'docs/SWARM_SPEC.md §10.6 two-tier pinning. A = pinned, broadcast-eligible (locally-generated OR audit-corroborated by ≥2 local experiences via §10.5). B = tentative, NOT broadcast-eligible (default for swarm-ingested lessons before audit; also for §10.3-contested lessons). DEFAULT ''B'' is the firebreak — fresh inserts without explicit override are never re-broadcast.';

-- ---------------------------------------------------------------------------
-- (2) tier_promotion_log — append-only audit trail for tier transitions.
-- §10.6: "Tier transitions are append-only: a Tier-B lesson promoted to
-- Tier-A records the local evidence that justified the promotion. A Tier-A
-- lesson demoted by §10.5 falsification cannot be re-promoted without new
-- evidence." We enforce append-only by NOT granting UPDATE or DELETE in this
-- migration; only INSERT + SELECT. The existing migration 071 grants are
-- not re-issued for this table — application code must call INSERT explicitly.
--
-- evidence_ids is REQUIRED non-empty for B->A (the promotion justification);
-- A->B falsification records the §10.5-detected contradicting cluster's
-- experience IDs. We can't enforce non-empty per-direction in a single
-- column-level CHECK, so application code is responsible. The DB-level
-- guard is the (from_tier <> to_tier) CHECK, which prevents no-op log
-- spam.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tier_promotion_log (
  id              BIGSERIAL PRIMARY KEY,
  lesson_id       UUID NOT NULL REFERENCES swarm_lessons(id) ON DELETE CASCADE,
  from_tier       TEXT NOT NULL CHECK (from_tier IN ('A', 'B')),
  to_tier         TEXT NOT NULL CHECK (to_tier   IN ('A', 'B')),
  reason          TEXT NOT NULL CHECK (octet_length(reason) <= 512),
  evidence_ids    UUID[] NOT NULL DEFAULT '{}',
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_tier <> to_tier)
);

CREATE INDEX IF NOT EXISTS tier_promotion_log_lesson_idx
  ON tier_promotion_log (lesson_id, at DESC);

COMMENT ON TABLE tier_promotion_log IS
  'docs/SWARM_SPEC.md §10.6 append-only audit of lesson_tier transitions. Promotions B->A record the local evidence_ids that justified the promotion (per §10.5 self-audit). Demotions A->B record the §10.5-detected contradicting cluster. The (from_tier <> to_tier) CHECK prevents no-op spam. Append-only is enforced by withholding UPDATE/DELETE grants — never re-issue them.';

-- ---------------------------------------------------------------------------
-- (3) swarm_lessons_broadcast_eligible — the SQL-layer firewall view.
-- Acceptance criterion from issue #114: "Broadcast filter is at the SQL
-- layer, not application-trust." The /swarm/lessons HTTP handler MUST
-- read FROM this view, never from the raw swarm_lessons table. Reading
-- from the table risks re-broadcasting un-vetted Tier-B lessons.
--
-- Why a view rather than a function: the existing /swarm/lessons access
-- pattern (migration 071) is a SELECT with WHERE clauses on signed_at,
-- origin_node_id, and a vector similarity ORDER BY. A view preserves the
-- planner's ability to push predicates and use the (signed_at) +
-- HNSW indexes from migration 071. A SECURITY-DEFINER function would
-- defeat that.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW swarm_lessons_broadcast_eligible AS
  SELECT *
    FROM swarm_lessons
   WHERE lesson_tier = 'A';

COMMENT ON VIEW swarm_lessons_broadcast_eligible IS
  'docs/SWARM_SPEC.md §10.6 firebreak. Any /swarm/lessons HTTP handler MUST select FROM this view, never from the underlying swarm_lessons table — that is the contract that prevents accidental re-broadcast of Tier-B (un-vetted) lessons. The view is a thin filter; predicates push to the underlying indexes from migration 071.';

GRANT SELECT ON swarm_lessons_broadcast_eligible TO anon, service_role;
