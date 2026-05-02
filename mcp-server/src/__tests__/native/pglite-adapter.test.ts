// Adapter contract tests — exercise every verb shape MemoryService and the
// other services in src/services/ actually use, against a real PGlite
// instance (in-memory data dir). If a chain ever drifts from the
// PostgrestClient shape these tests will fail before MemoryService does.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { PGliteAdapter } from "../../native/pglite.js";

async function freshAdapter(): Promise<{ adapter: PGliteAdapter; pg: PGlite }> {
  // dataDir omitted → PGlite stays in-memory, perfect for unit tests.
  const pg = await PGlite.create({ extensions: { vector } });
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS adapter_test (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tag  TEXT,
      n    INT  DEFAULT 0,
      meta JSONB DEFAULT '{}'::jsonb
    )
  `);
  return { adapter: new PGliteAdapter(pg), pg };
}

test("adapter: insert + select with eq returns inserted row", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    const ins = await adapter
      .from("adapter_test")
      .insert({ name: "alpha", tag: "x", n: 1 })
      .select()
      .single();
    assert.equal(ins.error, null);
    assert.equal((ins.data as { name: string }).name, "alpha");

    const sel = await adapter
      .from("adapter_test")
      .select("name, n")
      .eq("name", "alpha")
      .single();
    assert.equal(sel.error, null);
    assert.deepEqual(sel.data, { name: "alpha", n: 1 });
  } finally {
    await pg.close();
  }
});

test("adapter: bulk insert + order + limit returns ordered subset", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert([
      { name: "a", n: 3 },
      { name: "b", n: 1 },
      { name: "c", n: 2 },
    ]);
    const r = await adapter
      .from("adapter_test")
      .select("name, n")
      .order("n", { ascending: true })
      .limit(2);
    assert.equal(r.error, null);
    const rows = r.data as Array<{ name: string; n: number }>;
    assert.deepEqual(rows.map((x) => x.name), ["b", "c"]);
  } finally {
    await pg.close();
  }
});

test("adapter: update + select + single returns updated row", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert({ name: "u", n: 0 });
    const upd = await adapter
      .from("adapter_test")
      .update({ n: 42 })
      .eq("name", "u")
      .select()
      .single();
    assert.equal(upd.error, null);
    assert.equal((upd.data as { n: number }).n, 42);
  } finally {
    await pg.close();
  }
});

test("adapter: delete + eq removes only matching rows", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert([
      { name: "keep" },
      { name: "drop" },
    ]);
    const del = await adapter.from("adapter_test").delete().eq("name", "drop");
    assert.equal(del.error, null);
    const r = await adapter.from("adapter_test").select("name");
    const rows = r.data as Array<{ name: string }>;
    assert.deepEqual(rows.map((x) => x.name), ["keep"]);
  } finally {
    await pg.close();
  }
});

test("adapter: in() filter matches any of provided values", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert([
      { name: "a" }, { name: "b" }, { name: "c" },
    ]);
    const r = await adapter
      .from("adapter_test")
      .select("name")
      .in("name", ["a", "c"])
      .order("name", { ascending: true });
    const rows = r.data as Array<{ name: string }>;
    assert.deepEqual(rows.map((x) => x.name), ["a", "c"]);
  } finally {
    await pg.close();
  }
});

test("adapter: in() with empty array returns no rows (not all rows)", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert({ name: "any" });
    const r = await adapter.from("adapter_test").select("name").in("name", []);
    assert.equal(r.error, null);
    assert.deepEqual(r.data, []);
  } finally {
    await pg.close();
  }
});

test("adapter: maybeSingle returns null on empty without error", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    const r = await adapter
      .from("adapter_test")
      .select("name")
      .eq("name", "ghost")
      .maybeSingle();
    assert.equal(r.error, null);
    assert.equal(r.data, null);
  } finally {
    await pg.close();
  }
});

test("adapter: single() on empty returns PGRST116 error", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    const r = await adapter
      .from("adapter_test")
      .select("name")
      .eq("name", "ghost")
      .single();
    assert.equal(r.data, null);
    assert.equal(r.error?.code, "PGRST116");
  } finally {
    await pg.close();
  }
});

test("adapter: neq + gte filters narrow result set", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert([
      { name: "x", n: 1 }, { name: "y", n: 5 }, { name: "z", n: 10 },
    ]);
    const r = await adapter
      .from("adapter_test")
      .select("name, n")
      .neq("name", "x")
      .gte("n", 6)
      .order("n", { ascending: true });
    const rows = r.data as Array<{ name: string; n: number }>;
    assert.deepEqual(rows, [{ name: "z", n: 10 }]);
  } finally {
    await pg.close();
  }
});

test("adapter: or() filter generates valid SQL", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert([
      { name: "a", n: -1 },
      { name: "b", n:  1, tag: "conflict" },
      { name: "c", n:  2, tag: "ok" },
    ]);
    const r = await adapter
      .from("adapter_test")
      .select("name, n, tag")
      .or("n.lt.0,tag.eq.conflict")
      .order("name", { ascending: true });
    const rows = r.data as Array<{ name: string }>;
    assert.deepEqual(rows.map((x) => x.name), ["a", "b"]);
  } finally {
    await pg.close();
  }
});

test("adapter: jsonb metadata round-trips through insert + select", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    const meta = { hits: 3, score: 0.7, query_length: 42 };
    await adapter.from("adapter_test").insert({ name: "m", meta });
    const r = await adapter
      .from("adapter_test")
      .select("meta")
      .eq("name", "m")
      .single();
    assert.equal(r.error, null);
    assert.deepEqual((r.data as { meta: typeof meta }).meta, meta);
  } finally {
    await pg.close();
  }
});

test("adapter: rpc() with named args calls a SQL function and unwraps scalar", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await pg.exec(`
      CREATE OR REPLACE FUNCTION add_two(a INT, b INT) RETURNS INT
      LANGUAGE SQL IMMUTABLE AS $$ SELECT a + b $$
    `);
    const r = await adapter.rpc<number>("add_two", { a: 3, b: 4 });
    assert.equal(r.error, null);
    assert.equal(r.data, 7);
  } finally {
    await pg.close();
  }
});

test("adapter: rpc() returning setof rows surfaces array", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await pg.exec(`
      CREATE OR REPLACE FUNCTION list_names() RETURNS TABLE(name TEXT)
      LANGUAGE SQL STABLE AS $$ SELECT name FROM adapter_test ORDER BY name $$
    `);
    await adapter.from("adapter_test").insert([{ name: "p" }, { name: "q" }]);
    const r = await adapter.rpc<Array<{ name: string }>>("list_names", {});
    assert.equal(r.error, null);
    const data = r.data!;
    assert.deepEqual(data.map((x) => x.name), ["p", "q"]);
  } finally {
    await pg.close();
  }
});

test("adapter: vector column accepts numeric array as embedding", async () => {
  const pg = await PGlite.create({ extensions: { vector } });
  try {
    await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pg.exec(`
      CREATE TABLE vec_test (
        id   SERIAL PRIMARY KEY,
        emb  VECTOR(3)
      )
    `);
    const adapter = new PGliteAdapter(pg);
    const ins = await adapter
      .from("vec_test")
      .insert({ emb: [0.1, 0.2, 0.3] })
      .select()
      .single();
    assert.equal(ins.error, null);
    const row = ins.data as { id: number; emb: unknown };
    assert.ok(row.id > 0);
    // PGlite returns vectors as the textual `[a,b,c]` form — exact equality
    // would couple the test to the WASM build, so we assert shape only.
    assert.ok(typeof row.emb === "string");
    assert.match(row.emb as string, /^\[/);
  } finally {
    await pg.close();
  }
});

test("adapter: queue serializes concurrent calls", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    const ops = await Promise.all([
      adapter.from("adapter_test").insert({ name: "p1" }),
      adapter.from("adapter_test").insert({ name: "p2" }),
      adapter.from("adapter_test").insert({ name: "p3" }),
    ]);
    for (const r of ops) assert.equal(r.error, null);
    const all = await adapter.from("adapter_test").select("name").order("name", { ascending: true });
    const rows = all.data as Array<{ name: string }>;
    assert.deepEqual(rows.map((x) => x.name), ["p1", "p2", "p3"]);
  } finally {
    await pg.close();
  }
});

test("adapter: query error after success leaves queue alive", async () => {
  const { adapter, pg } = await freshAdapter();
  try {
    await adapter.from("adapter_test").insert({ name: "ok" });
    // Trigger a SQL error (column does not exist).
    const bad = await adapter.from("adapter_test").select("nope");
    assert.notEqual(bad.error, null);
    // Subsequent legit query still works.
    const good = await adapter.from("adapter_test").select("name").single();
    assert.equal(good.error, null);
    assert.equal((good.data as { name: string }).name, "ok");
  } finally {
    await pg.close();
  }
});
