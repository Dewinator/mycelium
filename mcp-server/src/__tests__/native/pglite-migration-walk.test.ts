// Regression test: walk every supabase/migrations/*.sql file against an
// in-memory PGlite. Pins the PR #194 spike claim ("all 79 migrations green
// on PG 17.5 + pgvector 0.8.1") as a permanent CI gate so a future migration
// that uses a Postgres-only feature PGlite can't honour breaks the build
// instead of breaking the native-app boot path silently.
//
// Adapter-shape tests live in pglite-adapter.test.ts. This file is purely
// about the migration corpus + the migration-runner contract (idempotency,
// counters, ordering).

import { test } from "node:test";
import assert from "node:assert/strict";
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

import { applyMigrations } from "../../native/migration-runner.js";
import { PGliteAdapter } from "../../native/pglite.js";

// Resolve from the mcp-server package root (cwd when `npm test` runs).
const MIGRATIONS_DIR = path.resolve(process.cwd(), "..", "supabase", "migrations");

async function freshPglite(): Promise<PGlite> {
  return PGlite.create({
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
}

test("migration-walk: every supabase/migrations/*.sql applies cleanly to PGlite", async () => {
  const pg = await freshPglite();
  try {
    const report = await applyMigrations(pg, MIGRATIONS_DIR);

    // Every file walked, every file applied, none skipped on first run.
    assert.ok(report.total > 0, "expected at least one migration file");
    assert.equal(
      report.applied,
      report.total,
      `expected all ${report.total} migrations to apply; got ${report.applied} applied + ${report.skipped} skipped. ` +
        `First failure (if any): ${report.outcomes.find((o) => !o.ok)?.file ?? "n/a"}`,
    );
    assert.equal(report.skipped, 0, "no files should be marked skipped on a fresh data dir");

    // Every outcome flagged ok=true (the runner throws on first failure, so
    // reaching here implies this — but assert it explicitly so the contract
    // is visible in the test name on failure).
    for (const o of report.outcomes) {
      assert.ok(o.ok, `migration ${o.file} reported ok=false: ${o.error ?? "(no error message)"}`);
    }

    // Outcomes preserve lexicographic order — the runner sorts before walking,
    // and the bookkeeping table relies on that order so a partial run can be
    // resumed deterministically.
    const fileOrder = report.outcomes.map((o) => o.file);
    const sorted = [...fileOrder].sort();
    assert.deepEqual(fileOrder, sorted, "outcomes must mirror lexicographic file order");
  } finally {
    await pg.close();
  }
});

test("migration-walk: re-running applyMigrations is idempotent (all skipped)", async () => {
  const pg = await freshPglite();
  try {
    const first = await applyMigrations(pg, MIGRATIONS_DIR);
    assert.equal(first.applied, first.total);

    const second = await applyMigrations(pg, MIGRATIONS_DIR);
    assert.equal(
      second.skipped,
      second.total,
      "second run on the same handle should mark every file skipped",
    );
    assert.equal(second.applied, 0, "no migration should re-apply on a primed bookkeeping table");
  } finally {
    await pg.close();
  }
});

test("migration-walk: post-migration adapter can call scalar/vector-arg RPCs without erroring", async () => {
  // Smoke-check that the SQL functions MemoryService and friends rely on
  // actually exist + resolve through the adapter after migrations. Scope
  // is intentionally limited to RPCs whose parameters are scalars, nulls,
  // and numeric-array (vector) — these are the shapes the adapter has
  // unambiguous casts for. UUID[] / TEXT[] parameter RPCs (touch_memories,
  // coactivate_memories, spread_activation, …) require the env-switch
  // sub-task to also resolve the type-inference gap (see #184 follow-up).
  const pg = await freshPglite();
  try {
    await applyMigrations(pg, MIGRATIONS_DIR);
    const adapter = new PGliteAdapter(pg);

    // match_memories_cognitive — 768-dim zero vector, empty result expected.
    const zeroVec = new Array<number>(768).fill(0);
    const search = await adapter.rpc("match_memories_cognitive", {
      query_embedding: zeroVec,
      query_text: "",
      match_count: 1,
      filter_category: null,
      vector_weight: 0.6,
      include_archived: false,
      p_project_id: null,
      p_include_pinned_global: true,
    });
    assert.equal(search.error, null, `match_memories_cognitive errored: ${search.error?.message ?? ""}`);

    // dedup_similar_memories on empty DB — scalar params only.
    const dedup = await adapter.rpc("dedup_similar_memories", {
      similarity_threshold: 0.93,
      max_passes: 1,
    });
    assert.equal(dedup.error, null, `dedup_similar_memories errored: ${dedup.error?.message ?? ""}`);

    // forget_weak_memories — scalar params only.
    const forget = await adapter.rpc("forget_weak_memories", {
      strength_threshold: 0.05,
      min_age_days: 7,
    });
    assert.equal(forget.error, null, `forget_weak_memories errored: ${forget.error?.message ?? ""}`);

    // consolidate_memories — scalar params only.
    const consolidate = await adapter.rpc("consolidate_memories", {
      min_access_count: 3,
      min_age_days: 1,
    });
    assert.equal(
      consolidate.error,
      null,
      `consolidate_memories errored: ${consolidate.error?.message ?? ""}`,
    );
  } finally {
    await pg.close();
  }
});

test("migration-walk: documents the adapter's empty-array → jsonb cast (production callers must pre-guard)", async () => {
  // Pinned regression: serializeValue() in src/native/pglite.ts deliberately
  // routes empty arrays through `::jsonb` because TEXT[] vs JSONB ambiguity
  // for `[]` is unresolvable without column metadata. Every consumer of an
  // RPC that takes a TEXT[]/UUID[] parameter MUST guard `arr.length > 0`
  // before calling, or the call will fail with "function … does not exist"
  // (jsonb signature mismatch). MemoryService.touch / .coactivate / .spread
  // already do; this test pins the contract so a future "helpful" attempt
  // to make empty-array calls work will surface this assumption.
  const pg = await freshPglite();
  try {
    await applyMigrations(pg, MIGRATIONS_DIR);
    const adapter = new PGliteAdapter(pg);

    const touch = await adapter.rpc("touch_memories", { memory_ids: [] as string[] });
    assert.notEqual(touch.error, null, "empty-array call must error (jsonb cast mismatch)");
    assert.match(
      touch.error?.message ?? "",
      /jsonb|does not exist/i,
      "error must reflect the jsonb-vs-text[] signature mismatch so the failure mode is debuggable",
    );
  } finally {
    await pg.close();
  }
});
