// Tests for src/native/docker-migration.ts — pure-TS Docker → PGlite
// migration helpers (sub-task 7 of #176, anchored in
// `docs/native-migration-spike.md`).
//
// Scope:
//   - Dump-stripper handles the three psql directives the spike calls out
//     and leaves legitimate SQL alone (including SQL whose string literals
//     happen to contain the directive token).
//   - End-to-end: a small synthetic dump (mimics the shape of
//     `pg_dump --inserts` for a `memories` table including a `vector(768)`
//     column serialised as plain text) restores cleanly into a fresh
//     PGlite, with the `\restrict` / `\unrestrict` book-ending the file.
//   - countTables guards against table-name injection and returns 0 for
//     empty tables, real counts for populated ones.
//   - verifyMigration reports row-equality across maps + flags missing
//     target tables as mismatches.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import {
  applyDumpToPGlite,
  countTables,
  stripPsqlDirectives,
  verifyMigration,
} from "../../native/docker-migration.js";

test("stripPsqlDirectives drops \\restrict, \\unrestrict, \\connect", () => {
  const dump = [
    "\\restrict urvWDAaJQC0aOAd20lx8m8dYHE93lFhlxad4WUvmEG0WfauNt5Cu2A88d1d8lmH",
    "\\connect vectormemory",
    "CREATE TABLE foo (id INT);",
    "INSERT INTO foo VALUES (1);",
    "\\unrestrict urvWDAaJQC0aOAd20lx8m8dYHE93lFhlxad4WUvmEG0WfauNt5Cu2A88d1d8lmH",
  ].join("\n");

  const out = stripPsqlDirectives(dump);

  assert.equal(out.includes("\\restrict"), false);
  assert.equal(out.includes("\\unrestrict"), false);
  assert.equal(out.includes("\\connect"), false);
  assert.equal(out.includes("CREATE TABLE foo"), true);
  assert.equal(out.includes("INSERT INTO foo"), true);
});

test("stripPsqlDirectives preserves SQL whose literals look like directives", () => {
  // Conservative: only lines *starting with* the directive are dropped.
  // A SQL value containing the directive token is preserved.
  const dump = [
    "\\restrict abc",
    "INSERT INTO notes VALUES ('please \\restrict me later');",
    "INSERT INTO notes VALUES ('mention \\connect in a comment');",
  ].join("\n");

  const out = stripPsqlDirectives(dump);
  assert.equal(out.includes("\\restrict abc"), false, "leading directive must be stripped");
  assert.equal(
    out.includes("'please \\restrict me later'"),
    true,
    "literal containing directive token must survive",
  );
  assert.equal(
    out.includes("'mention \\connect in a comment'"),
    true,
    "literal containing directive token must survive",
  );
});

test("stripPsqlDirectives is idempotent", () => {
  const dump = "\\restrict tok\nSELECT 1;\n\\unrestrict tok\n";
  const once = stripPsqlDirectives(dump);
  const twice = stripPsqlDirectives(once);
  assert.equal(once, twice);
});

test("applyDumpToPGlite restores a synthetic dump (schema + INSERTs + vector column) into fresh PGlite", async () => {
  const pg = await PGlite.create({ extensions: { vector } });

  // Synthetic dump mimicking pg_dump --inserts shape for the `memories` table.
  // Uses a 4-dim vector for readability — pgvector's plain-text format is
  // dimension-agnostic, so this exercises the same restore path the 768-dim
  // production dump uses (per spike §1).
  const synthetic = [
    "\\restrict synthetic-test-token",
    "",
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "",
    "CREATE TABLE public.memories (",
    "  id UUID PRIMARY KEY,",
    "  content TEXT NOT NULL,",
    "  category TEXT NOT NULL DEFAULT 'general',",
    "  tags TEXT[] DEFAULT '{}',",
    "  embedding vector(4)",
    ");",
    "",
    "INSERT INTO public.memories VALUES",
    "  ('11111111-1111-1111-1111-111111111111', 'first memory', 'decisions', '{architecture,vector-memory}', '[0.1,0.2,0.3,0.4]'),",
    "  ('22222222-2222-2222-2222-222222222222', 'second memory', 'general', '{}', '[0.5,0.6,0.7,0.8]'),",
    "  ('33333333-3333-3333-3333-333333333333', 'third memory', 'people', '{family}', '[0.9,0.0,0.1,0.2]');",
    "",
    "\\unrestrict synthetic-test-token",
  ].join("\n");

  try {
    const result = await applyDumpToPGlite(pg, synthetic);
    assert.ok(result.bytes > 0, "expected non-empty stripped dump");
    assert.ok(result.durationMs >= 0, "duration should be non-negative");

    // Row count survives.
    const count = await pg.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM public.memories",
    );
    assert.equal(count.rows[0]?.c, 3);

    // Vector column round-tripped (values readable + dimensionality preserved).
    const vec = await pg.query<{ embedding: string }>(
      "SELECT embedding::text AS embedding FROM public.memories WHERE id = '11111111-1111-1111-1111-111111111111'",
    );
    assert.equal(vec.rows[0]?.embedding, "[0.1,0.2,0.3,0.4]");

    // TEXT[] column round-tripped.
    const tags = await pg.query<{ tags: string[] }>(
      "SELECT tags FROM public.memories WHERE id = '11111111-1111-1111-1111-111111111111'",
    );
    assert.deepEqual(tags.rows[0]?.tags, ["architecture", "vector-memory"]);
  } finally {
    await pg.close();
  }
});

test("countTables returns row counts for each named table", async () => {
  const pg = await PGlite.create();
  try {
    await pg.exec("CREATE TABLE alpha (id INT); CREATE TABLE beta (id INT);");
    await pg.exec("INSERT INTO alpha VALUES (1), (2), (3);");
    // beta intentionally left empty.

    const counts = await countTables(pg, ["alpha", "beta"]);
    assert.deepEqual(counts, { alpha: 3, beta: 0 });
  } finally {
    await pg.close();
  }
});

test("countTables rejects table names that aren't plain identifiers", async () => {
  const pg = await PGlite.create();
  try {
    await assert.rejects(
      () => countTables(pg, ['memories"; DROP TABLE x; --']),
      /invalid table name/,
    );
    await assert.rejects(() => countTables(pg, ["1leading_digit"]), /invalid table name/);
    await assert.rejects(() => countTables(pg, ["with-dash"]), /invalid table name/);
    await assert.rejects(() => countTables(pg, [""]), /invalid table name/);
  } finally {
    await pg.close();
  }
});

test("verifyMigration: equal counts → ok=true", () => {
  const r = verifyMigration(
    { memories: 3, experiences: 7 },
    { memories: 3, experiences: 7 },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.mismatches, []);
});

test("verifyMigration: count drift on one table reported, others OK", () => {
  const r = verifyMigration(
    { memories: 949, experiences: 298 },
    { memories: 948, experiences: 298 },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, [{ table: "memories", source: 949, target: 948 }]);
});

test("verifyMigration: missing target table reported as 0 vs source", () => {
  const r = verifyMigration({ memories: 3, lessons: 5 }, { memories: 3 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, [{ table: "lessons", source: 5, target: 0 }]);
});

test("verifyMigration: extra target tables ignored (PGlite metadata is allowed)", () => {
  const r = verifyMigration({ memories: 3 }, { memories: 3, _migrations: 79 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mismatches, []);
});
