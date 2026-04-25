-- 053_universal_salience.sql — Phase 2 of Hub-Architektur
--
-- "Koexistierende kognitive Prozesse, gekoppelt durch gemeinsame Signale."
-- Today every cognitive table has its own ad-hoc strength model:
--
--   memories      — strength + access_count + useful_count + decay_tau_days,
--                   with a computed salience score in match_memories_cognitive.
--   experiences   — only valence/arousal/difficulty; no decay, no salience.
--   lessons       — only confidence; no decay, no salience.
--   soul_traits   — only confidence + last_reinforced_at; no decay.
--   intentions    — only priority; no decay, no salience.
--
-- This patchwork is exactly the "fragmentiertes Gehirn" the V2 audit
-- (memory 3a3c52c9) flagged: features exist, but the modules speak
-- different dialects of "how active is this row right now". Phase 2
-- adds ONE universal signal — `salience ∈ [0,1]`, baseline 0.5 — to the
-- four non-memory cognitive tables, plus a `last_accessed_at` for
-- decay tracking. The four tables already have separate semantics
-- (confidence, priority, …) — salience layers on top as a generic
-- "heard recently / mattered recently" channel that any agent can
-- read or write without learning per-table dialects.
--
-- Memories are deliberately NOT touched: they already have a richer
-- multi-component salience (008's computed formula plus strength/
-- access patterns). Phase 2's job is to bring the OTHER four into
-- the same room. Phase 4 (atomization) will eventually unify the
-- whole picture; this is the bridge.

-- ---------------------------------------------------------------------------
-- 1. Add salience + last_accessed_at columns
-- ---------------------------------------------------------------------------

ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS salience          FLOAT       NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS last_accessed_at  TIMESTAMPTZ          DEFAULT NOW();

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS salience          FLOAT       NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS last_accessed_at  TIMESTAMPTZ          DEFAULT NOW();

ALTER TABLE soul_traits
  ADD COLUMN IF NOT EXISTS salience          FLOAT       NOT NULL DEFAULT 0.5;
-- soul_traits already has last_reinforced_at — that's the same concept,
-- so we don't add a duplicate column. The bump RPC writes to it instead.

ALTER TABLE intentions
  ADD COLUMN IF NOT EXISTS salience          FLOAT       NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS last_accessed_at  TIMESTAMPTZ          DEFAULT NOW();

-- Range checks. NOT VALID + VALIDATE so existing rows (all defaults) don't
-- get re-scanned on a hot table.
ALTER TABLE experiences  ADD CONSTRAINT experiences_salience_range  CHECK (salience >= 0 AND salience <= 1) NOT VALID;
ALTER TABLE lessons      ADD CONSTRAINT lessons_salience_range      CHECK (salience >= 0 AND salience <= 1) NOT VALID;
ALTER TABLE soul_traits  ADD CONSTRAINT soul_traits_salience_range  CHECK (salience >= 0 AND salience <= 1) NOT VALID;
ALTER TABLE intentions   ADD CONSTRAINT intentions_salience_range   CHECK (salience >= 0 AND salience <= 1) NOT VALID;

ALTER TABLE experiences  VALIDATE CONSTRAINT experiences_salience_range;
ALTER TABLE lessons      VALIDATE CONSTRAINT lessons_salience_range;
ALTER TABLE soul_traits  VALIDATE CONSTRAINT soul_traits_salience_range;
ALTER TABLE intentions   VALIDATE CONSTRAINT intentions_salience_range;

CREATE INDEX IF NOT EXISTS experiences_salience_idx        ON experiences (salience);
CREATE INDEX IF NOT EXISTS experiences_last_accessed_idx   ON experiences (last_accessed_at);
CREATE INDEX IF NOT EXISTS lessons_salience_idx            ON lessons (salience);
CREATE INDEX IF NOT EXISTS lessons_last_accessed_idx       ON lessons (last_accessed_at);
CREATE INDEX IF NOT EXISTS soul_traits_salience_idx        ON soul_traits (salience);
CREATE INDEX IF NOT EXISTS intentions_salience_idx         ON intentions (salience);
CREATE INDEX IF NOT EXISTS intentions_last_accessed_idx    ON intentions (last_accessed_at);

-- ---------------------------------------------------------------------------
-- 2. bump_salience — one canonical write path
-- ---------------------------------------------------------------------------
-- The Reactor (and any future caller) uses this single RPC to nudge the
-- salience of any cognitive row by `p_delta`. Asymmetric clamp toward 0.5
-- baseline: positive deltas have diminishing returns (smooth_bump_up),
-- negative deltas similarly. This means a row at 0.95 can't easily hit
-- 1.0 from a single small +0.05; conversely a row at 0.05 won't crash
-- below zero from a single -0.05. Same shape as coactivate_pair's
-- weight bump.

CREATE OR REPLACE FUNCTION bump_salience(
  p_kind  TEXT,
  p_id    UUID,
  p_delta FLOAT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_old FLOAT;
  v_new FLOAT;
BEGIN
  -- Whitelist guard — dynamic SQL only over known table names.
  IF p_kind NOT IN ('experience', 'lesson', 'trait', 'intention') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown kind: ' || p_kind);
  END IF;

  IF p_kind = 'experience' THEN
    UPDATE experiences
    SET salience = LEAST(1.0, GREATEST(0.0,
                  CASE WHEN p_delta >= 0
                       THEN salience + p_delta * (1.0 - salience)
                       ELSE salience + p_delta * salience
                  END)),
        last_accessed_at = NOW()
    WHERE id = p_id
    RETURNING salience INTO v_new;
    -- v_old is unused after the smooth update; left for symmetry/logging.
    GET DIAGNOSTICS v_old = ROW_COUNT;
  ELSIF p_kind = 'lesson' THEN
    UPDATE lessons
    SET salience = LEAST(1.0, GREATEST(0.0,
                  CASE WHEN p_delta >= 0
                       THEN salience + p_delta * (1.0 - salience)
                       ELSE salience + p_delta * salience
                  END)),
        last_accessed_at = NOW()
    WHERE id = p_id
    RETURNING salience INTO v_new;
    GET DIAGNOSTICS v_old = ROW_COUNT;
  ELSIF p_kind = 'trait' THEN
    UPDATE soul_traits
    SET salience = LEAST(1.0, GREATEST(0.0,
                  CASE WHEN p_delta >= 0
                       THEN salience + p_delta * (1.0 - salience)
                       ELSE salience + p_delta * salience
                  END)),
        last_reinforced_at = NOW()
    WHERE id = p_id
    RETURNING salience INTO v_new;
    GET DIAGNOSTICS v_old = ROW_COUNT;
  ELSIF p_kind = 'intention' THEN
    UPDATE intentions
    SET salience = LEAST(1.0, GREATEST(0.0,
                  CASE WHEN p_delta >= 0
                       THEN salience + p_delta * (1.0 - salience)
                       ELSE salience + p_delta * salience
                  END)),
        last_accessed_at = NOW()
    WHERE id = p_id
    RETURNING salience INTO v_new;
    GET DIAGNOSTICS v_old = ROW_COUNT;
  END IF;

  IF v_new IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'row not found', 'kind', p_kind, 'id', p_id);
  END IF;

  RETURN jsonb_build_object(
    'ok',       true,
    'kind',     p_kind,
    'id',       p_id,
    'salience', v_new,
    'delta',    p_delta
  );
END;
$$;

GRANT EXECUTE ON FUNCTION bump_salience(TEXT, UUID, FLOAT) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 3. decay_salience — nightly drift toward 0.5 baseline
-- ---------------------------------------------------------------------------
-- Exponential decay toward 0.5 with time-constant tau_days, computed from
-- last_accessed_at (or last_reinforced_at for soul_traits). Returns row
-- counts per kind for telemetry. Idempotent — calling twice in a row with
-- no events in between is a no-op because last_accessed_at didn't move.
--
-- Formula: salience' = 0.5 + (salience - 0.5) * exp(-dt/tau)
-- Rows with NULL last_accessed_at are seeded to NOW() so the next pass
-- can compute dt cleanly.

CREATE OR REPLACE FUNCTION decay_salience(p_tau_days FLOAT DEFAULT 30.0)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  n_exp INT;
  n_les INT;
  n_tra INT;
  n_int INT;
BEGIN
  UPDATE experiences SET last_accessed_at = NOW() WHERE last_accessed_at IS NULL;
  UPDATE lessons     SET last_accessed_at = NOW() WHERE last_accessed_at IS NULL;
  UPDATE intentions  SET last_accessed_at = NOW() WHERE last_accessed_at IS NULL;

  WITH up AS (
    UPDATE experiences SET salience = 0.5 + (salience - 0.5)
        * exp(-EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0 / p_tau_days)
    WHERE last_accessed_at < NOW() - INTERVAL '1 hour'
    RETURNING 1
  ) SELECT count(*) INTO n_exp FROM up;

  WITH up AS (
    UPDATE lessons SET salience = 0.5 + (salience - 0.5)
        * exp(-EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0 / p_tau_days)
    WHERE last_accessed_at < NOW() - INTERVAL '1 hour'
    RETURNING 1
  ) SELECT count(*) INTO n_les FROM up;

  WITH up AS (
    UPDATE soul_traits SET salience = 0.5 + (salience - 0.5)
        * exp(-EXTRACT(EPOCH FROM (NOW() - last_reinforced_at)) / 86400.0 / p_tau_days)
    WHERE last_reinforced_at < NOW() - INTERVAL '1 hour'
    RETURNING 1
  ) SELECT count(*) INTO n_tra FROM up;

  WITH up AS (
    UPDATE intentions SET salience = 0.5 + (salience - 0.5)
        * exp(-EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0 / p_tau_days)
    WHERE last_accessed_at < NOW() - INTERVAL '1 hour'
      AND status = 'open'
    RETURNING 1
  ) SELECT count(*) INTO n_int FROM up;

  RETURN jsonb_build_object(
    'ok',          true,
    'tau_days',    p_tau_days,
    'experiences', n_exp,
    'lessons',     n_les,
    'traits',      n_tra,
    'intentions',  n_int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION decay_salience(FLOAT) TO anon, service_role;
