import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LlamaCppEmbeddingProvider,
  createEmbeddingProvider,
  defaultLlamaModelsDir,
  parseBoolEnv,
} from "../services/embeddings.js";

test("LlamaCppEmbeddingProvider exposes default 768d (matches schema)", () => {
  const p = new LlamaCppEmbeddingProvider();
  assert.equal(p.dimensions, 768);
});

test("LlamaCppEmbeddingProvider honours explicit dimensions option", () => {
  const p = new LlamaCppEmbeddingProvider({ dimensions: 1024 });
  assert.equal(p.dimensions, 1024);
});

test("defaultLlamaModelsDir returns an OS-appropriate absolute path", () => {
  const dir = defaultLlamaModelsDir();
  assert.ok(dir.length > 0);
  assert.ok(dir.endsWith("models"), `expected …/models, got ${dir}`);
});

test("createEmbeddingProvider returns Llama provider when MYCELIUM_LLM_PROVIDER=llama-cpp", () => {
  const prev = process.env.MYCELIUM_LLM_PROVIDER;
  process.env.MYCELIUM_LLM_PROVIDER = "llama-cpp";
  try {
    const p = createEmbeddingProvider();
    assert.ok(p instanceof LlamaCppEmbeddingProvider);
    assert.equal(p.dimensions, 768);
  } finally {
    if (prev === undefined) delete process.env.MYCELIUM_LLM_PROVIDER;
    else process.env.MYCELIUM_LLM_PROVIDER = prev;
  }
});

test("createEmbeddingProvider accepts the 'llamacpp' alias", () => {
  const prev = process.env.MYCELIUM_LLM_PROVIDER;
  process.env.MYCELIUM_LLM_PROVIDER = "llamacpp";
  try {
    const p = createEmbeddingProvider();
    assert.ok(p instanceof LlamaCppEmbeddingProvider);
  } finally {
    if (prev === undefined) delete process.env.MYCELIUM_LLM_PROVIDER;
    else process.env.MYCELIUM_LLM_PROVIDER = prev;
  }
});

test("createEmbeddingProvider defaults to Ollama when env unset", () => {
  const prev = process.env.MYCELIUM_LLM_PROVIDER;
  delete process.env.MYCELIUM_LLM_PROVIDER;
  try {
    const p = createEmbeddingProvider();
    assert.ok(!(p instanceof LlamaCppEmbeddingProvider));
  } finally {
    if (prev !== undefined) process.env.MYCELIUM_LLM_PROVIDER = prev;
  }
});

test("createEmbeddingProvider rejects unknown provider names", () => {
  const prev = process.env.MYCELIUM_LLM_PROVIDER;
  process.env.MYCELIUM_LLM_PROVIDER = "openai";
  try {
    assert.throws(() => createEmbeddingProvider(), /Unknown MYCELIUM_LLM_PROVIDER/);
  } finally {
    if (prev === undefined) delete process.env.MYCELIUM_LLM_PROVIDER;
    else process.env.MYCELIUM_LLM_PROVIDER = prev;
  }
});

test("parseBoolEnv: recognises canonical truthy spellings, ignores noise", () => {
  for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "  on  "]) {
    assert.equal(parseBoolEnv(v), true, `expected truthy for ${JSON.stringify(v)}`);
  }
  for (const v of [undefined, "", "0", "false", "no", "off", "anything-else"]) {
    assert.equal(parseBoolEnv(v), false, `expected falsy for ${JSON.stringify(v)}`);
  }
});

test("createEmbeddingProvider: MYCELIUM_LLAMA_REQUIRE_CHECKSUM=1 enables fail-closed mode", async () => {
  const prevProvider = process.env.MYCELIUM_LLM_PROVIDER;
  const prevRequire  = process.env.MYCELIUM_LLAMA_REQUIRE_CHECKSUM;
  const prevUri      = process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_URI;
  const prevHash     = process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256;
  process.env.MYCELIUM_LLM_PROVIDER = "llama-cpp";
  process.env.MYCELIUM_LLAMA_REQUIRE_CHECKSUM = "1";
  // Point at a URI that is NOT in the manifest, with no override hash, so
  // init() must refuse rather than warn-and-skip.
  process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_URI =
    "hf:not-real/no-such-repo/no-such-file.gguf";
  delete process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256;
  try {
    const p = createEmbeddingProvider();
    assert.ok(p instanceof LlamaCppEmbeddingProvider);
    // We never load the model — init() throws before resolveModelFile().
    // The error must mention REQUIRE_CHECKSUM so the operator can correlate.
    await assert.rejects(
      () => p.embed("smoke"),
      (err: unknown) => /MYCELIUM_LLAMA_REQUIRE_CHECKSUM/.test((err as Error).message)
    );
  } finally {
    if (prevProvider === undefined) delete process.env.MYCELIUM_LLM_PROVIDER;
    else process.env.MYCELIUM_LLM_PROVIDER = prevProvider;
    if (prevRequire === undefined) delete process.env.MYCELIUM_LLAMA_REQUIRE_CHECKSUM;
    else process.env.MYCELIUM_LLAMA_REQUIRE_CHECKSUM = prevRequire;
    if (prevUri === undefined) delete process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_URI;
    else process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_URI = prevUri;
    if (prevHash !== undefined) process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256 = prevHash;
  }
});

// End-to-end test gated on env: downloads the GGUF (~84 MB) on first run,
// then runs three embeds to verify dimensions, queue serialization, and
// reuse of the cached embedding context. Skipped in CI by default — flip
// MYCELIUM_TEST_LLAMA_CPP=1 to exercise locally.
test(
  "LlamaCppEmbeddingProvider produces 768d vectors against a real GGUF",
  { skip: process.env.MYCELIUM_TEST_LLAMA_CPP !== "1" },
  async () => {
    const provider = new LlamaCppEmbeddingProvider();
    try {
      const a = await provider.embed("Reed bevorzugt deutsche Antworten.");
      assert.equal(a.length, 768);
      assert.ok(a.some((x) => x !== 0), "embedding should not be all-zero");
      // Queued back-to-back calls must both resolve.
      const [b, c] = await Promise.all([
        provider.embed("Pillar 1 — decentralised, networked AI."),
        provider.embed("Memory IDs are UUIDs."),
      ]);
      assert.equal(b.length, 768);
      assert.equal(c.length, 768);
    } finally {
      await provider.dispose();
    }
  }
);
