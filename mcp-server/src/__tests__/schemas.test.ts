import { test } from "node:test";
import assert from "node:assert/strict";
import { rememberSchema } from "../tools/remember.js";
import { recallSchema } from "../tools/recall.js";
import { forgetSchema } from "../tools/forget.js";
import { updateSchema } from "../tools/update.js";
import { listSchema } from "../tools/list.js";
import { importSchema } from "../tools/import.js";

test("rememberSchema applies defaults", () => {
  const parsed = rememberSchema.parse({ content: "hello" });
  assert.equal(parsed.category, "general");
  assert.deepEqual(parsed.tags, []);
});

test("rememberSchema rejects invalid category", () => {
  assert.throws(() =>
    rememberSchema.parse({ content: "x", category: "bogus" })
  );
});

test("recallSchema defaults limit and vector_weight", () => {
  const parsed = recallSchema.parse({ query: "find me" });
  assert.equal(parsed.limit, 10);
  assert.equal(parsed.vector_weight, 0.7);
});

test("recallSchema rejects vector_weight out of range", () => {
  assert.throws(() => recallSchema.parse({ query: "x", vector_weight: 1.5 }));
  assert.throws(() => recallSchema.parse({ query: "x", vector_weight: -0.1 }));
});

const UUID = "11111111-2222-3333-4444-555555555555";

test("forgetSchema requires a valid UUID", () => {
  assert.throws(() => forgetSchema.parse({}));
  assert.throws(() => forgetSchema.parse({ id: "not-a-uuid" }));
  const parsed = forgetSchema.parse({ id: UUID });
  assert.equal(parsed.id, UUID);
});

test("updateSchema accepts partial updates", () => {
  const parsed = updateSchema.parse({ id: UUID, content: "new" });
  assert.equal(parsed.content, "new");
  assert.equal(parsed.category, undefined);
});

test("listSchema defaults limit", () => {
  const parsed = listSchema.parse({});
  assert.equal(parsed.limit, 20);
});

test("importSchema requires directory and defaults dry_run false", () => {
  assert.throws(() => importSchema.parse({}));
  const parsed = importSchema.parse({ directory: "/tmp/foo" });
  assert.equal(parsed.directory, "/tmp/foo");
  assert.equal(parsed.dry_run, false);
});
