// Boot-factory tests for services/db-client.ts. This is the foundation the
// upcoming service refactor (each `(supabaseUrl, supabaseKey)` constructor
// migrating to a shared `DbClient` instance) will lean on, so the env-flag
// behaviour is pinned here before any service starts depending on it.
//
// Adapter contract is tested separately (pglite-adapter.test.ts walks every
// query verb shape against a real PGlite instance); these tests only assert
// the boot path returns the right backend kind and a usable handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { PostgrestClient } from "@supabase/postgrest-js";

import { createDbClient } from "../services/db-client.js";
import { PGliteAdapter } from "../native/pglite.js";

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await run();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("createDbClient: PostgREST mode (default — env unset)", async () => {
  await withEnv({ MYCELIUM_USE_PGLITE: undefined }, async () => {
    const boot = await createDbClient({
      supabaseUrl: "http://localhost:54321",
      supabaseKey: "test-key",
    });
    try {
      assert.equal(boot.mode, "postgrest");
      assert.ok(boot.client instanceof PostgrestClient);
    } finally {
      await boot.close();
    }
  });
});

test("createDbClient: PostgREST mode is selected for any non-1 value", async () => {
  for (const value of ["0", "false", "true", "yes", ""]) {
    await withEnv({ MYCELIUM_USE_PGLITE: value }, async () => {
      const boot = await createDbClient({
        supabaseUrl: "http://localhost:54321",
        supabaseKey: "",
      });
      try {
        assert.equal(boot.mode, "postgrest", `value=${JSON.stringify(value)} should not select pglite`);
      } finally {
        await boot.close();
      }
    });
  }
});

test("createDbClient: PGlite mode boots an adapter with usable .from()", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-db-client-test-"));
  await withEnv(
    {
      MYCELIUM_USE_PGLITE: "1",
      MYCELIUM_DATA_DIR: tmp,
    },
    async () => {
      const boot = await createDbClient({
        supabaseUrl: "ignored-when-pglite",
        supabaseKey: "ignored-when-pglite",
        pglite: { skipMigrations: true },
      });
      try {
        assert.equal(boot.mode, "pglite");
        assert.ok(boot.client instanceof PGliteAdapter);

        // Smoke: adapter responds to a trivial query through the chain.
        // No migrations were applied, so we touch a temporary table to
        // prove .from() / .insert() / .select() round-trip.
        const adapter = boot.client as PGliteAdapter;
        await adapter.raw().exec(`
          CREATE TABLE db_client_smoke (id INT PRIMARY KEY, label TEXT)
        `);
        const ins = await adapter
          .from("db_client_smoke")
          .insert({ id: 1, label: "ok" })
          .select()
          .single();
        assert.equal(ins.error, null);
        assert.equal((ins.data as { label: string }).label, "ok");
      } finally {
        await boot.close();
      }
    },
  );
  await fs.rm(tmp, { recursive: true, force: true });
});

test("createDbClient: close() in PGlite mode releases the underlying handle", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mycelium-db-client-test-"));
  await withEnv(
    {
      MYCELIUM_USE_PGLITE: "1",
      MYCELIUM_DATA_DIR: tmp,
    },
    async () => {
      const boot = await createDbClient({
        supabaseUrl: "x",
        supabaseKey: "y",
        pglite: { skipMigrations: true },
      });
      const adapter = boot.client as PGliteAdapter;
      await boot.close();
      // After close, the underlying PGlite handle reports closed.
      assert.equal(adapter.raw().closed, true);
    },
  );
  await fs.rm(tmp, { recursive: true, force: true });
});
