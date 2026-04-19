-- 037_pki_lineage.sql — Phase 1 von Trust-Modell A: lokale PKI + signierte Lineage
--
-- Ziele:
--   - Jedes Genome hat ein Ed25519-Schlüsselpaar (Privkey nur im FS, Pubkey in DB).
--   - Das Profile (bio + interests + values + Hash des Centroids) ist self-signed.
--   - Bei Breeding signieren BEIDE Eltern eine Birth-Certificate für das Kind
--     (parent_a_sig ∧ parent_b_sig über payload).
--   - Memory-Provenance per Merkle-Root: über alle Memories mit
--     created_by_agent_id = genome.id wird ein SHA-256 Binary-Tree gebaut, die
--     Root ans Genome geheftet. Spätere Inclusion-Proofs sind möglich.
--   - `federated_from`: NULL = lokal erstellt; sonst Host-Identifier (Phase 2).
--
-- Wichtig: Diese Migration legt nur das Schema + Hilfs-RPCs an. Die eigentliche
-- Crypto-Verifikation findet in TypeScript statt (node:crypto Ed25519). PG hat
-- kein nativ-Ed25519 in pgcrypto, daher hier kein Verify-RPC.

ALTER TABLE agent_genomes
  ADD COLUMN IF NOT EXISTS pubkey               BYTEA,                -- Ed25519 raw 32 byte
  ADD COLUMN IF NOT EXISTS profile_signature    BYTEA,                -- Ed25519 sig (64 byte)
  ADD COLUMN IF NOT EXISTS profile_signed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS birth_certificate    JSONB,                -- { payload, parent_a_sig (hex), parent_b_sig (hex), v }
  ADD COLUMN IF NOT EXISTS memory_merkle_root   BYTEA,                -- SHA-256 root (32 byte)
  ADD COLUMN IF NOT EXISTS memory_merkle_n      INTEGER,              -- count an Leaves
  ADD COLUMN IF NOT EXISTS memory_merkle_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS federated_from       TEXT,                 -- NULL = lokal
  ADD COLUMN IF NOT EXISTS pubkey_created_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_genomes_pubkey_idx
  ON agent_genomes (pubkey) WHERE pubkey IS NOT NULL;

-- ---------------------------------------------------------------------------
-- _genome_profile_payload(label) — Daten, über die der Profil-Self-Sig läuft.
-- Stable canonical form: bio + sortierte interests + sortierte values
-- + sha256(profile_embedding) + signed_at-Hint (None für Hash-Berechnung).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_profile_payload(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  g agent_genomes%ROWTYPE;
  v_emb_hash TEXT;
BEGIN
  SELECT * INTO g FROM agent_genomes WHERE label = p_label;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  IF g.profile_embedding IS NOT NULL THEN
    v_emb_hash := encode(digest(g.profile_embedding::TEXT, 'sha256'), 'hex');
  ELSE
    v_emb_hash := NULL;
  END IF;
  RETURN jsonb_build_object(
    'v',          1,
    'id',         g.id,
    'label',      g.label,
    'generation', g.generation,
    'values',     (SELECT jsonb_agg(x ORDER BY x) FROM unnest(g.values)    AS x),
    'interests',  (SELECT jsonb_agg(x ORDER BY x) FROM unnest(g.interests) AS x),
    'curiosity_baseline',    g.curiosity_baseline,
    'frustration_threshold', g.frustration_threshold,
    'exploration_rate',      g.exploration_rate,
    'risk_tolerance',        g.risk_tolerance,
    'mutation_rate',         g.mutation_rate,
    'profile_embedding_sha256', v_emb_hash
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- genome_memory_leaves(label) — Liste aller Memory-Leaves für Merkle-Build.
-- Leaf = sha256(id ‖ content). Sortiert nach id für Determinismus.
-- Deckt nur eigene Memories ab (created_by_agent_id = genome.id), nicht
-- inherited Pointer (deren Provenance liegt beim Eltern-Genome).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_memory_leaves(p_label TEXT, p_limit INT DEFAULT 50000)
RETURNS TABLE (memory_id UUID, leaf BYTEA)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM agent_genomes WHERE label = p_label;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  RETURN QUERY
    SELECT m.id,
           digest(m.id::TEXT || E'\n' || m.content, 'sha256') AS leaf
      FROM memories m
     WHERE m.created_by_agent_id = v_id
       AND m.embedding IS NOT NULL
     ORDER BY m.id
     LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- genome_set_pki — Sammel-Update für die PKI-Felder, atomisch.
-- TypeScript ruft das nach Keygen + Profile-Sign + Merkle-Calc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_set_pki(
  p_label                TEXT,
  p_pubkey               BYTEA DEFAULT NULL,
  p_profile_signature    BYTEA DEFAULT NULL,
  p_birth_certificate    JSONB DEFAULT NULL,
  p_memory_merkle_root   BYTEA DEFAULT NULL,
  p_memory_merkle_n      INTEGER DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  g agent_genomes%ROWTYPE;
  v_set_pubkey BOOLEAN := p_pubkey IS NOT NULL;
  v_set_sig    BOOLEAN := p_profile_signature IS NOT NULL;
  v_set_birth  BOOLEAN := p_birth_certificate IS NOT NULL;
  v_set_mrk    BOOLEAN := p_memory_merkle_root IS NOT NULL;
BEGIN
  UPDATE agent_genomes SET
    pubkey               = CASE WHEN v_set_pubkey THEN p_pubkey                ELSE pubkey               END,
    pubkey_created_at    = CASE WHEN v_set_pubkey AND pubkey_created_at IS NULL THEN NOW() ELSE pubkey_created_at END,
    profile_signature    = CASE WHEN v_set_sig    THEN p_profile_signature     ELSE profile_signature    END,
    profile_signed_at    = CASE WHEN v_set_sig    THEN NOW()                   ELSE profile_signed_at    END,
    birth_certificate    = CASE WHEN v_set_birth  THEN p_birth_certificate     ELSE birth_certificate    END,
    memory_merkle_root   = CASE WHEN v_set_mrk    THEN p_memory_merkle_root    ELSE memory_merkle_root   END,
    memory_merkle_n      = CASE WHEN v_set_mrk    THEN COALESCE(p_memory_merkle_n, memory_merkle_n) ELSE memory_merkle_n END,
    memory_merkle_at     = CASE WHEN v_set_mrk    THEN NOW()                   ELSE memory_merkle_at     END,
    updated_at           = NOW()
  WHERE label = p_label
  RETURNING * INTO g;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  RETURN jsonb_build_object(
    'label', g.label,
    'has_pubkey',     g.pubkey IS NOT NULL,
    'has_profile_sig', g.profile_signature IS NOT NULL,
    'has_birth_cert', g.birth_certificate IS NOT NULL,
    'has_merkle',     g.memory_merkle_root IS NOT NULL,
    'merkle_n',       g.memory_merkle_n
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- genome_pki_status(label) — schneller Diagnose-Read für TS-Verify-Pipeline.
-- Liefert alle relevanten Felder als Hex-Strings (BYTEA → hex), damit der
-- TypeScript-Verifier nur eine RPC-Roundtrip braucht.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_pki_status(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  g agent_genomes%ROWTYPE;
  v_parents JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO g FROM agent_genomes WHERE label = p_label;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genome % not found', p_label;
  END IF;
  IF COALESCE(array_length(g.parent_ids, 1), 0) > 0 THEN
    SELECT jsonb_agg(jsonb_build_object(
      'id',     p.id,
      'label',  p.label,
      'pubkey', encode(p.pubkey, 'hex')
    ) ORDER BY p.label)
    INTO v_parents
    FROM agent_genomes p
    WHERE p.id = ANY(g.parent_ids);
  END IF;
  RETURN jsonb_build_object(
    'label',                g.label,
    'id',                   g.id,
    'generation',           g.generation,
    'parent_ids',           g.parent_ids,
    'parents',              v_parents,
    'pubkey_hex',           encode(g.pubkey, 'hex'),
    'profile_signature_hex',encode(g.profile_signature, 'hex'),
    'profile_signed_at',    g.profile_signed_at,
    'birth_certificate',    g.birth_certificate,
    'memory_merkle_root_hex', encode(g.memory_merkle_root, 'hex'),
    'memory_merkle_n',      g.memory_merkle_n,
    'memory_merkle_at',     g.memory_merkle_at,
    'federated_from',       g.federated_from,
    'profile_payload',      genome_profile_payload(p_label)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION genome_profile_payload(TEXT)                                     TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_memory_leaves(TEXT, INT)                                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_set_pki(TEXT, BYTEA, BYTEA, JSONB, BYTEA, INTEGER)        TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_pki_status(TEXT)                                          TO anon, service_role;

-- pgcrypto bereitstellen falls nicht da (für digest()).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
