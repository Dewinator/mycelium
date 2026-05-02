# Spike 2 — node-llama-cpp as in-process LLM (issue #178)

**Status:** spike complete, **recommendation: pivot accepted, integrate behind a `MYCELIUM_LLM_PROVIDER` env switch.**

## Question the spike answers

Issue #178 asks: can a single in-process Node dependency replace the external Ollama daemon for both **embeddings** (`nomic-embed-text`) and **chat** (qwen-class)? If yes, the standalone-app initiative (#176) loses its second daemon dependency — only the embedded Postgres remains, and Spike 1 (#177 → PR #179) already showed PGlite handles that in-process.

## TL;DR

| | Ollama (current) | node-llama-cpp (spike) |
|---|---|---|
| Daemon | external, separate install | none, in-process |
| Embedding (nomic-embed-text-v1.5 Q5_K_M) | avg **21.5 ms** | avg **27.3 ms** (× 1.27) |
| Embedding dimension | 768 | 768 ✅ same schema |
| Chat (Qwen2.5-0.5B-Instruct Q5_K_M, Metal) | n/a in this run | **~16 tok/s** smoke-test |
| Cold-start (model download + load) | one-time, then daemon-resident | per-process, cached after first load |
| Install footprint | brew + ~1 GB models | npm dep (~52 MB) + same models |
| GPU acceleration | yes (Metal/CUDA via daemon) | yes (Metal verified, build=prebuilt) |

**Recommendation:** introduce `MYCELIUM_LLM_PROVIDER` (`ollama` | `llama-cpp`) without removing the Ollama path. The native build (Tauri shell, sub-task 5 of #176) defaults to `llama-cpp`; the Docker stack keeps `ollama` for production users who already have it. Both paths exercise the same `embed()` / `chat()` contracts, so service code stays unchanged.

## Reproducible

Throwaway-by-design under `experiments/native-llm/`:

```bash
cd experiments/native-llm
npm install                         # ~56 s, prebuilt binaries (no native compile)
node spike-probe.mjs                # ~150 ms — API + GPU detection only
node spike-embed.mjs                # downloads ~94 MB, runs 20-embed bench
node spike-chat.mjs                 # downloads ~492 MB, runs 1-prompt smoke
```

Reference reports (this hardware: M4 Mac, 16 GB unified memory, macOS):
- `experiments/native-llm/report-probe.json`
- `experiments/native-llm/report-llama-cpp-embed.json`
- `experiments/native-llm/report-llama-cpp-chat.json`

## Findings

### 1. API ergonomics: clean, single-import bridge

`node-llama-cpp` v3 ships a top-level `getLlama()` plus `LlamaChatSession` and `resolveModelFile`. The substitute for `OllamaEmbeddingProvider` is roughly:

```ts
import { getLlama, resolveModelFile } from "node-llama-cpp";

const llama = await getLlama();
const modelPath = await resolveModelFile(uri, modelsDir); // first-run download
const model   = await llama.loadModel({ modelPath });
const ctx     = await model.createEmbeddingContext();
const vector  = (await ctx.getEmbeddingFor(text)).vector;
```

Same shape for chat — `model.createContext()` + `LlamaChatSession({ contextSequence, systemPrompt })` + `session.prompt(user, opts)`. The existing `EmbeddingProvider` interface in `mcp-server/src/services/embeddings.ts` carries over verbatim; only the concrete class changes.

### 2. Embedding throughput: 1.27× slower than Ollama, schema-compatible

20 sequential embeddings of representative mycelium memory bodies (decisions, lessons, German + English mix):

```
llama.cpp avg 27.3 ms · p95 256.1 ms · 768d · rss 344 MB
ollama    avg 21.5 ms · p95  32.5 ms ·       (warm daemon)
```

The p95 spike on llama.cpp is the tokenisation+kernel cost on the longest sample (~600 chars). For mycelium write paths (single embedding per `remember()` call) the difference is invisible — humans don't perceive a 6 ms gap. For batched imports (`import_markdown`) we'd want to stream embeddings concurrently; the embedding context is single-shot today, so a small worker pool wrapper would close the gap.

Embedding **dimension is 768** (matches `VECTOR(768)` on `memories.embedding`). No migration required.

### 3. Tokenizer warning — must be validated end-to-end

`node-llama-cpp` emits a startup warning on the nomic-embed-text GGUF:

```
load: special_eos_id is not in special_eog_ids - the tokenizer config may be incorrect
Using this model to tokenize text and then detokenize it resulted in a different text.
```

This means: **embeddings produced by node-llama-cpp may diverge from those produced by Ollama for the same input**, because one path applies a slightly different tokenisation. We did not measure cross-path cosine similarity in this spike. Before flipping the default provider on existing installs, we must:

1. Generate the same input through both providers, compute cosine — if it's below ~0.95 we cannot mix providers in one DB.
2. If divergence is real, embedding regeneration becomes a one-shot migration when an install switches providers.

This is filed as a sub-task in the integration ticket recommendation below. For greenfield native-app installs (#176's primary target) it doesn't matter — the DB starts empty.

### 4. Chat path: the protocol works, model size determines quality

Smoke-tested with Qwen2.5-0.5B-Instruct (392 MB Q5_K_M) running a REM-synthesizer-style prompt:

```
chat OK · ~21 tok in 1273 ms · ~16.5 tok/s · rss 882 MB
```

Quality is poor — 0.5B can't follow the synthesis instruction; it echoed back the first cluster line. Expected: the model is in-spec for proving the **bridge**, not the **product**. To validate the production path, swap in a real model:

```bash
MYCELIUM_CHAT_MODEL_URI="hf:Qwen/Qwen2.5-7B-Instruct-GGUF/qwen2.5-7b-instruct-q4_k_m.gguf" \
  node spike-chat.mjs
```

Expected RSS for Qwen2.5-7B Q4: ~5 GB; on M-series unified memory this fits, but the standalone app must surface the warning before download. tok/s on Metal for 7B Q4 should land in the 20-40 range based on llama.cpp benchmarks — to be verified in the integration ticket.

### 5. Install footprint: drops the second daemon

| | Ollama path | node-llama-cpp path |
|---|---|---|
| External installer | `brew install ollama` | none |
| Daemon | `ollama serve` (~270 MB resident embedding model) | none, model lives in our process |
| Model files | `~/.ollama/models/` | OS app-data dir (`~/Library/Application Support/mycelium/models/` on macOS) |
| Update story | `ollama pull <model>` | `resolveModelFile()` re-checks Hugging Face metadata |

For the standalone-app vision (#176) this is the load-bearing win: a Tauri double-click installer cannot reasonably orchestrate Homebrew. Spike 1 collapsed Postgres+pgvector into a single npm dep; this spike collapses Ollama into a single npm dep. Two daemons → zero.

### 6. Build profile: prebuilt, Metal out of the box

```
gpu=metal · build=prebuilt · MTL EMBED_LIBRARY · NEON · ACCELERATE · LLAMAFILE
```

`npm install` pulled prebuilt binaries (no Xcode compile, no `cmake` step on this machine). For Windows/Linux the same package ships per-target prebuilds; sub-task 5 of #176 (per-platform GPU tuning) is where DirectML/CUDA/Vulkan tradeoffs get owned.

## Out of scope (deliberately)

- **Ollama removal.** Both providers stay; choice is per-install via env. Removing Ollama is a follow-up after a soak window on the native-app target.
- **REM model upgrade to Qwen3-8B.** REM today calls Ollama's `qwen3:8b`; switching the model is orthogonal to switching the runtime. Same recommendation applies (env switch, dual-track for one release).
- **Streaming UI.** Existing call sites consume full responses. Token streaming is a UX follow-up (`onTextChunk` already supported by `node-llama-cpp`).
- **Model checksums + signature verification.** Hugging Face URLs return SHA-256 in the response headers; `resolveModelFile` writes them to a sibling `.json`. Wiring that into a verification gate is a follow-up under Pillar 6 (cyber security).

## Suggested follow-up issues

1. **feat(embeddings): add `LlamaCppEmbeddingProvider` behind `MYCELIUM_LLM_PROVIDER`.** Keeps the existing `EmbeddingProvider` interface; default stays `ollama`. Includes a cosine-similarity cross-validation test that fails the build if the two providers' embeddings diverge by more than the agreed threshold for our test corpus.
2. **feat(chat): add `LlamaCppChatProvider` and route REM digest through it when `MYCELIUM_LLM_PROVIDER=llama-cpp`.** Same env switch.
3. **feat(install): native-app default profile selects `llama-cpp` automatically; surface model-download progress in the Tauri shell.** Depends on #176 sub-task 4 (Tauri shell).
4. **feat(security): verify Hugging Face SHA-256 on first model download; refuse to load on mismatch.** Pillar 6.

## Pillar check

- **Pillar 1 (decentralised AI)** — strengthened. Removing the daemon dependency moves the entire LLM stack into the user's own process; no separate service to misconfigure or compromise.
- **Pillar 6 (cyber security)** — neutral with required follow-up. Model files come from Hugging Face; we must add SHA-256 verification before flipping the default. The `node-llama-cpp` package itself is npm-distributed and audit-trackable like any other dep.

---

## Implementation 1 — `LlamaCppEmbeddingProvider` shipped

Follow-up issue #178 part 1 (PR pending). Lands the embedding side of the spike's recommendation as a real provider in `mcp-server/src/services/embeddings.ts`. Chat provider + REM-digest re-route stays a separate sub-task.

**Selection.** Set `MYCELIUM_LLM_PROVIDER=llama-cpp` (or alias `llamacpp`). Default remains `ollama` so no existing install changes behaviour. Unknown values throw at startup rather than silently falling back.

**Knobs.**
- `MYCELIUM_LLAMA_MODELS_DIR` — absolute path; defaults to OS app-data (`~/Library/Application Support/mycelium/models` on macOS, `%APPDATA%\mycelium\models` on Windows, `$XDG_DATA_HOME/mycelium/models` on Linux). Same convention as the PGlite data dir from #185 — both consumed by the future Tauri shell.
- `MYCELIUM_LLAMA_EMBEDDING_MODEL_URI` — Hugging Face URI for the GGUF; defaults to `hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q5_K_M.gguf` (the dim-768 variant the schema expects).
- `EMBEDDING_DIMENSIONS` — checked against the loaded model's `embeddingVectorSize`; mismatch throws with a clear message instead of silently producing the wrong-shaped vector.

**Lifecycle.** Lazy init: the first `embed()` call triggers model download (cached) and embedding-context creation. Subsequent calls reuse the same context. `dispose()` releases the runtime — long-lived MCP processes simply let the process exit drop it.

**Concurrency.** PGlite-style Promise-chain serializer (matches PR #185's adapter). The embedding context handles one call at a time; the queue keeps a failed embed from poisoning subsequent ops, so a single malformed input does not take down the provider.

**Packaging.** `node-llama-cpp` is added as an `optionalDependencies` entry, not a hard dep. Reasoning: it pulls per-platform native binaries on `npm install`, so `optionalDependencies` lets niche or unsupported platforms (e.g., a future linux-musl runner) still install the rest of mycelium. The dynamic import inside the provider throws a clear "install node-llama-cpp or switch to ollama" error if the runtime tries to use llama-cpp without the binding present.

**Default not flipped.** Per the tokenizer-divergence warning above, switching the default would invalidate stored vectors on existing installs. The default stays `ollama`; native installs (#176 sub-task 4, Tauri shell) will set the env explicitly when they ship a fresh data dir.

**Out of this PR.** Cosine-similarity cross-validation against Ollama (deferred to a CI gate before any default flip), automatic model SHA-256 verification (Pillar 6 follow-up #4 above), chat provider, and the REM-digest re-route.
