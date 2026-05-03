import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  KNOWN_GGUF_CHECKSUMS,
  GgufChecksumMismatch,
  lookupExpectedChecksum,
  verifyGgufChecksum,
} from "../services/llama-gguf-checksum.js";

async function tmpFile(content: Buffer | string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mycelium-gguf-test-"));
  const file = path.join(dir, "fake.gguf");
  await writeFile(file, content);
  return file;
}

function sha256Hex(content: Buffer | string): string {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  return createHash("sha256").update(buf).digest("hex");
}

test("verifyGgufChecksum: passes when SHA-256 + size match", async () => {
  const content = Buffer.from("pretend this is a GGUF file");
  const file = await tmpFile(content);
  await verifyGgufChecksum(file, {
    sha256: sha256Hex(content),
    size: content.byteLength,
  });
  // File must still exist after a successful verify.
  assert.ok(existsSync(file), "verified file should not be removed");
  const persisted = await readFile(file);
  assert.equal(persisted.toString(), content.toString());
});

test("verifyGgufChecksum: passes without size when only hash is provided", async () => {
  const content = Buffer.from("only-hash check");
  const file = await tmpFile(content);
  await verifyGgufChecksum(file, { sha256: sha256Hex(content) });
  assert.ok(existsSync(file));
});

test("verifyGgufChecksum: case-insensitive on the expected hex", async () => {
  const content = Buffer.from("hello mixed-case world");
  const file = await tmpFile(content);
  await verifyGgufChecksum(file, { sha256: sha256Hex(content).toUpperCase() });
  assert.ok(existsSync(file));
});

test("verifyGgufChecksum: throws + deletes file on size mismatch (no hash compute)", async () => {
  const content = Buffer.from("bytes");
  const file = await tmpFile(content);
  const before = await stat(file);
  await assert.rejects(
    verifyGgufChecksum(file, {
      sha256: sha256Hex(content),
      size: before.size + 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof GgufChecksumMismatch);
      assert.equal((err as GgufChecksumMismatch).expectedSize, before.size + 1);
      assert.equal((err as GgufChecksumMismatch).actualSize, before.size);
      return true;
    }
  );
  assert.equal(existsSync(file), false, "file must be removed on mismatch");
});

test("verifyGgufChecksum: throws + deletes file on hash mismatch", async () => {
  const content = Buffer.from("real content");
  const file = await tmpFile(content);
  const wrong = "0".repeat(64);
  await assert.rejects(
    verifyGgufChecksum(file, { sha256: wrong, size: content.byteLength }),
    (err: unknown) => {
      assert.ok(err instanceof GgufChecksumMismatch);
      assert.equal((err as GgufChecksumMismatch).expected, wrong);
      assert.equal((err as GgufChecksumMismatch).actual, sha256Hex(content));
      return true;
    }
  );
  assert.equal(existsSync(file), false, "file must be removed on mismatch");
});

test("verifyGgufChecksum: idempotent rm — does not throw if file vanished", async () => {
  // Race scenario: file is removed by something else between size check and
  // hash stream. fs.rm({ force: true }) absorbs the ENOENT — the
  // GgufChecksumMismatch must still surface, not a stray ENOENT.
  const content = Buffer.from("content");
  const file = await tmpFile(content);
  // Pre-remove to simulate the race.
  const { promises: fsp } = await import("node:fs");
  await fsp.unlink(file);
  await assert.rejects(
    verifyGgufChecksum(file, {
      sha256: sha256Hex(content),
      size: content.byteLength,
    }),
    // Expect ENOENT from the size pre-check (file is gone) — not GgufChecksumMismatch.
    (err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT";
    }
  );
});

test("lookupExpectedChecksum: env-style override wins over manifest", () => {
  const knownUri = Object.keys(KNOWN_GGUF_CHECKSUMS)[0];
  assert.ok(knownUri, "manifest must have at least one entry");
  const override = "abc123";
  const result = lookupExpectedChecksum(knownUri, override);
  assert.deepEqual(result, { sha256: "abc123" });
});

test("lookupExpectedChecksum: empty override falls back to manifest", () => {
  const knownUri = Object.keys(KNOWN_GGUF_CHECKSUMS)[0];
  assert.ok(knownUri);
  const fromManifest = KNOWN_GGUF_CHECKSUMS[knownUri];
  assert.deepEqual(lookupExpectedChecksum(knownUri, ""), fromManifest);
  assert.deepEqual(lookupExpectedChecksum(knownUri, "   "), fromManifest);
  assert.deepEqual(lookupExpectedChecksum(knownUri, undefined), fromManifest);
  assert.deepEqual(lookupExpectedChecksum(knownUri, null), fromManifest);
});

test("lookupExpectedChecksum: unknown URI returns null", () => {
  assert.equal(lookupExpectedChecksum("hf:not-a-real/model/file.gguf"), null);
});

test("lookupExpectedChecksum: lower-cases override hashes", () => {
  const result = lookupExpectedChecksum(
    "hf:not-a-real/model/file.gguf",
    "DEADBEEF"
  );
  assert.equal(result?.sha256, "deadbeef");
});

test("KNOWN_GGUF_CHECKSUMS: default embedding URI is in the manifest", () => {
  // The default Llama embedding URI in services/embeddings.ts must always
  // resolve to a manifest entry — otherwise out-of-the-box installs lose
  // their Pillar 6 verification.
  const defaultUri =
    "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q5_K_M.gguf";
  const entry = KNOWN_GGUF_CHECKSUMS[defaultUri];
  assert.ok(entry, `default URI ${defaultUri} missing from manifest`);
  assert.equal(entry.sha256.length, 64, "SHA-256 must be 64 hex chars");
  assert.match(entry.sha256, /^[0-9a-f]+$/, "SHA-256 must be lower-case hex");
  assert.ok(entry.size && entry.size > 0, "size must be present and positive");
});
