// Migration runner for the PGlite native backend.
//
// The Docker path applies migrations via `scripts/migrate.sh` (psql against
// the supabase container). With PGlite there is no psql; we walk the same
// `supabase/migrations/*.sql` directory and apply each file via the in-process
// PGlite handle. The applied set is tracked in a small bookkeeping table so
// re-launches skip migrations that already ran on this data dir.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_TABLE = "mycelium_pglite_migrations";

export interface MigrationOutcome {
  file: string;
  ok: boolean;
  ms: number;
  error?: string;
  skipped?: boolean;
}

export interface MigrationReport {
  total: number;
  applied: number;
  skipped: number;
  outcomes: MigrationOutcome[];
}

async function ensureBookkeeping(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function alreadyApplied(pg: PGlite, file: string): Promise<boolean> {
  const r = await pg.query(
    `SELECT 1 AS hit FROM ${MIGRATIONS_TABLE} WHERE filename = $1`,
    [file],
  );
  return (r as unknown as { rows: unknown[] }).rows.length > 0;
}

async function recordApplied(pg: PGlite, file: string): Promise<void> {
  await pg.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)
     ON CONFLICT (filename) DO NOTHING`,
    [file],
  );
}

/**
 * Apply every `.sql` migration under `migrationsDir` against `pg`.
 * Re-running is idempotent: already-applied files are skipped, not replayed.
 *
 * Throws on the first failing migration so the caller (factory.ts during
 * server bootstrap) can bail out before MCP tools start serving.
 */
export async function applyMigrations(
  pg: PGlite,
  migrationsDir: string,
): Promise<MigrationReport> {
  await ensureBookkeeping(pg);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const outcomes: MigrationOutcome[] = [];
  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    if (await alreadyApplied(pg, file)) {
      outcomes.push({ file, ok: true, ms: 0, skipped: true });
      skipped++;
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const t = Date.now();
    try {
      await pg.exec(sql);
      await recordApplied(pg, file);
      outcomes.push({ file, ok: true, ms: Date.now() - t });
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ file, ok: false, ms: Date.now() - t, error: msg });
      throw new Error(`migration ${file} failed: ${msg}`);
    }
  }

  return { total: files.length, applied, skipped, outcomes };
}
