-- ============================================================================
-- Migration 063 — grant runtime roles INSERT/SELECT on agent_affect_history
-- ============================================================================
--
-- Phase-2 drift fix on top of migration 062. The history table was created
-- but its grants were forgotten. apply_compute_affect() runs from AFTER-INSERT
-- triggers on experiences and memory_events without SECURITY DEFINER, so it
-- executes as the calling role. With anon (the role the MCP server uses for
-- record_experience / remember / recall) it tried to INSERT into
-- agent_affect_history without permission and bubbled up
--
--   ERROR: permission denied for table agent_affect_history
--
-- which fails the originating INSERT (record_experience etc.). Until this
-- migration runs, every record_experience call from a non-superuser role
-- aborts.
--
-- Mirrors the grants migration 019 set on agent_affect (SELECT, UPDATE for
-- anon + service_role). For history we need INSERT (the apply_compute_affect
-- writer) and SELECT (any future dashboard reader). USAGE on the BIGSERIAL
-- sequence is required so anon can advance the id column.
-- ============================================================================

GRANT INSERT, SELECT ON agent_affect_history TO anon, service_role;
GRANT USAGE, SELECT ON SEQUENCE agent_affect_history_id_seq TO anon, service_role;

-- Sanity: confirm anon can now insert. We can't easily SET ROLE inside a
-- migration (psql connects as superuser), but we can at least assert the
-- privilege bit is present in the catalog.
DO $$
BEGIN
  IF NOT has_table_privilege('anon', 'agent_affect_history', 'INSERT') THEN
    RAISE EXCEPTION '063 sanity: anon still lacks INSERT on agent_affect_history';
  END IF;
  IF NOT has_sequence_privilege('anon', 'agent_affect_history_id_seq', 'USAGE') THEN
    RAISE EXCEPTION '063 sanity: anon still lacks USAGE on agent_affect_history_id_seq';
  END IF;
END$$;
