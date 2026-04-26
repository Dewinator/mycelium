import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveClientLabel } from "../services/client-identity.js";

test("derives label from clientInfo.name + host segment + pid", () => {
  const label = deriveClientLabel(
    { name: "claude-code", version: "1.2.3" },
    "Mac-mini-von-Reed.local",
    51188,
  );
  assert.equal(label, "claude-code-mac-mini-von-reed-51188");
});

test("uses unknown-client when name missing", () => {
  const label = deriveClientLabel(undefined, "host.local", 42);
  assert.equal(label, "unknown-client-host-42");
});

test("treats empty/whitespace name as unknown-client", () => {
  const label = deriveClientLabel({ name: "   " }, "host.local", 42);
  assert.equal(label, "unknown-client-host-42");
});

test("sanitizes punctuation and uppercase", () => {
  const label = deriveClientLabel(
    { name: "Cursor IDE / v2" },
    "MyHost",
    7,
  );
  assert.equal(label, "cursor-ide-v2-myhost-7");
});

test("respects max length while preserving host+pid suffix", () => {
  const longName = "a".repeat(200);
  const label = deriveClientLabel({ name: longName }, "host", 999);
  assert.ok(label.length <= 60, `expected ≤60 chars, got ${label.length}`);
  assert.ok(label.endsWith("-host-999"), `expected suffix preserved, got '${label}'`);
});

test("produces label that satisfies agents.label charset (lowercase, dashes, digits)", () => {
  const label = deriveClientLabel(
    { name: "Claude.Code" },
    "Mac-mini.local",
    100,
  );
  assert.match(label, /^[a-z0-9-]+$/);
});
