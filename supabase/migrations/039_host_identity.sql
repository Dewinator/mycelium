-- 039_host_identity.sql — Phase 3a: Host-Identität + Peer-Tabelle
--
-- host_identity: genau eine Zeile (Singleton via UNIQUE-constraint), beschreibt
--   diesen Node — TLS-Cert-Pubkey + Cert-Fingerprint + selbst-vergebenes Label.
--
-- peers: zuletzt-gesehene fremde Hosts. Pro mTLS-Connect updaten wir last_seen.
--   Trust-Entscheidungen liegen aber WEITERHIN bei trust_roots — diese Tabelle
--   ist Telemetry, nicht Auth.

CREATE TABLE IF NOT EXISTS host_identity (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label             TEXT NOT NULL,                 -- z.B. 'mac-mini-m4'
  pubkey            BYTEA NOT NULL,                -- Ed25519 raw 32 byte (= cert pubkey)
  cert_fingerprint  BYTEA NOT NULL,                -- SHA-256 over DER cert bytes
  cert_pem          TEXT NOT NULL,                 -- the cert (no privkey!)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at        TIMESTAMPTZ,                   -- when last cert rotation happened
  notes             TEXT
);

-- Singleton-enforcement: nur eine "active" Zeile.
CREATE UNIQUE INDEX IF NOT EXISTS host_identity_singleton
  ON host_identity ((TRUE)) WHERE rotated_at IS NULL;

CREATE TABLE IF NOT EXISTS peers (
  pubkey            BYTEA PRIMARY KEY,             -- Ed25519 raw
  label             TEXT,                          -- self-deklariert vom Peer
  cert_fingerprint  BYTEA,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_remote_addr  TEXT,                          -- IP:port der letzten Connection
  trust_status      TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (trust_status IN ('unknown','trusted','revoked')),
  metadata          JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS peers_last_seen_idx ON peers (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- host_identity_set(label, pubkey, cert_fingerprint, cert_pem)
-- Idempotent: gleiche pubkey → no-op (returns existing); andere pubkey →
-- alter Eintrag wird auf rotated_at=NOW() gesetzt, neuer eingefügt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION host_identity_set(
  p_label TEXT,
  p_pubkey BYTEA,
  p_cert_fingerprint BYTEA,
  p_cert_pem TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing host_identity%ROWTYPE;
  v_new      host_identity%ROWTYPE;
BEGIN
  IF length(p_pubkey) <> 32 THEN
    RAISE EXCEPTION 'pubkey must be 32 bytes';
  END IF;
  SELECT * INTO v_existing FROM host_identity WHERE rotated_at IS NULL;
  IF FOUND AND v_existing.pubkey = p_pubkey THEN
    -- already current
    RETURN to_jsonb(v_existing);
  END IF;
  IF FOUND THEN
    UPDATE host_identity SET rotated_at = NOW() WHERE id = v_existing.id;
  END IF;
  INSERT INTO host_identity (label, pubkey, cert_fingerprint, cert_pem)
  VALUES (p_label, p_pubkey, p_cert_fingerprint, p_cert_pem)
  RETURNING * INTO v_new;
  RETURN to_jsonb(v_new);
END;
$$;

CREATE OR REPLACE FUNCTION host_identity_current()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(to_jsonb(h), '{}'::jsonb)
  FROM (
    SELECT id, label, encode(pubkey, 'hex') AS pubkey_hex,
           encode(cert_fingerprint, 'hex') AS cert_fingerprint_hex,
           created_at, notes
    FROM host_identity
    WHERE rotated_at IS NULL
    LIMIT 1
  ) h;
$$;

-- ---------------------------------------------------------------------------
-- peer_seen(pubkey, label, cert_fingerprint, remote_addr)
-- Upsert: erstes Sehen → insert; danach last_seen_at + trust_status update.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION peer_seen(
  p_pubkey           BYTEA,
  p_label            TEXT DEFAULT NULL,
  p_cert_fingerprint BYTEA DEFAULT NULL,
  p_remote_addr      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row peers%ROWTYPE;
  v_status TEXT;
BEGIN
  -- determine current trust status
  IF EXISTS (SELECT 1 FROM revoked_keys WHERE pubkey = p_pubkey) THEN
    v_status := 'revoked';
  ELSIF EXISTS (SELECT 1 FROM trust_roots WHERE pubkey = p_pubkey AND status = 'active') THEN
    v_status := 'trusted';
  ELSE
    v_status := 'unknown';
  END IF;

  INSERT INTO peers (pubkey, label, cert_fingerprint, last_remote_addr, trust_status)
  VALUES (p_pubkey, p_label, p_cert_fingerprint, p_remote_addr, v_status)
  ON CONFLICT (pubkey) DO UPDATE SET
    label             = COALESCE(EXCLUDED.label, peers.label),
    cert_fingerprint  = COALESCE(EXCLUDED.cert_fingerprint, peers.cert_fingerprint),
    last_seen_at      = NOW(),
    last_remote_addr  = COALESCE(EXCLUDED.last_remote_addr, peers.last_remote_addr),
    trust_status      = v_status
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'pubkey_hex', encode(v_row.pubkey, 'hex'),
    'label',      v_row.label,
    'trust_status', v_row.trust_status,
    'last_seen_at', v_row.last_seen_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION peers_recent(p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'pubkey_hex',       encode(pubkey, 'hex'),
    'label',            label,
    'trust_status',     trust_status,
    'first_seen_at',    first_seen_at,
    'last_seen_at',     last_seen_at,
    'last_remote_addr', last_remote_addr
  ) ORDER BY last_seen_at DESC), '[]'::jsonb)
  FROM (
    SELECT * FROM peers ORDER BY last_seen_at DESC LIMIT p_limit
  ) p;
$$;

GRANT SELECT, INSERT, UPDATE ON host_identity TO anon, service_role;
GRANT SELECT, INSERT, UPDATE ON peers         TO anon, service_role;
GRANT EXECUTE ON FUNCTION host_identity_set(TEXT, BYTEA, BYTEA, TEXT)         TO anon, service_role;
GRANT EXECUTE ON FUNCTION host_identity_current()                              TO anon, service_role;
GRANT EXECUTE ON FUNCTION peer_seen(BYTEA, TEXT, BYTEA, TEXT)                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION peers_recent(INT)                                    TO anon, service_role;
