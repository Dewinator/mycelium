/**
 * GGUF integrity verification for the in-process llama-cpp provider.
 *
 * Why this exists (Pillar 6 — cyber security): models are downloaded over
 * HTTPS from Hugging Face on first run. TLS authenticates the connection,
 * but does not protect against an upstream replacement of the model file.
 * A swapped GGUF could embed adversarial vectors that drift `recall()` in
 * subtle ways. SHA-256 verification with a hard-coded manifest of known
 * good hashes raises the bar to "compromise both Hugging Face *and* this
 * repo" — the same bar npm package-lock integrity hashes, Homebrew
 * bottles, and Linux distro signed packages set.
 *
 * Design:
 *   - Manifest of known URI → checksum lives in this file. Keys are the
 *     exact `hf:` URIs node-llama-cpp's `resolveModelFile` accepts.
 *   - Source for the hashes is each repo's HF Hub LFS metadata (the LFS
 *     oid IS the file's SHA-256). Adding a new entry is a 3-line PR.
 *   - Users can override / supply a hash for a custom URI via env
 *     (`MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256`).
 *   - Unknown URI without override: we WARN and skip rather than fail
 *     closed, so power users running custom GGUFs are not locked out.
 *     Default model URIs always resolve via the manifest, so the
 *     happy-path install gets verification for free.
 *   - Mismatch deletes the file (so the next run re-downloads cleanly)
 *     and throws — partial / corrupt GGUFs are not left lying around.
 */

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";

export interface GgufChecksum {
  /** Hex-encoded SHA-256 of the file. Lower-case, no prefix. */
  sha256: string;
  /** Expected size in bytes. Cheap pre-check before the hash stream. */
  size?: number;
}

/**
 * Manifest of known-good checksums. Source: HF Hub LFS metadata
 * (`https://huggingface.co/api/models/<repo>/tree/main`). The LFS oid
 * field IS the SHA-256 of the LFS-pointed file.
 *
 * Captured 2026-05-02 for `nomic-ai/nomic-embed-text-v1.5-GGUF`.
 */
export const KNOWN_GGUF_CHECKSUMS: Record<string, GgufChecksum> = {
  "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q5_K_M.gguf": {
    sha256: "0c7930f6c4f6f29b7da5046e3a2c0832aa3f602db3de5760a95f0582dbd3d6e6",
    size: 99588928,
  },
};

export class GgufChecksumMismatch extends Error {
  readonly filePath:     string;
  readonly expected:     string;
  readonly actual:       string;
  readonly expectedSize: number | undefined;
  readonly actualSize:   number | undefined;

  constructor(opts: {
    filePath:      string;
    expected:      string;
    actual:        string;
    expectedSize?: number;
    actualSize?:   number;
  }) {
    const sizeNote =
      opts.expectedSize !== undefined && opts.actualSize !== undefined
        ? ` (size: expected ${opts.expectedSize} B, got ${opts.actualSize} B)`
        : "";
    super(
      `GGUF integrity check failed for ${opts.filePath}${sizeNote}: ` +
        `expected SHA-256 ${opts.expected}, got ${opts.actual}. ` +
        `File removed; re-running will re-download. If you trust the new ` +
        `upstream, update KNOWN_GGUF_CHECKSUMS or set ` +
        `MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256 to the new hash.`
    );
    this.name = "GgufChecksumMismatch";
    this.filePath     = opts.filePath;
    this.expected     = opts.expected;
    this.actual       = opts.actual;
    this.expectedSize = opts.expectedSize;
    this.actualSize   = opts.actualSize;
  }
}

/**
 * Stream the file at `filePath` and compare its SHA-256 (and size if
 * provided) against `expected`. On mismatch: removes the file with
 * `force: true` (idempotent — safe if the file vanished mid-check) and
 * throws `GgufChecksumMismatch`.
 *
 * Streams chunk-by-chunk — a 100 MB GGUF never lives in RAM as one
 * buffer. Resolves only after the stream's `end` event.
 */
export async function verifyGgufChecksum(
  filePath: string,
  expected: GgufChecksum
): Promise<void> {
  const expectedHex = expected.sha256.toLowerCase();

  if (expected.size !== undefined) {
    const stat = await fs.stat(filePath);
    if (stat.size !== expected.size) {
      const actualSize = stat.size;
      await fs.rm(filePath, { force: true });
      throw new GgufChecksumMismatch({
        filePath,
        expected: expectedHex,
        actual: "(size mismatch — not hashed)",
        expectedSize: expected.size,
        actualSize,
      });
    }
  }

  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const actual = hash.digest("hex");

  if (actual !== expectedHex) {
    await fs.rm(filePath, { force: true });
    throw new GgufChecksumMismatch({
      filePath,
      expected: expectedHex,
      actual,
    });
  }
}

/**
 * Resolve the expected checksum for a model URI.
 *
 * Lookup order:
 *   1. Explicit `override` (env-supplied hash for custom URIs).
 *   2. Built-in `KNOWN_GGUF_CHECKSUMS` manifest.
 *   3. `null` — caller decides whether to fail closed or warn and skip.
 */
export function lookupExpectedChecksum(
  modelUri: string,
  override?: string | null | undefined
): GgufChecksum | null {
  if (override !== undefined && override !== null && override.trim() !== "") {
    return { sha256: override.trim().toLowerCase() };
  }
  return KNOWN_GGUF_CHECKSUMS[modelUri] ?? null;
}
