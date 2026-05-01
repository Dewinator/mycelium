-- 087_swarm_publish_tier_a.sql — Swarm Phase 4, issue #143 (write-side slice)
--
-- Atomic backend RPC for the `swarm_publish_tier_a_lesson` MCP tool.
-- Forces a locally-generated lesson into the broadcast-eligible Tier-A
-- state in a single transaction:
--
--   1. Append a row to `lesson_chain` (commits the §3.7.2 chain).
--   2. Insert a row into `swarm_lessons` (default tier 'B' from migration 078
--      DEFAULT — the firebreak holds inside this txn for a single statement).
--   3. Append a `tier_promotion_log` row (B → A, reason starts with
--      'tool-publish'). The (from_tier <> to_tier) CHECK is satisfied
--      because we transition B → A within the same txn.
--   4. Update `swarm_lessons.lesson_tier` to 'A'.
--
-- All four writes share one transaction. On any failure mid-flight the
-- entire publish rolls back — no orphan chain row, no half-promoted swarm
-- row, no dangling audit row. This is the atomicity the resolve-contradict
-- RPC (migration 086) provides for §10.3 resolutions, applied to §10.6
-- producer-side publication.
--
-- Why a dedicated RPC rather than the producer pipeline used by /swarm/lessons
-- inbound admission (PR #154):
--   - inbound admission writes Tier-B; here we MUST land at Tier-A with an
--     audit row. Re-using the inbound path would not exercise the audit.
--   - The producer-side lesson_chain hook (PR #146) signs + chains a lesson
--     in the local lessons workflow but never touches swarm_lessons. This
--     RPC bridges that gap for the operator-tool surface.
--   - The signing step still happens in TS (the privkey stays in the chmod
--     0600 file outside the database — pillar 1 sovereignty). The TS layer
--     reads the chain tip, signs, computes the lesson_hash, and passes the
--     full payload to this RPC for the atomic apply.
--
-- Concurrency contract — sequence_number race:
--   Two concurrent publishers can read the same chain tip and race to insert
--   the same sequence_number. Migration 074's UNIQUE(sequence_number) catches
--   the loser. We re-raise as a typed error (`sequence_number_race`) so the
--   TS service knows to re-read the tip, re-sign, and retry. Three retries
--   is the budget — a third concurrent publisher on a single mycelium
--   indicates misconfiguration. Same retry policy as
--   signLessonAndAppendToChain (lesson-chain.ts).
--
-- Idempotency contract:
--   If a swarm_lessons row already exists for `p_lesson_id` AND its tier is
--   'A', the RPC returns ok=true / status='already_published' without
--   touching anything. Re-running the tool against an already-published
--   lesson is therefore a safe no-op. A swarm_lessons row at 'B' for a
--   self-published lesson is an inconsistent state (a self-row with chain
--   entry must always be A under this RPC's contract); the RPC raises so
--   the operator can investigate rather than silently re-promote.
--
-- Self-broadcast safety integration:
--   The lesson_chain INSERT triggers `lesson_chain_assert_self_origin`
--   (migration 085), which requires `nodes WHERE is_self = TRUE`. The
--   swarm_lessons INSERT triggers `swarm_lessons_assert_self_origin`,
--   which (since the chain row was just inserted in the same txn) checks
--   that `p_origin = self_node_id`. This RPC verifies self-identity before
--   any insert and rejects with a clean error if `p_origin` doesn't match
--   — the trigger remains the SQL-layer firewall but the RPC gives a
--   readable error before the trigger fires.
--
-- Scope discipline:
--   * One new RPC + GRANT. No DROP, no DELETE on existing tables, no
--     schema changes. Reed runs the migration manually after merge —
--     the autonomy loop is forbidden from executing it (075-086 discipline).
--   * The MCP tool surface (swarm_publish_tier_a_lesson) lands in the
--     same PR; the dashboard frontend for "operator publish" is not in
--     scope for #143 (separate from #142's contradict/quarantine UI).

-- ---------------------------------------------------------------------------
-- (1) operator_publish_tier_a_lesson — atomic publish + chain + audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_publish_tier_a_lesson(
  p_lesson_id     UUID,
  p_content       TEXT,
  p_embedding     VECTOR(768),
  p_synth_size    INT,
  p_origin        TEXT,
  p_signed_at     TIMESTAMPTZ,
  p_created_at    TIMESTAMPTZ,
  p_signature     TEXT,
  p_tags          TEXT[],
  p_spec_version  TEXT,
  p_lesson_hash   TEXT,
  p_prev_hash     TEXT,
  p_sequence      INT,
  p_audit_note    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_self          TEXT;
  v_existing_tier TEXT;
  v_existing_chain BOOLEAN;
  v_now           TIMESTAMPTZ := NOW();
  v_audit_reason  TEXT;
BEGIN
  -- (a) Self-identity check (defense in depth — the trigger from migration
  --     085 also asserts this, but a clean error here beats a trigger raise).
  SELECT node_id INTO v_self FROM nodes WHERE is_self = TRUE LIMIT 1;
  IF v_self IS NULL THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: no is_self row in nodes — bootstrap node identity first';
  END IF;
  IF p_origin IS DISTINCT FROM v_self THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: origin % does not match local self %', p_origin, v_self;
  END IF;

  -- (b) Spec invariants the migration-071 column CHECKs would also catch,
  --     but raising here gives the caller a meaningful error rather than
  --     a generic constraint violation.
  IF p_synth_size < 2 THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: synthesized_from_cluster_size must be >= 2 (got %)', p_synth_size;
  END IF;
  IF octet_length(p_content) > 8192 THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: content exceeds 8192 octets (% octets)', octet_length(p_content);
  END IF;
  IF p_signed_at < p_created_at THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: signed_at (%) must be >= created_at (%)', p_signed_at, p_created_at;
  END IF;

  -- (c) Chain tip biconditional (migration 074 CHECK) — re-asserted here
  --     so a malformed caller gets a clean error pre-INSERT.
  IF (p_sequence = 0) <> (p_prev_hash IS NULL) THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: chain tip biconditional violated (sequence=%, prev_hash=%)',
      p_sequence, COALESCE(p_prev_hash, 'NULL');
  END IF;
  IF p_sequence < 0 THEN
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: sequence must be non-negative (got %)', p_sequence;
  END IF;

  -- (d) Idempotency — already published?
  SELECT lesson_tier INTO v_existing_tier FROM swarm_lessons WHERE id = p_lesson_id;
  IF v_existing_tier = 'A' THEN
    -- Already at A. Whether or not a chain row exists, the broadcast
    -- contract is satisfied; treat as no-op.
    SELECT EXISTS(SELECT 1 FROM lesson_chain WHERE lesson_id = p_lesson_id)
      INTO v_existing_chain;
    RETURN jsonb_build_object(
      'ok',          true,
      'status',      'already_published',
      'lesson_id',   p_lesson_id,
      'lesson_tier', 'A',
      'chain_present', v_existing_chain
    );
  ELSIF v_existing_tier = 'B' THEN
    -- A self-published lesson at tier B with this RPC's contract is an
    -- inconsistent state (either a previous publish was interrupted between
    -- the swarm_lessons INSERT and the tier UPDATE — the txn boundary should
    -- have prevented that — or the row was admitted as foreign and the chain
    -- insert below would re-attribute it). Either way: refuse rather than
    -- silently re-promote a non-self row.
    RAISE EXCEPTION 'operator_publish_tier_a_lesson: lesson % already exists at tier B — operator must inspect before re-publish', p_lesson_id;
  END IF;

  -- (e) Build the audit reason. 512 octet CHECK on tier_promotion_log.reason
  --     leaves us ~480 octets for the operator note after the prefix.
  v_audit_reason := 'tool-publish';
  IF p_audit_note IS NOT NULL AND length(trim(p_audit_note)) > 0 THEN
    v_audit_reason := v_audit_reason || ': ' || left(trim(p_audit_note), 480);
  END IF;

  -- (f) The four writes — all in this txn. Chain first so the
  --     swarm_lessons trigger (migration 085) sees the chain row exists
  --     and enforces origin=self via the cross-row check.
  INSERT INTO lesson_chain (lesson_id, signed_at, lesson_hash, prev_lesson_hash, sequence_number)
  VALUES (p_lesson_id, p_signed_at, p_lesson_hash, p_prev_hash, p_sequence);

  INSERT INTO swarm_lessons (
    id, content, embedding, synthesized_from_cluster_size, origin_node_id,
    signed_at, created_at, signature, tags, spec_version
  ) VALUES (
    p_lesson_id, p_content, p_embedding, p_synth_size, p_origin,
    p_signed_at, p_created_at, p_signature, p_tags, p_spec_version
  );
  -- lesson_tier defaults to 'B' (migration 078 firebreak); promote next.

  INSERT INTO tier_promotion_log (lesson_id, from_tier, to_tier, reason, evidence_ids)
  VALUES (p_lesson_id, 'B', 'A', v_audit_reason, ARRAY[]::UUID[]);

  UPDATE swarm_lessons SET lesson_tier = 'A' WHERE id = p_lesson_id;

  RETURN jsonb_build_object(
    'ok',             true,
    'status',         'published',
    'lesson_id',      p_lesson_id,
    'origin_node_id', p_origin,
    'lesson_tier',    'A',
    'sequence_number', p_sequence,
    'lesson_hash',    p_lesson_hash,
    'audit_reason',   v_audit_reason,
    'signed_at',      p_signed_at,
    'received_at',    v_now
  );

EXCEPTION
  WHEN unique_violation THEN
    -- Re-raise UNIQUE conflicts with stable diagnostic prefixes the TS
    -- service can pattern-match on. The lesson_chain conflicts are the
    -- two retry-or-idempotency cases; the swarm_lessons one is a hard
    -- error (the idempotency check above should have caught the
    -- already-exists case — reaching here means a race in the tiny
    -- window between SELECT and INSERT).
    IF SQLERRM LIKE '%lesson_chain_pkey%' OR SQLERRM LIKE '%lesson_chain%lesson_id%' THEN
      RAISE EXCEPTION 'operator_publish_tier_a_lesson: lesson_chain_lesson_id_race (%)', SQLERRM;
    ELSIF SQLERRM LIKE '%lesson_chain_sequence_number%' OR SQLERRM LIKE '%sequence_number%' THEN
      RAISE EXCEPTION 'operator_publish_tier_a_lesson: lesson_chain_sequence_number_race (%)', SQLERRM;
    ELSIF SQLERRM LIKE '%swarm_lessons_pkey%' OR SQLERRM LIKE '%swarm_lessons%id%' THEN
      RAISE EXCEPTION 'operator_publish_tier_a_lesson: swarm_lessons_id_race (%)', SQLERRM;
    ELSE
      RAISE;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION operator_publish_tier_a_lesson(
  UUID, TEXT, VECTOR(768), INT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], TEXT,
  TEXT, TEXT, INT, TEXT
) TO anon, service_role;

COMMENT ON FUNCTION operator_publish_tier_a_lesson(
  UUID, TEXT, VECTOR(768), INT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], TEXT,
  TEXT, TEXT, INT, TEXT
) IS
  'docs/SWARM_SPEC.md §10.6 producer-side publish path. Atomically signs (caller-supplied), chains, inserts into swarm_lessons at tier B (firebreak default) and promotes to tier A with a tier_promotion_log audit row (reason starts with ''tool-publish''). Backend for the swarm_publish_tier_a_lesson MCP tool (issue #143 write-side slice). Idempotent against already-published lessons; raises lesson_chain_sequence_number_race for concurrent-publisher retries.';
