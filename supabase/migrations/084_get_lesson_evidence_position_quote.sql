-- 084_get_lesson_evidence_position_quote.sql — fix issue #135.
--
-- Migration 077 declared `get_lesson_evidence(p_lesson_id UUID)` with
-- `RETURNS TABLE (position INT, hashed_experience_id TEXT)`. PostgreSQL 16
-- rejects the unquoted column name `position` in the RETURNS TABLE
-- parameter slot — `position` is a reserved keyword there because it
-- collides with the built-in `position(string IN string)` function. Result:
-- 077 aborts at line 212 on a fresh PG16 install, every statement before
-- it stays committed (autocommit, since 077 has no explicit
-- BEGIN/COMMIT), and `get_lesson_evidence` — the read-side helper the
-- §4.6 inclusion-proof endpoint depends on — never gets created.
--
-- Fix: re-create the function with the column quoted ("position"). The
-- function body is unchanged — `position` as an unqualified identifier
-- inside a SELECT is only ambiguous in the RETURNS TABLE parameter slot,
-- not in the body.
--
-- Idempotency: CREATE OR REPLACE FUNCTION is idempotent at SQL level.
-- Running this on a DB that already has the broken-or-hand-patched
-- function safely overwrites it with the canonical quoted form. Running
-- it on a DB where 077 fully aborted (and thus no get_lesson_evidence
-- exists) creates it from scratch.
--
-- Why a new migration and not an in-place edit of 077: 071-082 are
-- treated as immutable history (see issue #134 same discipline). Fix
-- forward with a new slot — anyone whose 077 application failed picks
-- this up on the next migrate.sh run.
--
-- Out of scope: a CI step that runs every new migration against a clean
-- PG16 container before merge. That would have caught this class of bug
-- at PR time. Tracked as a follow-up in #135's "Process follow-up"
-- section, not done here.

CREATE OR REPLACE FUNCTION get_lesson_evidence(p_lesson_id UUID)
RETURNS TABLE ("position" INT, hashed_experience_id TEXT)
LANGUAGE sql STABLE
AS $$
  SELECT position, hashed_experience_id
  FROM lesson_evidence_origin
  WHERE lesson_id = p_lesson_id
  ORDER BY position ASC;
$$;

GRANT EXECUTE ON FUNCTION get_lesson_evidence(UUID) TO anon, service_role;

NOTIFY pgrst, 'reload schema';
