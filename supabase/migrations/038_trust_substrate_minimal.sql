-- 038_trust_substrate_minimal.sql — fresh-install fix for issue #180
--
-- Problem (found by spike #179 against PGlite):
--   active migration 040_signed_revocations.sql does
--     ALTER TABLE revoked_keys ADD COLUMN ...
--   but `revoked_keys` (and `trust_roots`) are CREATEd only in
--   `supabase/migrations.deferred/038_federation_trust.sql`. A fresh install
--   running the active sequence end-to-end never gets those tables, and 040
--   dies on `relation "revoked_keys" does not exist`.
--
--   039_host_identity.sql also queries both tables inside `peer_seen()`. The
--   function body survives migration time because PL/pgSQL lazy-resolves
--   identifiers, but the call would fail at runtime against the same gap.
--
-- Fix (option C from the issue):
--   Park the *minimum* substrate (just the two tables + their indexes +
--   GRANTs) in an active migration, so 040 has something to ALTER and 039's
--   peer_seen() can actually be called. The full federation surface — RPCs
--   trust_add / trust_revoke / trust_list / trust_check / federation_log_*
--   — stays in deferred 038, gated behind whatever turns Federation on.
--
-- Idempotency:
--   The deferred 038 file already uses CREATE TABLE IF NOT EXISTS for both
--   tables and CREATE INDEX IF NOT EXISTS for their indexes, so a node that
--   later opts into Federation by running deferred migrations gets a no-op
--   here. Schemas are kept *byte-for-byte identical* to deferred 038 so the
--   two paths can never diverge.

CREATE TABLE IF NOT EXISTS trust_roots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('host','genome','group')),
  identifier    TEXT NOT NULL,
  pubkey        BYTEA NOT NULL,
  label         TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  UNIQUE (pubkey)
);

CREATE INDEX IF NOT EXISTS trust_roots_kind_idx       ON trust_roots (kind, status);
CREATE INDEX IF NOT EXISTS trust_roots_identifier_idx ON trust_roots (identifier);

CREATE TABLE IF NOT EXISTS revoked_keys (
  pubkey        BYTEA PRIMARY KEY,
  reason        TEXT NOT NULL,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by    TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS revoked_keys_revoked_at_idx ON revoked_keys (revoked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON trust_roots   TO anon, service_role;
GRANT SELECT, INSERT, UPDATE          ON revoked_keys TO anon, service_role;
