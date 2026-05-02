import { Ollama } from "ollama";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  lookupExpectedChecksum,
  verifyGgufChecksum,
} from "./llama-gguf-checksum.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
}

/**
 * For inputs longer than the embedding model's context window, Ollama silently
 * truncates from the END — the embedding then only represents the first ~2048
 * tokens. That degrades semantic recall for long memories. Instead, sample
 * head + middle + tail so the embedding reflects the *whole* document.
 *
 * Char budgets are conservative under nomic-embed-text's 2048-token limit
 * (≈4 chars/token in mixed German/English). Total budget ~6000 chars; we
 * spend 3000 on the head (where the gist usually lives), 1500 on a middle
 * window, and 1500 on the tail. The full text is still stored verbatim in
 * the DB — only the embedding input is sampled.
 */
export function sampleForEmbedding(text: string, budget = 6000): string {
  if (text.length <= budget) return text;
  const headLen = Math.floor(budget * 0.5);   // 3000
  const midLen  = Math.floor(budget * 0.25);  // 1500
  const tailLen = budget - headLen - midLen;  // 1500
  const head = text.slice(0, headLen);
  const midStart = Math.max(headLen, Math.floor(text.length / 2) - Math.floor(midLen / 2));
  const middle = text.slice(midStart, midStart + midLen);
  const tail = text.slice(-tailLen);
  return `${head}\n[...]\n${middle}\n[...]\n${tail}`;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private client: Ollama;
  private model: string;
  readonly dimensions: number;
  private readonly charBudget: number;

  constructor(
    url: string = "http://localhost:11434",
    model: string = "nomic-embed-text",
    dimensions: number = 768,
    charBudget: number = 6000
  ) {
    this.client = new Ollama({ host: url });
    this.model = model;
    this.dimensions = dimensions;
    this.charBudget = charBudget;
  }

  async embed(text: string): Promise<number[]> {
    const sampled = sampleForEmbedding(text, this.charBudget);
    if (sampled.length < text.length) {
      console.error(
        `Embedding input sampled: ${text.length} → ${sampled.length} chars (head+middle+tail)`
      );
    }
    const response = await this.client.embed({
      model: this.model,
      input: sampled,
    });
    return response.embeddings[0];
  }
}

/**
 * In-process embedding provider backed by node-llama-cpp + a GGUF model.
 *
 * Spike #178 (PR #182, docs/native-llm-spike.md) validated this as a
 * drop-in replacement for the external Ollama daemon. Same `embed()`
 * contract, same 768d output for `nomic-embed-text-v1.5`, ~1.27× slower
 * but no second daemon required — the centerpiece of the native
 * standalone-app track (#176, Welle 1).
 *
 * Selected by setting `MYCELIUM_LLM_PROVIDER=llama-cpp`. Ollama remains
 * the default until cross-path embedding parity is verified end-to-end
 * (see "Tokenizer warning" in the spike doc — switching the default on
 * an existing install would invalidate stored vectors).
 *
 * `node-llama-cpp` is dynamically imported on first `embed()` call so
 * the native binding is not loaded for installs that stay on Ollama.
 *
 * Concurrency: PGlite-style serializer. The embedding context processes
 * one request at a time; queueing avoids contention and keeps a failed
 * embed from poisoning subsequent calls.
 */
export interface LlamaCppEmbeddingProviderOptions {
  modelsDir?: string;
  modelUri?: string;
  dimensions?: number;
  charBudget?: number;
  /**
   * Override / supply the expected SHA-256 of the model GGUF.
   * If absent, falls back to the built-in `KNOWN_GGUF_CHECKSUMS` manifest.
   * If neither resolves a hash, integrity check is skipped with a warning.
   */
  expectedSha256?: string | null;
}

const DEFAULT_LLAMA_EMBEDDING_MODEL_URI =
  "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q5_K_M.gguf";

export function defaultLlamaModelsDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "mycelium",
      "models"
    );
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "mycelium", "models");
  }
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "mycelium", "models");
}

export class LlamaCppEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly modelsDir: string;
  private readonly modelUri: string;
  private readonly charBudget: number;
  private readonly expectedSha256: string | null;
  private ready: Promise<{
    ctx: { getEmbeddingFor: (text: string) => Promise<{ vector: number[] }> };
    dispose: () => Promise<void>;
  }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: LlamaCppEmbeddingProviderOptions = {}) {
    this.modelsDir = opts.modelsDir ?? defaultLlamaModelsDir();
    this.modelUri = opts.modelUri ?? DEFAULT_LLAMA_EMBEDDING_MODEL_URI;
    this.dimensions = opts.dimensions ?? 768;
    this.charBudget = opts.charBudget ?? 6000;
    this.expectedSha256 = opts.expectedSha256 ?? null;
  }

  private async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Dynamic import keeps the native binding off the cold-start path
      // for installs that stay on Ollama. Use a runtime-computed specifier
      // so TypeScript does not require node-llama-cpp's type defs to be
      // resolvable in every consumer build.
      const specifier = "node-llama-cpp";
      let llamaCpp: any;
      try {
        llamaCpp = await import(specifier);
      } catch (err) {
        throw new Error(
          `LlamaCppEmbeddingProvider: failed to load 'node-llama-cpp'. ` +
            `Install it (npm i node-llama-cpp) or switch back to ` +
            `MYCELIUM_LLM_PROVIDER=ollama. Underlying: ${
              (err as Error).message ?? err
            }`
        );
      }
      const { getLlama, LlamaLogLevel, resolveModelFile } = llamaCpp;

      await mkdir(this.modelsDir, { recursive: true });
      const llama = await getLlama({ logLevel: LlamaLogLevel.warn });
      const modelPath = await resolveModelFile(this.modelUri, this.modelsDir);

      // Pillar 6 — verify the GGUF matches a known SHA-256 before loading.
      // Mismatch deletes the file and throws; the next run re-downloads.
      const expected = lookupExpectedChecksum(this.modelUri, this.expectedSha256);
      if (expected !== null) {
        await verifyGgufChecksum(modelPath, expected);
      } else {
        console.error(
          `LlamaCppEmbeddingProvider: no SHA-256 manifest entry for ` +
            `'${this.modelUri}' and no override supplied — skipping ` +
            `integrity check (Pillar 6). Set ` +
            `MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256 to enable verification ` +
            `for custom models.`
        );
      }

      const model = await llama.loadModel({ modelPath });
      if (model.embeddingVectorSize !== this.dimensions) {
        await model.dispose();
        await llama.dispose();
        throw new Error(
          `LlamaCppEmbeddingProvider: model embedding dim ` +
            `${model.embeddingVectorSize} != configured ${this.dimensions}. ` +
            `Adjust EMBEDDING_DIMENSIONS or pick a different GGUF.`
        );
      }
      const ctx = await model.createEmbeddingContext();
      return {
        ctx,
        dispose: async () => {
          await ctx.dispose();
          await model.dispose();
          await llama.dispose();
        },
      };
    })();
    return this.ready;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async embed(text: string): Promise<number[]> {
    const sampled = sampleForEmbedding(text, this.charBudget);
    if (sampled.length < text.length) {
      console.error(
        `Embedding input sampled: ${text.length} → ${sampled.length} chars (head+middle+tail)`
      );
    }
    const { ctx } = await this.init();
    return this.enqueue(async () => {
      const result = await ctx.getEmbeddingFor(sampled);
      return Array.from(result.vector);
    });
  }

  async dispose(): Promise<void> {
    if (!this.ready) return;
    const handle = await this.ready.catch(() => null);
    this.ready = null;
    if (handle) await handle.dispose();
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const provider = (process.env.MYCELIUM_LLM_PROVIDER ?? "ollama")
    .toLowerCase()
    .trim();
  const dimensions = parseInt(
    process.env.EMBEDDING_DIMENSIONS ?? "768",
    10
  );
  const charBudget = parseInt(process.env.EMBEDDING_CHAR_BUDGET ?? "6000", 10);

  if (provider === "llama-cpp" || provider === "llamacpp") {
    return new LlamaCppEmbeddingProvider({
      modelsDir: process.env.MYCELIUM_LLAMA_MODELS_DIR,
      modelUri: process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_URI,
      dimensions,
      charBudget,
      expectedSha256: process.env.MYCELIUM_LLAMA_EMBEDDING_MODEL_SHA256,
    });
  }

  if (provider !== "ollama") {
    throw new Error(
      `Unknown MYCELIUM_LLM_PROVIDER='${provider}'. ` +
        `Expected 'ollama' or 'llama-cpp'.`
    );
  }

  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
  return new OllamaEmbeddingProvider(url, model, dimensions, charBudget);
}
