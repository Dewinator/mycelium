// Factory for the PGlite native backend.
//
// Wires together the WASM Postgres instance, the eight contrib extensions our
// migrations depend on, the migration runner and the adapter into one call:
//
//   const db = await createNativeDb({ dataDir });
//   // db is shape-compatible with @supabase/postgrest-js's PostgrestClient
//   // for the surface the services in src/services/ use.

import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { tablefunc } from "@electric-sql/pglite/contrib/tablefunc";

import { PGliteAdapter } from "./pglite.js";
import { applyMigrations, type MigrationReport } from "./migration-runner.js";
import { getDataDirLayout, ensureDataDirs } from "./data-dir.js";

export interface NativeDbOptions {
  /** Data directory; defaults to OS-conventional app-data path. */
  dataDir?: string;
  /** Migrations directory; defaults to repo's supabase/migrations. */
  migrationsDir?: string;
  /** Skip applying migrations (tests sometimes want a bare instance). */
  skipMigrations?: boolean;
}

export interface NativeDb {
  adapter: PGliteAdapter;
  raw: PGlite;
  dataDir: string;
  migrationReport: MigrationReport | null;
  close(): Promise<void>;
}

/**
 * Default PGlite data dir — delegates to the unified layout in data-dir.ts so
 * the Node-side path and the Tauri shell land on the same files. Honours
 * `MYCELIUM_DATA_DIR` (root) and the legacy `MYCELIUM_PGLITE_DATA_DIR`
 * (subpath override) — see data-dir.ts for precedence.
 */
export function defaultDataDir(): string {
  return getDataDirLayout().pgData;
}

export async function createNativeDb(opts: NativeDbOptions = {}): Promise<NativeDb> {
  // Materialise pgdata/ + models/ + wire-cert/ before PGlite touches the
  // filesystem. Wire-cert/ stays empty here — Wave-2/3 populates it.
  await ensureDataDirs();
  const dataDir = opts.dataDir ?? defaultDataDir();

  const pg = await PGlite.create({
    dataDir,
    extensions: {
      vector,
      pg_trgm,
      pgcrypto,
      uuid_ossp,
      btree_gin,
      btree_gist,
      citext,
      hstore,
      tablefunc,
    },
  });

  let migrationReport: MigrationReport | null = null;
  if (!opts.skipMigrations) {
    const migrationsDir =
      opts.migrationsDir ??
      path.resolve(process.cwd(), "..", "supabase", "migrations");
    migrationReport = await applyMigrations(pg, migrationsDir);
  }

  const adapter = new PGliteAdapter(pg);

  return {
    adapter,
    raw: pg,
    dataDir,
    migrationReport,
    async close() {
      await pg.close();
    },
  };
}
