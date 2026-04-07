import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OllamaEmbeddingProvider,
  createEmbeddingProvider,
} from "../services/embeddings.js";

test("OllamaEmbeddingProvider exposes default dimensions", () => {
  const p = new OllamaEmbeddingProvider();
  assert.equal(p.dimensions, 768);
});

test("OllamaEmbeddingProvider honors custom dimensions", () => {
  const p = new OllamaEmbeddingProvider("http://localhost:11434", "custom", 1024);
  assert.equal(p.dimensions, 1024);
});

test("createEmbeddingProvider reads EMBEDDING_DIMENSIONS env", () => {
  const prev = process.env.EMBEDDING_DIMENSIONS;
  process.env.EMBEDDING_DIMENSIONS = "512";
  try {
    const p = createEmbeddingProvider();
    assert.equal(p.dimensions, 512);
  } finally {
    if (prev === undefined) delete process.env.EMBEDDING_DIMENSIONS;
    else process.env.EMBEDDING_DIMENSIONS = prev;
  }
});
