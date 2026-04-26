-- 038_federation_trust.sql — Phase 2 Trust-Modell A: Trust-Roots, Revocation, Audit
--
-- Idee:
--   Bevor ein Genome aus einer fremden Quelle akzeptiert wird, muss seine
--   Lineage-Kette bis zu einem von uns explizit autorisierten Schlüssel
--   führen ("trust root"). Roots können Hosts (z.B. ein freundlicher
--   anderer Mac) oder einzelne Genome (z.B. ein vertrautes Modell) sein.
--
--   Revocation: kompromittierte Schlüssel landen in revoked_keys; jeder
--   Import prüft dort. Eintrag enthält Grund + Zeitpunkt.
--
--   Audit: jeder Import/Export wird unverändert geloggt (Forensik). Wir
--   speichern den Bundle-Hash, den Quell-Host, das Verdict und den Grund.
--
-- Crypto-Verifikation findet weiterhin TS-seitig statt (Ed25519). Diese
-- Migration legt nur Substrat + Hilfs-RPCs für Lookup/Insert.

-- ---------------------------------------------------------------------------
-- trust_roots — Allowlist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trust_roots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('host','genome','group')),
  identifier    TEXT NOT NULL,                -- e.g. 'mac-mini-m4', 'enrico-main', 'phasex-team'
  pubkey        BYTEA NOT NULL,               -- 32-byte Ed25519 raw
  label         TEXT,                         -- human-readable
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      TEXT,                         -- who added this root
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  UNIQUE (pubkey)
);

CREATE INDEX IF NOT EXISTS trust_roots_kind_idx ON trust_roots (kind, status);
CREATE INDEX IF NOT EXISTS trust_roots_identifier_idx ON trust_roots (identifier);

-- ---------------------------------------------------------------------------
-- revoked_keys — kompromittierte Schlüssel (kann Trust-Root sein oder einfach
-- ein Genome-Pubkey, der nie Trust-Root war aber trotzdem verbrannt ist).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revoked_keys (
  pubkey        BYTEA PRIMARY KEY,             -- 32-byte raw
  reason        TEXT NOT NULL,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by    TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}'    -- z.B. signed-revocation-cert von einem Trust-Root
);

CREATE INDEX IF NOT EXISTS revoked_keys_revoked_at_idx ON revoked_keys (revoked_at DESC);

-- ---------------------------------------------------------------------------
-- federation_imports — Audit-Trail für jeden Import-Versuch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_host     TEXT,                          -- self-deklariert vom Bundle
  source_pubkey   BYTEA,                         -- der Schlüssel, der das Bundle exportiert hat
  bundle_hash     BYTEA NOT NULL,                -- sha256 vom kanonischen Bundle
  genome_label    TEXT,                          -- Label des importierten Genoms
  genome_id       UUID,
  decision        TEXT NOT NULL CHECK (decision IN ('accepted','rejected','quarantined')),
  reason          TEXT,
  bundle          JSONB NOT NULL,                -- vollständiges Bundle für Forensik
  guard_verdicts  JSONB NOT NULL DEFAULT '{}',   -- Resultate von classify_content pro Feld
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by     TEXT
);

CREATE INDEX IF NOT EXISTS federation_imports_at_idx     ON federation_imports (imported_at DESC);
CREATE INDEX IF NOT EXISTS federation_imports_source_idx ON federation_imports (source_host, decision);
CREATE INDEX IF NOT EXISTS federation_imports_hash_idx   ON federation_imports (bundle_hash);

-- ---------------------------------------------------------------------------
-- federation_exports — Audit für rausgegebene Bundles (wer hat was bekommen)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation_exports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genome_label    TEXT NOT NULL,
  genome_id       UUID,
  destination     TEXT,                          -- wohin (Host-ID, "local-file", "manual-share")
  bundle_hash     BYTEA NOT NULL,
  bundle_size     INTEGER NOT NULL,
  include_memories BOOLEAN NOT NULL DEFAULT FALSE,
  exported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exported_by     TEXT
);

CREATE INDEX IF NOT EXISTS federation_exports_at_idx ON federation_exports (exported_at DESC);
CREATE INDEX IF NOT EXISTS federation_exports_genome_idx ON federation_exports (genome_label);

-- ---------------------------------------------------------------------------
-- trust_add(kind, identifier, pubkey, label, notes, added_by) — Allowlist-Eintrag
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trust_add(
  p_kind        TEXT,
  p_identifier  TEXT,
  p_pubkey      BYTEA,
  p_label       TEXT DEFAULT NULL,
  p_notes       TEXT DEFAULT NULL,
  p_added_by    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row trust_roots%ROWTYPE;
BEGIN
  IF length(p_pubkey) <> 32 THEN
    RAISE EXCEPTION 'pubkey must be 32 bytes (Ed25519 raw), got %', length(p_pubkey);
  END IF;
  -- Refuse if already revoked
  IF EXISTS (SELECT 1 FROM revoked_keys WHERE pubkey = p_pubkey) THEN
    RAISE EXCEPTION 'pubkey is in revoked_keys — cannot trust a revoked key';
  END IF;
  INSERT INTO trust_roots (kind, identifier, pubkey, label, notes, added_by)
  VALUES (p_kind, p_identifier, p_pubkey, p_label, p_notes, p_added_by)
  ON CONFLICT (pubkey) DO UPDATE SET
    kind        = EXCLUDED.kind,
    identifier  = EXCLUDED.identifier,
    label       = COALESCE(EXCLUDED.label, trust_roots.label),
    notes       = COALESCE(EXCLUDED.notes, trust_roots.notes),
    status      = 'active'
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION trust_revoke(
  p_pubkey      BYTEA,
  p_reason      TEXT,
  p_revoked_by  TEXT DEFAULT NULL,
  p_evidence    JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  IF length(p_pubkey) <> 32 THEN
    RAISE EXCEPTION 'pubkey must be 32 bytes';
  END IF;
  -- Mark trust_roots row as revoked (keep history)
  UPDATE trust_roots SET status = 'revoked' WHERE pubkey = p_pubkey;
  -- Add to revoked_keys (idempotent)
  INSERT INTO revoked_keys (pubkey, reason, revoked_by, evidence)
  VALUES (p_pubkey, p_reason, p_revoked_by, COALESCE(p_evidence, '{}'::jsonb))
  ON CONFLICT (pubkey) DO UPDATE SET
    reason     = EXCLUDED.reason,
    revoked_at = NOW(),
    revoked_by = COALESCE(EXCLUDED.revoked_by, revoked_keys.revoked_by),
    evidence   = revoked_keys.evidence || EXCLUDED.evidence;
  RETURN jsonb_build_object('pubkey_hex', encode(p_pubkey, 'hex'), 'reason', p_reason);
END;
$$;

-- ---------------------------------------------------------------------------
-- trust_list() — alle aktiven Trust-Roots als JSON
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trust_list(p_include_revoked BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',         id,
    'kind',       kind,
    'identifier', identifier,
    'pubkey_hex', encode(pubkey, 'hex'),
    'label',      label,
    'notes',      notes,
    'added_at',   added_at,
    'added_by',   added_by,
    'status',     status
  ) ORDER BY added_at DESC), '[]'::jsonb)
  FROM trust_roots
  WHERE p_include_revoked OR status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- trust_check(pubkey) — ist dieser Schlüssel ein aktiver Trust-Root?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trust_check(p_pubkey BYTEA)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_root trust_roots%ROWTYPE;
  v_revoked revoked_keys%ROWTYPE;
BEGIN
  SELECT * INTO v_revoked FROM revoked_keys WHERE pubkey = p_pubkey;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'trusted', false, 'revoked', true,
      'reason', v_revoked.reason, 'revoked_at', v_revoked.revoked_at
    );
  END IF;
  SELECT * INTO v_root FROM trust_roots WHERE pubkey = p_pubkey AND status = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object(
      'trusted', true, 'revoked', false,
      'kind', v_root.kind, 'identifier', v_root.identifier, 'label', v_root.label
    );
  END IF;
  RETURN jsonb_build_object('trusted', false, 'revoked', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- federation_log_import / federation_log_export — Audit-Inserts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION federation_log_import(
  p_source_host    TEXT,
  p_source_pubkey  BYTEA,
  p_bundle_hash    BYTEA,
  p_bundle         JSONB,
  p_genome_label   TEXT,
  p_genome_id      UUID,
  p_decision       TEXT,
  p_reason         TEXT,
  p_guard_verdicts JSONB DEFAULT '{}'::jsonb,
  p_imported_by    TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO federation_imports (
    source_host, source_pubkey, bundle_hash, bundle,
    genome_label, genome_id, decision, reason, guard_verdicts, imported_by
  ) VALUES (
    p_source_host, p_source_pubkey, p_bundle_hash, p_bundle,
    p_genome_label, p_genome_id, p_decision, p_reason,
    COALESCE(p_guard_verdicts, '{}'::jsonb), p_imported_by
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION federation_log_export(
  p_genome_label   TEXT,
  p_genome_id      UUID,
  p_destination    TEXT,
  p_bundle_hash    BYTEA,
  p_bundle_size    INTEGER,
  p_include_memories BOOLEAN DEFAULT FALSE,
  p_exported_by    TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO federation_exports (
    genome_label, genome_id, destination, bundle_hash, bundle_size,
    include_memories, exported_by
  ) VALUES (
    p_genome_label, p_genome_id, p_destination, p_bundle_hash, p_bundle_size,
    p_include_memories, p_exported_by
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- federation_recent(p_limit) — kompakte Anzeige der letzten Imports
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION federation_recent(p_limit INT DEFAULT 25)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',           id,
    'source_host',  source_host,
    'source_pubkey_hex', encode(source_pubkey, 'hex'),
    'genome_label', genome_label,
    'decision',     decision,
    'reason',       reason,
    'imported_at',  imported_at,
    'guard_verdicts', guard_verdicts
  ) ORDER BY imported_at DESC), '[]'::jsonb)
  FROM (
    SELECT * FROM federation_imports
    ORDER BY imported_at DESC
    LIMIT p_limit
  ) x;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON trust_roots         TO anon, service_role;
GRANT SELECT, INSERT, UPDATE          ON revoked_keys       TO anon, service_role;
GRANT SELECT, INSERT                  ON federation_imports TO anon, service_role;
GRANT SELECT, INSERT                  ON federation_exports TO anon, service_role;

GRANT EXECUTE ON FUNCTION trust_add(TEXT, TEXT, BYTEA, TEXT, TEXT, TEXT)              TO anon, service_role;
GRANT EXECUTE ON FUNCTION trust_revoke(BYTEA, TEXT, TEXT, JSONB)                       TO anon, service_role;
GRANT EXECUTE ON FUNCTION trust_list(BOOLEAN)                                          TO anon, service_role;
GRANT EXECUTE ON FUNCTION trust_check(BYTEA)                                           TO anon, service_role;
GRANT EXECUTE ON FUNCTION federation_log_import(TEXT, BYTEA, BYTEA, JSONB, TEXT, UUID, TEXT, TEXT, JSONB, TEXT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION federation_log_export(TEXT, UUID, TEXT, BYTEA, INTEGER, BOOLEAN, TEXT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION federation_recent(INT)                                       TO anon, service_role;
