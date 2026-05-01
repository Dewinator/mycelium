-- 083_trust_edge_lifecycle.sql — Swarm Phase 4f follow-up (issue #141)
--
-- Implements the two §10 lifecycle sweeps that have substrate but no
-- scheduler in main as of migration 082:
--
--   1. trust_edge_decay_step()       — §10.1 silence decay toward neutral
--   2. quarantine_release_step()     — §10.2 expiry-based release
--
-- Without these, the dashboard's "quarantäne abgelaufen?"-Feld stays stale
-- and trust accounts pile up indefinitely with no friction toward the
-- neutral baseline (0.5). The §10 self-correcting loop is open.
--
-- Both functions are idempotent and safe to call on every tick — they
-- short-circuit when there is nothing to do, so the choice of cadence
-- (digest cycle vs. watchdog tick) is purely a latency / observability
-- preference, not a correctness one.
--
-- Trust-weight semantics in this codebase:
--   `nodes.trust_weight` is REAL in [0, 1] (CHECK + DEFAULT 0.5; see
--   migrations 070/071/075). Neutral is 0.5, not 0 — so "decay toward
--   neutral" is "drift toward 0.5", not "drift toward 0".
--   The original spec text in #141 reads "if current weight is negative
--   add +0.05; if positive subtract -0.05". We translate that to the
--   actual [0, 1] coordinate system: pull above-neutral toward 0.5 by
--   subtracting 0.05; push below-neutral toward 0.5 by adding 0.05.
--   Cap at ±0.005 around 0.5 so the weight never overshoots into the
--   opposite half (oscillating sign would defeat the audit log).
--
-- Schedule discipline (mirrors migrations 075/079/081/082):
--   Reed runs the migration manually after merge — the autonomy loop is
--   forbidden from executing it.
--
-- This PR ships ONLY the SQL functions plus a watchdog-side scheduler
-- for `quarantine_release_step()`. Wiring `trust_edge_decay_step()` into
-- `digest.ts` (the spec-text suggestion) is deferred to a follow-up PR
-- because PR #132 (4i.3 follow-up) currently owns the digest.ts surface
-- and cross-PR digest.ts edits are how the autonomy loop has historically
-- generated rebase pain (lesson 2026-04-30 in vector-memory). The
-- function is fully callable from any scheduler today.
--
-- ---------------------------------------------------------------------------
-- (1) trust_edge_decay_step — §10.1 silence decay toward neutral (0.5)
--
-- For every peer with `last_seen_at < NOW() - INTERVAL p_silence_days days`
-- AND `last_decay_at IS NULL OR last_decay_at < NOW() - INTERVAL p_min_gap_hours hours`:
--   * if trust_weight > 0.505 → new_weight = trust_weight - p_step (clamp 0.5..1)
--   * if trust_weight < 0.495 → new_weight = trust_weight + p_step (clamp 0..0.5)
--   * else                    → no change (within neutral deadband)
--
-- Persistence goes through the existing `record_trust_edge_change()` RPC
-- from migration 075 so the audit trail and no-op short-circuit semantics
-- already in place are honoured. The only direct UPDATE this function
-- performs is on `nodes.last_decay_at` for rows where neither branch fired
-- (so the cooldown advances even on neutral-deadband rows — otherwise we'd
-- re-evaluate the same neutral peer every tick and produce a loud no-op).
--
-- Returns INT = number of rows where trust_weight actually changed.
-- The watchdog/digest scheduler logs this count for operator visibility.
--
-- The neutral deadband (±0.005) prevents oscillation: a peer at 0.504
-- that we drag down by 0.05 would land at 0.454 — under neutral, next
-- tick the +branch fires and overshoots up to 0.504 again. The deadband
-- collapses both branches to the no-op exit when |w − 0.5| ≤ 0.005.
--
-- p_silence_days defaults to 7 (the spec text). p_step defaults to 0.05
-- (the spec text). p_min_gap_hours defaults to 24 (one decay per UTC day
-- per peer — matches the "nightly cycle" suggested cadence even if the
-- caller fires more often).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trust_edge_decay_step(
  p_silence_days  INT  DEFAULT 7,
  p_step          REAL DEFAULT 0.05,
  p_min_gap_hours INT  DEFAULT 24
) RETURNS INT AS $$
DECLARE
  v_changed INT := 0;
  v_row     RECORD;
  v_new     REAL;
BEGIN
  IF p_silence_days  < 1 THEN
    RAISE EXCEPTION 'trust_edge_decay_step: silence_days must be >= 1, got %', p_silence_days;
  END IF;
  IF p_step <= 0 OR p_step > 0.5 THEN
    RAISE EXCEPTION 'trust_edge_decay_step: step must be in (0, 0.5], got %', p_step;
  END IF;
  IF p_min_gap_hours < 1 THEN
    RAISE EXCEPTION 'trust_edge_decay_step: min_gap_hours must be >= 1, got %', p_min_gap_hours;
  END IF;

  FOR v_row IN
    SELECT node_id, trust_weight
    FROM   nodes
    WHERE  COALESCE(is_self, FALSE) = FALSE
      AND  last_seen_at IS NOT NULL
      AND  last_seen_at < NOW() - (p_silence_days || ' days')::INTERVAL
      AND  (last_decay_at IS NULL
            OR last_decay_at < NOW() - (p_min_gap_hours || ' hours')::INTERVAL)
  LOOP
    -- Neutral deadband — skip the no-op branch. We still advance the
    -- cooldown via the trailing UPDATE (see below) so the next tick
    -- doesn't re-scan the same row.
    IF v_row.trust_weight BETWEEN 0.495 AND 0.505 THEN
      UPDATE nodes
      SET    last_decay_at = NOW(),
             decay_reason  = 'silence-decay-neutral-deadband'
      WHERE  node_id = v_row.node_id;
      CONTINUE;
    END IF;

    IF v_row.trust_weight > 0.505 THEN
      v_new := GREATEST(0.5::REAL, v_row.trust_weight - p_step);
    ELSE
      v_new := LEAST(0.5::REAL, v_row.trust_weight + p_step);
    END IF;

    -- record_trust_edge_change writes the audit row, updates trust_weight,
    -- and stamps last_decay_at + decay_reason. Its no-op short-circuit
    -- (identical weight) protects us if the deadband math ever rounds
    -- to the existing value — the audit log only grows on real change.
    PERFORM record_trust_edge_change(
      v_row.node_id,
      v_new,
      'silence-decay-toward-neutral'
    );
    v_changed := v_changed + 1;
  END LOOP;

  RETURN v_changed;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION trust_edge_decay_step(INT, REAL, INT)
  TO anon, service_role;

COMMENT ON FUNCTION trust_edge_decay_step(INT, REAL, INT) IS
  'docs/SWARM_SPEC.md §10.1 silence decay sweep. Drifts trust_weight toward 0.5 for peers silent > p_silence_days. Idempotent — guarded by a per-peer p_min_gap_hours cooldown. Returns count of weights actually changed. See migration 083 header for parameter semantics.';

-- ---------------------------------------------------------------------------
-- (2) quarantine_release_step — §10.2 expiry-based release sweep
--
-- For every peer with `quarantined_until IS NOT NULL AND quarantined_until < NOW()`:
--   * SET quarantined_until = NULL
--   * SET decay_reason     = 'quarantine-expired'
--   * SET last_decay_at    = NOW()
--   * INSERT a row into trust_edge_log with weight_before = weight_after =
--     current trust_weight, reason = 'quarantine-expired'. Direct INSERT
--     bypasses record_trust_edge_change()'s no-op short-circuit (same
--     weight in/out would silently drop the audit row otherwise) — the
--     append-only trigger from migration 075 only blocks UPDATE/DELETE,
--     not INSERT, so this is a legal append.
--
-- Returns INT = number of nodes released. Idempotent — selects only rows
-- with `quarantined_until < NOW()`, so a second call within the same
-- transaction returns 0.
--
-- Why both branches stamp `last_decay_at`: the operator dashboard reads
-- last_decay_at to display "last lifecycle event" per peer; a release
-- without that stamp would look like the peer is silently quarantined
-- forever in the UI even though quarantined_until is now NULL.
--
-- The `consecutive_rejections > 0` filter from issue #141's body is
-- intentionally NOT applied here. Migration 075 §10.2 already resets
-- consecutive_rejections to 0 inside `quarantine_origin()` — by the time
-- a node sits in `quarantined_until > NOW()` it always has counter = 0.
-- Filtering on `> 0` would zero-out every release call, which is the
-- opposite of what the issue intends. See issue #141 thread before
-- changing this back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION quarantine_release_step()
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
  v_row   RECORD;
BEGIN
  FOR v_row IN
    SELECT node_id, trust_weight
    FROM   nodes
    WHERE  quarantined_until IS NOT NULL
      AND  quarantined_until < NOW()
  LOOP
    INSERT INTO trust_edge_log (node_id, weight_before, weight_after, reason)
    VALUES (v_row.node_id, v_row.trust_weight, v_row.trust_weight, 'quarantine-expired');

    UPDATE nodes
    SET    quarantined_until      = NULL,
           consecutive_rejections = 0,
           decay_reason           = 'quarantine-expired',
           last_decay_at          = NOW()
    WHERE  node_id = v_row.node_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION quarantine_release_step()
  TO anon, service_role;

COMMENT ON FUNCTION quarantine_release_step() IS
  'docs/SWARM_SPEC.md §10.2 quarantine release sweep. Clears expired quarantines (quarantined_until < NOW()), writes a release row to trust_edge_log, and stamps last_decay_at. Idempotent — short-circuits when nothing has expired. Returns count of nodes released. Designed for the watchdog 5-minute cadence.';
