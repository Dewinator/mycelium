-- Nightly cognitive maintenance — pg_cron schedule (optional).
--
-- The pgvector/pgvector docker image does NOT bundle pg_cron, so this migration
-- is intentionally a no-op there. The same maintenance is run from the host via
-- scripts/maintenance.sh (call it from launchd, cron, or the watchdog).
--
-- If you switch to a postgres image that ships pg_cron (e.g. supabase/postgres),
-- this block will activate automatically and schedule the jobs in-database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available — skipping in-DB schedule. Use scripts/maintenance.sh instead.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- Drop any prior schedules so re-running this migration is idempotent.
  PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('vectormemory_consolidate', 'vectormemory_forget_weak', 'vectormemory_dedup');

  PERFORM cron.schedule(
    'vectormemory_consolidate',
    '0 3 * * *',
    $sql$SELECT consolidate_memories(3, 1);$sql$
  );

  PERFORM cron.schedule(
    'vectormemory_forget_weak',
    '30 3 * * 0',
    $sql$SELECT forget_weak_memories(0.05, 7);$sql$
  );

  PERFORM cron.schedule(
    'vectormemory_dedup',
    '15 3 * * 0',
    $sql$SELECT dedup_similar_memories(0.93);$sql$
  );

  RAISE NOTICE 'pg_cron schedules installed: consolidate, forget_weak, dedup.';
END $$;
