#!/usr/bin/env node
// Spike 2c — node-llama-cpp chat smoke-test (issue #178).
//
// Goal: confirm node-llama-cpp's LlamaChatSession can replace the Ollama
// `qwen3:8b` call site in REM digest with the same `chat(messages) → string`
// contract.
//
// Default model: Qwen2.5-0.5B-Instruct GGUF — small (~390 MB Q5_K_M), fast,
// real-world enough to validate prompt format + tokenizer + Metal kernels.
// In production REM we'd run Qwen2.5-7B or Qwen3-8B; the *protocol* doesn't
// change, only the model file. Use MYCELIUM_CHAT_MODEL_URI to point at a
// bigger GGUF for serious benchmarking.
//
// What we measure:
//   - cold-start: model download + load + first generation
//   - generation throughput: tokens/sec on a 64-token completion
//   - context window the model reports
//   - peak RSS
//   - whether system+user prompt is honoured (REM-style synthesis prompt)

import { getLlama, LlamaLogLevel, LlamaChatSession, resolveModelFile } from "node-llama-cpp";
import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "models");

const DEFAULT_URI =
  "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q5_k_m.gguf";

const REM_LIKE_SYSTEM = `Du bist mycelium's REM-Synthesizer. Du erhältst eine Gruppe von Erfahrungen, die einen wiederkehrenden Pattern teilen. Destilliere genau eine Lesson — kurz, prägnant, im Wenn-X-dann-Y-Stil — die zukünftige Ticks anwenden können. Antworte NUR mit der Lesson, keine Vorrede.`;

const REM_LIKE_USER = `Cluster (3 Erfahrungen, task_type=implement, valence ~ +0.6):
1. PR-Queue mit zwei agent/* PRs, beide neue Migration. Vor Schreiben prüfte ich die nächste freie Migrationsnummer auf main + in den offenen PRs. Erfolg, kein Konflikt.
2. Drei agent-Branches mit überlappenden Migrationen — vergessen vorher zu prüfen, Konflikt 040 ↔ 040. Re-Nummerierung kostete Stunden.
3. Vor neuer Migration zuerst gh pr list + git log auf main. Free slot 045 erkannt. Erfolg.

Welche Lesson?`;

async function main() {
  const args = new Set(process.argv.slice(2));
  const KEEP_RESPONSE = args.has("--keep-response");

  await mkdir(MODELS_DIR, { recursive: true });

  const modelUri = process.env.MYCELIUM_CHAT_MODEL_URI ?? DEFAULT_URI;
  const maxTokens = parseInt(process.env.MYCELIUM_CHAT_MAX_TOKENS ?? "96", 10);

  const report = {
    spike: "issue-178-chat",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    model_uri: modelUri,
    max_tokens: maxTokens,
    steps: {},
  };

  const t_init = performance.now();
  let llama;
  try {
    llama = await getLlama({ logLevel: LlamaLogLevel.warn });
    report.steps.runtime = { gpu: llama.gpu, ms_init: performance.now() - t_init };
  } catch (err) {
    report.steps.runtime = { error: String(err) };
    return finalize(report);
  }

  const t_load = performance.now();
  let model;
  try {
    const modelPath = await resolveModelFile(modelUri, MODELS_DIR);
    model = await llama.loadModel({ modelPath });
    report.steps.model_load = {
      ok: true,
      ms: performance.now() - t_load,
      size_mb: Math.round(model.size / 1024 / 1024),
      train_ctx: model.trainContextSize,
      arch: model.fileInfo?.metadata?.general?.architecture,
    };
  } catch (err) {
    report.steps.model_load = { ok: false, error: String(err.message ?? err) };
    return finalize(report);
  }

  const t_ctx = performance.now();
  let context;
  let session;
  try {
    context = await model.createContext({ contextSize: 2048 });
    const seq = context.getSequence();
    session = new LlamaChatSession({
      contextSequence: seq,
      systemPrompt: REM_LIKE_SYSTEM,
    });
    report.steps.context_ready = { ok: true, ms: performance.now() - t_ctx };
  } catch (err) {
    report.steps.context_ready = { error: String(err) };
    return finalize(report);
  }

  const memBefore = process.memoryUsage().rss;
  const t_gen = performance.now();
  let response = null;
  let tokenCount = 0;
  try {
    response = await session.prompt(REM_LIKE_USER, {
      maxTokens,
      temperature: 0.4,
      onTextChunk: (text) => {
        // tokens are emitted in chunks; rough proxy
        tokenCount += Math.max(1, Math.round(text.length / 4));
      },
    });
  } catch (err) {
    report.steps.gen_error = String(err);
    return finalize(report);
  }
  const elapsedMs = performance.now() - t_gen;
  const memAfter = process.memoryUsage().rss;

  report.steps.generation = {
    ok: true,
    ms: elapsedMs,
    approx_tokens: tokenCount,
    approx_tokens_per_sec: tokenCount / (elapsedMs / 1000),
    response_chars: response?.length ?? 0,
    response_preview: response?.slice(0, 280) ?? null,
    rss_delta_mb: Math.round((memAfter - memBefore) / 1024 / 1024),
    rss_after_mb: Math.round(memAfter / 1024 / 1024),
  };

  if (KEEP_RESPONSE && response) {
    await writeFile(path.join(__dirname, "report-chat-response.txt"), response);
  }

  await context.dispose();
  await model.dispose();
  await llama.dispose();

  return finalize(report);
}

async function finalize(report) {
  report.finished_at = new Date().toISOString();
  report.verdict = verdictLine(report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nverdict: ${report.verdict}`);
  await writeFile(
    path.join(__dirname, "report-llama-cpp-chat.json"),
    JSON.stringify(report, null, 2)
  );
}

function verdictLine(r) {
  if (r.steps.model_load && !r.steps.model_load.ok) {
    return `model load FAILED — ${r.steps.model_load.error?.slice(0, 200)}`;
  }
  const g = r.steps.generation;
  if (!g) return "no generation";
  return `chat OK · ~${g.approx_tokens} tok in ${g.ms.toFixed(0)} ms · ~${g.approx_tokens_per_sec.toFixed(1)} tok/s · rss ${g.rss_after_mb} MB`;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
