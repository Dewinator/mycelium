-- 075_trust_edge_dynamics.sql — Swarm Phase 4f (issue #107)
--
-- Substrate for §10.1 reputation decay (TrustEdge auto-tuning) and §10.2
-- quarantine state machine. SWARM_SPEC v1.1.
--
-- Scope discipline (mirrors migration 074): this migration ships ONLY the
-- DB-level structure plus the small set of helper functions that need to
-- be transactional. The runtime that drives them — REM-cycle reputation
-- recompute, polling-side quarantine filter — lands in a follow-up TS PR.
-- Splitting the work this way keeps each PR small enough to review and
-- avoids a giant cross-cutting diff.
--
-- TrustEdge is stored as flat columns on `nodes` (see header of migration
-- 071 for the rationale: §3.4 explicitly forbids exposing trust across
-- the wire, and a one-row-per-peer view in `nodes` removes the temptation
-- to ever JOIN it into a /swarm/* response). This migration extends that
-- row with six bookkeeping columns plus a `consecutive_rejections` counter
-- for the §10.2 state machine, and adds an append-only audit log for
-- weight changes so an operator can review §10.1 decay decisions.
--
-- §10.1 formula recap:
--   weight = base_weight
--          × successful_inclusion_proof_rate(origin, last_30d)
--          × clamp(0, 1, avg_local_useful_count(origin) / threshold)
--          × age_factor(origin)
--   clamped to [0, 1].
-- `compute_trust_weight()` below is the pure-SQL implementation. The REM
-- cycle is responsible for sourcing the four input signals (proof-rate
-- comes from §4.6 handler success/failure events, useful_count from
-- existing experience.useful_count aggregates, age_factor from
-- nodes.last_seen_at - nodes.created_at). Keeping the formula DB-side
-- means we get one source of truth for the arithmetic and contract-pin
-- tests can verify the constants without booting Postgres.
--
-- §10.2 state machine recap:
--   * N consecutive rule 1–20 rejections → quarantine for K days
--   * Rule 19 (broken commitment chain) is single-strike — quarantine
--     immediately regardless of N (chain rewriting is a definitionally
--     adversarial act, §3.7.2)
--   * Defaults: N = 5, K = 30. Both are function-parameter-overridable
--     so an operator can tune per peer without altering schema.
--
-- Append-only audit log:
-- `trust_edge_log` is the operator's audit surface for §10.1. Every
-- weight change MUST be accompanied by a `reason`. UPDATE/DELETE are
-- forbidden via trigger — same pattern as `lesson_chain` (074), defense
-- in depth so an operator with table-owner privileges still cannot
-- silently rewrite reputation history.
--
-- Reed runs the migration manually after merge — the autonomy loop is
-- forbidden from executing it (migration discipline from 070-074).

-- ---------------------------------------------------------------------------
-- (1) Extend `nodes` with the §10.1 + §10.2 bookkeeping fields
--
-- All new columns are nullable or carry safe defaults so the existing
-- `is_self` row from phase 1b and any peer rows from migration 071 keep
-- working without backfill. NULL on a signal column means "no data yet";
-- the formula treats NULL inputs as "no decay applied this cycle".
-- ---------------------------------------------------------------------------
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS successful_inclusion_proof_rate_30d REAL;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS avg_local_useful_count REAL;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS age_factor REAL NOT NULL DEFAULT 1.0;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS quarantined_until TIMESTAMPTZ;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS decay_reason TEXT;
-- The §10.2 N-counter. Resets on quarantine (the streak is consumed) and
-- on the first non-rejection ingest from the same origin (the streak is
-- broken). Stored on the row rather than computed from a rejection log
-- so the polling-side check is a single column read.
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS consecutive_rejections INT NOT NULL DEFAULT 0;

-- Range guards. Rates are bounded probabilities; counts are non-negative.
-- ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS is not portable across
-- PostgreSQL versions; the DO-block pattern is the established workaround.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_proof_rate_range'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_proof_rate_range
      CHECK (successful_inclusion_proof_rate_30d IS NULL
             OR (successful_inclusion_proof_rate_30d >= 0
                 AND successful_inclusion_proof_rate_30d <= 1));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_age_factor_range'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_age_factor_range
      CHECK (age_factor >= 0 AND age_factor <= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_useful_count_nonneg'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_useful_count_nonneg
      CHECK (avg_local_useful_count IS NULL OR avg_local_useful_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_consecutive_rejections_nonneg'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_consecutive_rejections_nonneg
      CHECK (consecutive_rejections >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- (2) trust_edge_log — append-only audit surface for §10.1
--
-- Operator-facing. Every weight change records {before, after, reason, at}
-- so the operator can ask "why did peer X's trust drop overnight?" and
-- get a single-query answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trust_edge_log (
  id            BIGSERIAL    PRIMARY KEY,
  node_id       TEXT         NOT NULL REFERENCES nodes(node_id),
  weight_before REAL         NOT NULL,
  weight_after  REAL         NOT NULL,
  reason        TEXT         NOT NULL,
  at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (weight_before >= 0 AND weight_before <= 1),
  CHECK (weight_after  >= 0 AND weight_after  <= 1)
);

CREATE INDEX IF NOT EXISTS trust_edge_log_node_at_idx
  ON trust_edge_log (node_id, at DESC);

COMMENT ON TABLE trust_edge_log IS
  'Mycelium swarm: append-only audit log of TrustEdge weight changes (SWARM_SPEC §10.1). Operator-facing. UPDATE/DELETE forbidden by trigger.';

-- Append-only enforcement — same pattern as lesson_chain (074).
CREATE OR REPLACE FUNCTION trust_edge_log_no_mutate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'trust_edge_log is append-only — rows cannot be % (SWARM_SPEC §10.1)',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_edge_log_no_update ON trust_edge_log;
CREATE TRIGGER trust_edge_log_no_update
  BEFORE UPDATE ON trust_edge_log
  FOR EACH ROW EXECUTE FUNCTION trust_edge_log_no_mutate();

DROP TRIGGER IF EXISTS trust_edge_log_no_delete ON trust_edge_log;
CREATE TRIGGER trust_edge_log_no_delete
  BEFORE DELETE ON trust_edge_log
  FOR EACH ROW EXECUTE FUNCTION trust_edge_log_no_mutate();

-- ---------------------------------------------------------------------------
-- (3) compute_trust_weight — the §10.1 formula as a pure SQL function
--
-- Inputs are passed in by the caller (the REM-cycle TS code aggregates the
-- four signals from existing tables — proof success/failure log, experience
-- useful_count, last_seen_at, etc.). This function is the single source of
-- truth for the arithmetic, including the [0, 1] clamp.
--
-- NULL handling: any NULL input collapses the whole product to base_weight
-- alone (treating NULL as "no signal yet, don't decay"). This is the
-- conservative default — a fresh peer with no proof history shouldn't be
-- driven to 0 just because the rolling window hasn't accumulated data.
-- The REM cycle only writes the result back via record_trust_edge_change
-- if it represents a *real* change, so NULL-only inputs don't pollute the
-- audit log.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_trust_weight(
  base_weight              REAL,
  proof_rate_30d           REAL,
  avg_useful_count         REAL,
  useful_count_threshold   REAL,
  age_factor               REAL
) RETURNS REAL AS $$
  SELECT GREATEST(0.0::REAL, LEAST(1.0::REAL,
    base_weight
    * COALESCE(proof_rate_30d, 1.0)
    * COALESCE(
        LEAST(1.0::REAL, avg_useful_count / NULLIF(useful_count_threshold, 0)),
        1.0
      )
    * COALESCE(age_factor, 1.0)
  ));
$$ LANGUAGE sql IMMUTABLE;

GRANT EXECUTE ON FUNCTION compute_trust_weight(REAL, REAL, REAL, REAL, REAL)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (4) record_trust_edge_change — atomic update + audit
--
-- The REM cycle calls this with the new weight produced by
-- compute_trust_weight(). The function reads the current weight, writes a
-- log row capturing {before, after, reason, at}, and updates nodes
-- accordingly — all in a single statement so a crash between the read and
-- the write cannot produce a row in `nodes` whose value diverges from the
-- audit log.
--
-- No-op behaviour: if `p_new_weight` equals the current `trust_weight`,
-- no log row is written (the audit log shows real changes only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_trust_edge_change(
  p_node_id    TEXT,
  p_new_weight REAL,
  p_reason     TEXT
) RETURNS VOID AS $$
DECLARE
  v_before REAL;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'record_trust_edge_change: reason is required (SWARM_SPEC §10.1)';
  END IF;
  IF p_new_weight < 0 OR p_new_weight > 1 THEN
    RAISE EXCEPTION 'record_trust_edge_change: weight must be in [0, 1], got %', p_new_weight;
  END IF;

  SELECT trust_weight INTO v_before FROM nodes WHERE node_id = p_node_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'record_trust_edge_change: unknown node_id %', p_node_id;
  END IF;

  -- No-op short-circuit: identical weight, no audit row, no UPDATE.
  IF v_before = p_new_weight THEN
    RETURN;
  END IF;

  INSERT INTO trust_edge_log (node_id, weight_before, weight_after, reason)
  VALUES (p_node_id, v_before, p_new_weight, p_reason);

  UPDATE nodes
  SET    trust_weight  = p_new_weight,
         trust_reason  = p_reason,
         last_decay_at = NOW(),
         decay_reason  = p_reason
  WHERE  node_id = p_node_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION record_trust_edge_change(TEXT, REAL, TEXT)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (5) is_quarantined — single-column read used by the polling client
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_quarantined(p_node_id TEXT) RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT quarantined_until FROM nodes WHERE node_id = p_node_id) > NOW(),
    FALSE
  );
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION is_quarantined(TEXT) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (6) quarantine_origin — set the §10.2 hold for K days
--
-- Resets `consecutive_rejections` to 0 because the streak has been
-- consumed by the quarantine action; if the origin re-offends after
-- coming back, the count starts fresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION quarantine_origin(
  p_node_id TEXT,
  p_days    INT,
  p_reason  TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_days <= 0 THEN
    RAISE EXCEPTION 'quarantine_origin: days must be > 0, got %', p_days;
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'quarantine_origin: reason is required';
  END IF;

  UPDATE nodes
  SET    quarantined_until      = NOW() + (p_days || ' days')::INTERVAL,
         consecutive_rejections = 0,
         decay_reason           = p_reason
  WHERE  node_id = p_node_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine_origin: unknown node_id %', p_node_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION quarantine_origin(TEXT, INT, TEXT)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (7) record_origin_rejection — encodes the §10.2 state machine
--
-- Called by the receiver pipeline whenever a §5 rule 1–20 rejection
-- against `p_node_id` fires. Encodes the two §10.2 trigger modes:
--   * single-strike: rule 19 (chain rewriting) → immediate quarantine
--   * cumulative:   N consecutive other rejections → quarantine
--
-- Defaults (N = 5, K = 30) are SWARM_SPEC §10.2. Operator-overridable via
-- the function arguments; the receiver's TS layer reads operator config
-- and passes the resolved values, so per-peer policy lives outside the DB.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_origin_rejection(
  p_node_id     TEXT,
  p_rule_number INT,
  p_n_threshold INT  DEFAULT 5,
  p_k_days      INT  DEFAULT 30
) RETURNS BOOLEAN AS $$
DECLARE
  v_new_count INT;
BEGIN
  IF p_rule_number < 1 OR p_rule_number > 20 THEN
    RAISE EXCEPTION 'record_origin_rejection: rule_number must be in [1, 20], got %', p_rule_number;
  END IF;
  IF p_n_threshold < 1 THEN
    RAISE EXCEPTION 'record_origin_rejection: n_threshold must be >= 1, got %', p_n_threshold;
  END IF;

  -- Single-strike branch (§10.2): rule 19 is chain-rewriting.
  IF p_rule_number = 19 THEN
    PERFORM quarantine_origin(
      p_node_id,
      p_k_days,
      'single-strike: rule 19 (broken commitment chain)'
    );
    RETURN TRUE;
  END IF;

  -- Cumulative branch: increment, quarantine if threshold crossed.
  UPDATE nodes
  SET    consecutive_rejections = consecutive_rejections + 1
  WHERE  node_id = p_node_id
  RETURNING consecutive_rejections INTO v_new_count;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_origin_rejection: unknown node_id %', p_node_id;
  END IF;

  IF v_new_count >= p_n_threshold THEN
    PERFORM quarantine_origin(
      p_node_id,
      p_k_days,
      'cumulative: ' || v_new_count || ' consecutive rejections'
    );
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION record_origin_rejection(TEXT, INT, INT, INT)
  TO anon, service_role;

-- ---------------------------------------------------------------------------
-- (8) reset_origin_rejection_streak — break the §10.2 streak on a clean ingest
--
-- The §10.2 N-counter counts CONSECUTIVE rejections — a single accepted
-- ingest breaks the streak. The receiver pipeline calls this on every
-- successful ingest from `p_node_id`. No-op if the counter is already 0,
-- which is the common path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_origin_rejection_streak(p_node_id TEXT)
RETURNS VOID AS $$
  UPDATE nodes
  SET    consecutive_rejections = 0
  WHERE  node_id = p_node_id
    AND  consecutive_rejections > 0;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION reset_origin_rejection_streak(TEXT)
  TO anon, service_role;
