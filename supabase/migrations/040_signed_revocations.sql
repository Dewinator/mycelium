-- 040_signed_revocations.sql — Phase 3d: authentizierbare Revocations
--
-- Bisher: trust_revoke() vertraut dem, der lokal den RPC aufruft. Gut für
-- lokale Revokes, reicht aber nicht für Federation — wir dürfen Peer-
-- gelieferte Revocations nicht blind akzeptieren.
--
-- Jetzt: jede Revocation trägt (optional) eine Ed25519-Signatur über einen
-- kanonischen Payload. Akzeptiert werden:
--   (a) Self-Revoke — signer_pubkey == revoked_pubkey.
--   (b) Third-Party-Revoke — signer_pubkey ist ein aktiver Trust-Root
--       mit kind IN ('genome','group'). (Host-Trust-Roots dürfen nur
--       andere Host-Pubkeys widerrufen — das modellieren wir noch nicht.)
--
-- Die TS-seitige Verify-Pipeline prüft die Kette. Die DB-Seite hier speichert
-- nur Roh-Material und liefert effizientes Bulk-List für Sync.

ALTER TABLE revoked_keys
  ADD COLUMN IF NOT EXISTS signature      BYTEA,    -- Ed25519 (64 byte)
  ADD COLUMN IF NOT EXISTS signer_pubkey  BYTEA,    -- 32 byte; who signed this
  ADD COLUMN IF NOT EXISTS signed_payload JSONB,    -- canonical JSON that was signed
  ADD COLUMN IF NOT EXISTS sync_source    TEXT;     -- 'local' | 'peer:<host>'

-- ---------------------------------------------------------------------------
-- revocations_list_signed(p_only_signed) — für Federation-Sync (GET /federation/revocations).
-- Liefert Hex-Strings; TS-Seite baut die Buffers zurück.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION revocations_list_signed(p_only_signed BOOLEAN DEFAULT TRUE)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'revoked_pubkey_hex', encode(pubkey,       'hex'),
    'signer_pubkey_hex',  encode(signer_pubkey,'hex'),
    'signature_hex',      encode(signature,    'hex'),
    'signed_payload',     signed_payload,
    'reason',             reason,
    'revoked_at',         revoked_at,
    'revoked_by',         revoked_by,
    'sync_source',        sync_source
  ) ORDER BY revoked_at DESC), '[]'::jsonb)
  FROM revoked_keys
  WHERE NOT p_only_signed OR signature IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------
-- revocation_upsert_signed — INSERT oder UPDATE mit Signatur + Payload.
-- Authority-Check findet in TS statt (muss Signatur cryptografisch prüfen).
-- Diese RPC vertraut dem Aufrufer, dass die Signatur schon verifiziert wurde.
-- Idempotent: pubkey ist PK, upsert updated signature+payload wenn neuer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION revocation_upsert_signed(
  p_revoked_pubkey  BYTEA,
  p_signer_pubkey   BYTEA,
  p_signature       BYTEA,
  p_signed_payload  JSONB,
  p_reason          TEXT,
  p_revoked_by      TEXT DEFAULT NULL,
  p_sync_source     TEXT DEFAULT 'local'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_row revoked_keys%ROWTYPE;
BEGIN
  IF length(p_revoked_pubkey) <> 32 OR length(p_signer_pubkey) <> 32 OR length(p_signature) <> 64 THEN
    RAISE EXCEPTION 'bad lengths: revoked=%, signer=%, sig=%',
      length(p_revoked_pubkey), length(p_signer_pubkey), length(p_signature);
  END IF;
  -- Mark trust_roots (if any) as revoked.
  UPDATE trust_roots SET status = 'revoked' WHERE pubkey = p_revoked_pubkey;
  INSERT INTO revoked_keys (pubkey, reason, revoked_by, evidence, signature, signer_pubkey, signed_payload, sync_source)
  VALUES (p_revoked_pubkey, p_reason, p_revoked_by, '{}'::jsonb,
          p_signature, p_signer_pubkey, p_signed_payload, p_sync_source)
  ON CONFLICT (pubkey) DO UPDATE SET
    reason         = EXCLUDED.reason,
    revoked_at     = NOW(),
    revoked_by     = COALESCE(EXCLUDED.revoked_by, revoked_keys.revoked_by),
    signature      = EXCLUDED.signature,
    signer_pubkey  = EXCLUDED.signer_pubkey,
    signed_payload = EXCLUDED.signed_payload,
    sync_source    = EXCLUDED.sync_source
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'pubkey_hex', encode(v_row.pubkey, 'hex'),
    'signer_pubkey_hex', encode(v_row.signer_pubkey, 'hex'),
    'reason', v_row.reason,
    'sync_source', v_row.sync_source,
    'revoked_at', v_row.revoked_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION revocations_list_signed(BOOLEAN)                       TO anon, service_role;
GRANT EXECUTE ON FUNCTION revocation_upsert_signed(BYTEA, BYTEA, BYTEA, JSONB, TEXT, TEXT, TEXT) TO anon, service_role;
