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
node spike-cosine.mjs               # cross-provider cosine validation (needs Ollama running)
```

Reference reports (this hardware: M4 Mac, 16 GB unified memory, macOS):
- `experiments/native-llm/report-probe.json`
- `experiments/native-llm/report-llama-cpp-embed.json`
- `experiments/native-llm/report-llama-cpp-chat.json`
- `experiments/native-llm/report-cross-cosine.json`

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

### 3. Tokenizer warning — measured: providers are NOT vector-compatible

`node-llama-cpp` emits a startup warning on the nomic-embed-text GGUF:

```
load: special_eos_id is not in special_eog_ids - the tokenizer config may be incorrect
Using this model to tokenize text and then detokenize it resulted in a different text.
```

This warns that **embeddings produced by node-llama-cpp may diverge from those produced by Ollama for the same input**, because one path applies a slightly different tokenisation. The follow-up spike (`spike-cosine.mjs` → `report-cross-cosine.json`) measured the divergence end-to-end on the same 20-sample mycelium corpus, same Q5_K_M GGUF.

**Verdict: NOT MIXABLE — switching providers requires embedding regeneration.**

| | value | accept threshold |
|---|---|---|
| diagonal cosine **avg** | **0.888** | ≥ 0.95 ❌ |
| diagonal cosine **median** | 0.910 | ≥ 0.95 ❌ |
| diagonal cosine **p05** | 0.756 | ≥ 0.95 ❌ |
| diagonal cosine **min** | 0.727 | ≥ 0.95 ❌ |
| diagonal cosine **max** | 0.959 | ≥ 0.95 ✅ (single sample) |
| off-diagonal cosine avg | 0.475 | reference: noise floor |

The diagonal is substantially above the off-diagonal noise floor (0.888 vs 0.475), so the two providers produce **semantically aligned** vector spaces — just not tightly enough for per-input identity. Existing memories embedded with one provider will recall correctly *most of the time* under the other, but with quality decay big enough to violate user expectation on top-k results.

**Side observation:** Ollama returns L2-normalised vectors (norm ≈ 1.0); `node-llama-cpp` returns raw vectors (norm ≈ 18–20). Cosine is invariant to scale, so this is a presentation difference and not the source of the divergence. Adapter code that consumes raw `vector` fields from llama-cpp may want to normalise before storage to keep `<->` distance arithmetic interchangeable across the codebase.

**German text suffers more divergence than English.** The lowest-cosine samples in the corpus are all German (0.727, 0.756, 0.815). Likely tokeniser handling of compound nouns + non-ASCII; worth noting because mycelium's user-facing memory bodies are mixed-language.

**Operational consequences:**

1. The `MYCELIUM_LLM_PROVIDER` env switch must be **install-time only** for existing installs, with a one-shot embedding-regeneration migration when it flips.
2. For greenfield native-app installs (#176's primary target) the DB starts empty — no migration needed.
3. The follow-up issue #1 in the list below MUST include the regeneration migration, not just the provider class. Suggested CI gate: a smoke test that asserts the *configured* provider's embeddings reach cosine ≥ 0.95 against a frozen reference set, so a future provider/quant swap that breaks compatibility fails the build instead of silently degrading recall.

Reproduce: `cd experiments/native-llm && node spike-cosine.mjs` (Ollama with `nomic-embed-text` pulled + the cached GGUF; ~30 s).

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

1. **feat(embeddings): add `LlamaCppEmbeddingProvider` behind `MYCELIUM_LLM_PROVIDER`.** Keeps the existing `EmbeddingProvider` interface; default stays `ollama`. Embedding-regeneration is required when the env switches on an existing install (proven by `spike-cosine.mjs`: diagonal cosine avg 0.888, below the 0.95 mix threshold) — ship the regeneration migration in the same PR, not as a follow-up. CI gate: a smoke test that asserts the *configured* provider's embeddings reach cosine ≥ 0.95 against a frozen reference set, so a future provider/quant swap that breaks compatibility fails the build instead of silently degrading recall.
2. **feat(chat): add `LlamaCppChatProvider` and route REM digest through it when `MYCELIUM_LLM_PROVIDER=llama-cpp`.** Same env switch.
3. **feat(install): native-app default profile selects `llama-cpp` automatically; surface model-download progress in the Tauri shell.** Depends on #176 sub-task 4 (Tauri shell).
4. **feat(security): verify Hugging Face SHA-256 on first model download; refuse to load on mismatch.** Pillar 6.

## Pillar check

- **Pillar 1 (decentralised AI)** — strengthened. Removing the daemon dependency moves the entire LLM stack into the user's own process; no separate service to misconfigure or compromise.
- **Pillar 6 (cyber security)** — neutral with required follow-up. Model files come from Hugging Face; we must add SHA-256 verification before flipping the default. The `node-llama-cpp` package itself is npm-distributed and audit-trackable like any other dep.
