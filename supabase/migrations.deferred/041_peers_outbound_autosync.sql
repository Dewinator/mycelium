-- 041_peers_outbound_autosync.sql — Phase 3f: Peer-Directory mit Auto-Sync
--
-- Bisher (Migration 039): peers war reine Inbound-Telemetrie (wer hat uns
-- angerufen + Trust-Status). Jetzt zusätzlich Outbound-Richtung + Scheduler-Flag
-- fürs periodische Revocation-Sync.
--
-- Migration 039 hat uns (bewusst) kein DELETE gegeben. Wir nutzen
-- auto_sync_enabled=FALSE als Soft-Disable statt Delete.

ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS outbound_host       TEXT,
  ADD COLUMN IF NOT EXISTS outbound_port       INTEGER,
  ADD COLUMN IF NOT EXISTS auto_sync_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_auto_sync_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auto_sync_ok   BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_auto_sync_note TEXT,
  ADD COLUMN IF NOT EXISTS sync_errors         INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS peers_autosync_idx
  ON peers (auto_sync_enabled, last_auto_sync_at)
  WHERE auto_sync_enabled = TRUE;

-- ---------------------------------------------------------------------------
-- peer_upsert(pubkey, label, outbound_host, outbound_port, auto_sync_enabled)
-- Idempotent. Erster Eintrag → insert; danach selective update.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION peer_upsert(
  p_pubkey             BYTEA,
  p_label              TEXT DEFAULT NULL,
  p_outbound_host      TEXT DEFAULT NULL,
  p_outbound_port      INTEGER DEFAULT NULL,
  p_auto_sync_enabled  BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row   peers%ROWTYPE;
  v_status TEXT;
BEGIN
  IF length(p_pubkey) <> 32 THEN
    RAISE EXCEPTION 'pubkey must be 32 bytes';
  END IF;
  -- trust-status neu berechnen (Trust-Roots/Revocations könnten sich geändert haben)
  IF EXISTS (SELECT 1 FROM revoked_keys WHERE pubkey = p_pubkey) THEN
    v_status := 'revoked';
  ELSIF EXISTS (SELECT 1 FROM trust_roots WHERE pubkey = p_pubkey AND status = 'active') THEN
    v_status := 'trusted';
  ELSE
    v_status := 'unknown';
  END IF;

  INSERT INTO peers (pubkey, label, outbound_host, outbound_port, auto_sync_enabled, trust_status)
  VALUES (p_pubkey, p_label, p_outbound_host, p_outbound_port,
          COALESCE(p_auto_sync_enabled, FALSE), v_status)
  ON CONFLICT (pubkey) DO UPDATE SET
    label              = COALESCE(EXCLUDED.label, peers.label),
    outbound_host      = COALESCE(EXCLUDED.outbound_host, peers.outbound_host),
    outbound_port      = COALESCE(EXCLUDED.outbound_port, peers.outbound_port),
    auto_sync_enabled  = COALESCE(p_auto_sync_enabled, peers.auto_sync_enabled),
    trust_status       = v_status
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- peers_list(only_autosync?) — für Dashboard & Cron-Loop
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION peers_list(p_only_autosync BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'pubkey_hex',         encode(pubkey, 'hex'),
    'label',              label,
    'trust_status',       trust_status,
    'outbound_host',      outbound_host,
    'outbound_port',      outbound_port,
    'auto_sync_enabled',  auto_sync_enabled,
    'last_auto_sync_at',  last_auto_sync_at,
    'last_auto_sync_ok',  last_auto_sync_ok,
    'last_auto_sync_note',last_auto_sync_note,
    'sync_errors',        sync_errors,
    'first_seen_at',      first_seen_at,
    'last_seen_at',       last_seen_at,
    'last_remote_addr',   last_remote_addr
  ) ORDER BY last_seen_at DESC), '[]'::jsonb)
  FROM peers
  WHERE NOT p_only_autosync OR auto_sync_enabled = TRUE;
$$;

-- ---------------------------------------------------------------------------
-- peer_record_sync(pubkey, ok, note) — Cron-Loop schreibt Ergebnis
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION peer_record_sync(
  p_pubkey BYTEA,
  p_ok     BOOLEAN,
  p_note   TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE peers SET
    last_auto_sync_at   = NOW(),
    last_auto_sync_ok   = p_ok,
    last_auto_sync_note = p_note,
    sync_errors         = CASE WHEN p_ok THEN 0 ELSE sync_errors + 1 END
  WHERE pubkey = p_pubkey;
  RETURN jsonb_build_object('pubkey_hex', encode(p_pubkey, 'hex'), 'ok', p_ok);
END;
$$;

-- ---------------------------------------------------------------------------
-- federation_audit_cleanup(p_older_than_days) — löscht/archiviert alte Einträge
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION federation_audit_cleanup(p_older_than_days INT DEFAULT 90)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_imp_deleted INT;
  v_exp_deleted INT;
BEGIN
  DELETE FROM federation_imports WHERE imported_at < NOW() - (p_older_than_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_imp_deleted = ROW_COUNT;
  DELETE FROM federation_exports WHERE exported_at < NOW() - (p_older_than_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_exp_deleted = ROW_COUNT;
  RETURN jsonb_build_object(
    'older_than_days', p_older_than_days,
    'imports_deleted', v_imp_deleted,
    'exports_deleted', v_exp_deleted
  );
END;
$$;

GRANT EXECUTE ON FUNCTION peer_upsert(BYTEA, TEXT, TEXT, INTEGER, BOOLEAN)        TO anon, service_role;
GRANT EXECUTE ON FUNCTION peers_list(BOOLEAN)                                     TO anon, service_role;
GRANT EXECUTE ON FUNCTION peer_record_sync(BYTEA, BOOLEAN, TEXT)                  TO anon, service_role;
GRANT EXECUTE ON FUNCTION federation_audit_cleanup(INT)                           TO anon, service_role;

-- federation_audit_cleanup deletes from federation_imports/exports. The API
-- roles only have INSERT+SELECT on those tables (by design — no direct deletes
-- via PostgREST). SECURITY DEFINER lets the cron loop prune old entries via RPC.
ALTER FUNCTION federation_audit_cleanup(INT) SECURITY DEFINER;
ALTER FUNCTION federation_audit_cleanup(INT) OWNER TO postgres;
