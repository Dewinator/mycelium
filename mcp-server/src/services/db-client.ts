// One-stop boot for the database client services in src/services/ depend on.
//
// Two backends share the same PostgREST surface (`.from(table).select|insert|
// update|delete().eq|in|or|order|limit().single|maybeSingle()` plus
// `.rpc(name, args)` returning `{ data, error }`):
//
//   - `PostgrestClient` from @supabase/postgrest-js — Docker / hosted mode,
//     hits the PostgREST endpoint at SUPABASE_URL.
//   - `PGliteAdapter`  from src/native/pglite.ts        — native mode,
//     speaks the same chain shape directly to an in-process PGlite WASM
//     Postgres. The adapter contract tests (pglite-adapter.test.ts) gate
//     the surface so it stays drop-in compatible.
//
// Why this lives separate from src/index.ts:
//   The next native-app PR migrates ~30 service constructors away from
//   `(supabaseUrl, supabaseKey)` and onto a shared `DbClient` instance.
//   Keeping the factory here means each migrated service imports a single
//   stable type and the env-flag plumbing is exercised by a small unit
//   test, not the MCP server boot smoke test.
//
// Selection: MYCELIUM_USE_PGLITE=1 picks the native adapter; anything else
// (unset, "0", "false", any other value) keeps PostgREST.

import { PostgrestClient } from "@supabase/postgrest-js";

import type { PGliteAdapter } from "../native/pglite.js";

export type DbClient = PostgrestClient | PGliteAdapter;
export type DbClientMode = "pglite" | "postgrest";

export interface DbBootOptions {
  supabaseUrl: string;
  supabaseKey: string;
  /**
   * Pass-through to createNativeDb() when MYCELIUM_USE_PGLITE=1. Tests use
   * `skipMigrations: true` to keep the adapter wakeup under a second; the
   * 79-migration walk is exercised separately in pglite-migration-walk.test.ts.
   */
  pglite?: {
    dataDir?: string;
    migrationsDir?: string;
    skipMigrations?: boolean;
  };
}

export interface DbBootResult {
  client: DbClient;
  mode: DbClientMode;
  /** Tear down any owned resources (PGlite handle, etc). No-op in PostgREST mode. */
  close(): Promise<void>;
}

/**
 * MYCELIUM_USE_PGLITE=1 routes through the in-process PGlite adapter; any
 * other value keeps the PostgREST client pointed at SUPABASE_URL. Returns a
 * `close()` so callers can tear the native handle down on shutdown.
 */
export async function createDbClient(opts: DbBootOptions): Promise<DbBootResult> {
  if (process.env.MYCELIUM_USE_PGLITE === "1") {
    const { createNativeDb } = await import("../native/factory.js");
    const db = await createNativeDb(opts.pglite ?? {});
    return {
      client: db.adapter,
      mode: "pglite",
      close: () => db.close(),
    };
  }

  const client = new PostgrestClient(opts.supabaseUrl, {
    headers: opts.supabaseKey
      ? { Authorization: `Bearer ${opts.supabaseKey}`, apikey: opts.supabaseKey }
      : {},
  });
  return {
    client,
    mode: "postgrest",
    close: async () => {
      // PostgrestClient holds no sockets of its own — fetch handles those
      // per-request — so there is nothing to release.
    },
  };
}
