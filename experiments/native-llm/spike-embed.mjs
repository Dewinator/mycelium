#!/usr/bin/env node
// Spike 2b — node-llama-cpp embedding bench (issue #178).
//
// Goal: confirm node-llama-cpp's embeddingContext can replace
// OllamaEmbeddingProvider with the same `embed(text) → number[]` contract.
//
// What we measure:
//   - cold-start: model download + load + first embedding
//   - throughput: 20 sequential embeddings of representative mycelium memories
//   - dimensionality (must be 768 for nomic-embed-text v1.5 to match schema)
//   - peak RSS during embedding loop
//   - side-by-side vs Ollama nomic-embed-text if OLLAMA_URL responds
//
// Model: hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q5_K_M.gguf
// (~84 MB Q5_K_M; Q4_K_M would shave ~20 MB at small recall cost.)

import { getLlama, LlamaLogLevel, resolveModelFile } from "node-llama-cpp";
import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "models");

// Picked to mimic real mycelium memory bodies: short notes, decisions,
// experience summaries, and a long-form lesson.
const SAMPLES = [
  "Reed bevorzugt deutsche Antworten im technischen Kontext.",
  "Wenn die PR-Queue mehrere agent/* PRs enthält, prüfe vor jeder neuen Migration die nächste freie Nummer auf main UND in den offenen PRs — sonst kollidiert die Sequenz.",
  "Spike 1 (issue #177): embedded-postgres bundle ships vanilla Postgres 18.3 only. Migration 001 stirbt an CREATE EXTENSION vector. Pivot: pglite mit pgvector 0.8.1 built-in.",
  "agent_affect tracks four dimensions: frustration, satisfaction, curiosity, fatigue. Plus valence (-1..1) and arousal (0..1). Updated by compute_affect() trigger, not LLM-fed.",
  "Pillar 1 — decentralised, networked AI. mycelium belongs to no single host.",
  "Memory IDs are UUIDs. Embedding dimension is 768. HNSW index on memories(embedding vector_cosine_ops).",
  "REM digest synthesizes lessons from clustered experiences using qwen3:8b. Gate: at least 3 experiences with shared task_type and matching emotional valence.",
  "Tier-A lesson: signed by producer, admitted by consumer's swarm_admit_lesson, pinned via swarm_pin_lesson. Tier-B: same but unpinned.",
  "Trust edge between two peer nodes is established via mTLS cert pinning + initial signed handshake. Revocation propagates through signed_revocations table.",
  "Reed wants the standalone-app initiative (issue #176) prioritised: embedded Postgres + llama.cpp + Tauri shell. No Docker, no external Ollama install.",
  "Lesson reinforcement: when an experience is recalled and marked useful, evidence count increments. At evidence>=3 a lesson promotes to a trait.",
  "Spreading activation: when a memory is recalled, neighbours within 2 hops get a small activation boost — Hebbian: cells that fire together wire together.",
  "Conflict synthesis: when two memories disagree on the same topic, mark both, increase salience, and let the next reflect cycle propose a higher-order resolution.",
  "Affect-from-observables (issue #11): compute_affect() runs as a trigger over experiences/memory_events/skill_outcomes/stimuli — no MCP affect_apply call required.",
  "Genome keys are ed25519. Public key fingerprint = node id. Federation handshake: sign current epoch number, peer verifies + checks revocation list.",
  "Soul-state digest collapses last 24 h of episodes into mood (valence + arousal averages) and a recent-pattern summary (last 10 tasks, success rate, avg difficulty).",
  "Active inference loop: predict next state, observe, compute prediction error, adjust both world-model and policy. Free energy minimisation over the whole stack.",
  "Long-text embedding sampling: head 50% + middle 25% + tail 25% under a 6000-char budget. Better than naive truncate, which loses the conclusion.",
  "Pre-existing migration bug (#180): 040_signed_revocations.sql references revoked_keys but its CREATE is in deferred 038. Fresh installs fail. PR #181 lifts the table.",
  "Ein Schwarm lokaler Agents trainiert eine Population auf die spezifische gelebte Realität ihrer Operatoren — das ist der ganze Punkt.",
];

async function main() {
  const args = new Set(process.argv.slice(2));
  const SKIP_OLLAMA = args.has("--no-ollama");
  const QUANT = process.env.MYCELIUM_GGUF_QUANT ?? "Q5_K_M";

  await mkdir(MODELS_DIR, { recursive: true });

  const report = {
    spike: "issue-178-embed",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    quant: QUANT,
    sample_count: SAMPLES.length,
    steps: {},
  };

  // ---- llama.cpp: load + warm-up + bench ---------------------------------
  const t_init = performance.now();
  let llama;
  try {
    llama = await getLlama({ logLevel: LlamaLogLevel.warn });
    report.steps.runtime = { gpu: llama.gpu, ms_init: performance.now() - t_init };
  } catch (err) {
    report.steps.runtime = { error: String(err) };
    return finalize(report);
  }

  const modelUri = `hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.${QUANT}.gguf`;
  const t_dl = performance.now();
  let model;
  try {
    const modelPath = await resolveModelFile(modelUri, MODELS_DIR);
    model = await llama.loadModel({ modelPath });
    report.steps.model_load = {
      ok: true,
      ms: performance.now() - t_dl,
      uri: modelUri,
      size_mb: Math.round(model.size / 1024 / 1024),
      train_ctx: model.trainContextSize,
      embedding_vector_size: model.embeddingVectorSize,
    };
  } catch (err) {
    report.steps.model_load = { ok: false, error: String(err.message ?? err) };
    return finalize(report);
  }

  if (model.embeddingVectorSize !== 768) {
    report.steps.dimension_check = {
      ok: false,
      expected: 768,
      actual: model.embeddingVectorSize,
      note: "mycelium schema is VECTOR(768); a different dim means a migration",
    };
  } else {
    report.steps.dimension_check = { ok: true };
  }

  let ctx;
  try {
    ctx = await model.createEmbeddingContext();
  } catch (err) {
    report.steps.context_create = { error: String(err) };
    return finalize(report);
  }

  // warm-up (first call pays kernel JIT cost)
  try {
    await ctx.getEmbeddingFor(SAMPLES[0]);
  } catch (err) {
    report.steps.warmup = { error: String(err) };
    return finalize(report);
  }

  const llamaTimings = [];
  const memBefore = process.memoryUsage().rss;
  let firstVec = null;
  for (const s of SAMPLES) {
    const t = performance.now();
    const e = await ctx.getEmbeddingFor(s);
    llamaTimings.push(performance.now() - t);
    if (!firstVec) firstVec = Array.from(e.vector ?? e);
  }
  const memAfter = process.memoryUsage().rss;
  report.steps.llama_bench = {
    samples: SAMPLES.length,
    total_ms: sum(llamaTimings),
    avg_ms: avg(llamaTimings),
    p95_ms: p95(llamaTimings),
    rss_delta_mb: Math.round((memAfter - memBefore) / 1024 / 1024),
    rss_after_mb: Math.round(memAfter / 1024 / 1024),
    vec_dim: firstVec?.length,
    vec_norm: firstVec ? l2norm(firstVec).toFixed(4) : null,
  };

  await ctx.dispose();
  await model.dispose();
  await llama.dispose();

  // ---- ollama side-by-side (only if a local server answers) --------------
  if (!SKIP_OLLAMA) {
    try {
      const { Ollama } = await import("ollama");
      const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
      const ollamaModel = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
      const o = new Ollama({ host: url });
      // probe
      const probe = await fetch(url + "/api/tags").then((r) => r.json());
      const hasModel = (probe?.models ?? []).some((m) => m.name?.startsWith(ollamaModel));
      if (!hasModel) {
        report.steps.ollama_bench = {
          skipped: true,
          reason: `model ${ollamaModel} not pulled in local Ollama`,
        };
      } else {
        // warm-up
        await o.embed({ model: ollamaModel, input: SAMPLES[0] });
        const ot = [];
        for (const s of SAMPLES) {
          const t = performance.now();
          await o.embed({ model: ollamaModel, input: s });
          ot.push(performance.now() - t);
        }
        report.steps.ollama_bench = {
          model: ollamaModel,
          samples: SAMPLES.length,
          total_ms: sum(ot),
          avg_ms: avg(ot),
          p95_ms: p95(ot),
        };
      }
    } catch (err) {
      report.steps.ollama_bench = { skipped: true, error: String(err.message ?? err) };
    }
  }

  return finalize(report);
}

function sum(a) { return a.reduce((s, x) => s + x, 0); }
function avg(a) { return a.length ? sum(a) / a.length : 0; }
function p95(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function l2norm(v) {
  let s = 0; for (const x of v) s += x * x; return Math.sqrt(s);
}

async function finalize(report) {
  report.finished_at = new Date().toISOString();
  report.verdict = verdictLine(report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nverdict: ${report.verdict}`);
  await writeFile(
    path.join(__dirname, "report-llama-cpp-embed.json"),
    JSON.stringify(report, null, 2)
  );
}

function verdictLine(r) {
  if (r.steps.model_load && !r.steps.model_load.ok) {
    return `model load FAILED — ${r.steps.model_load.error?.slice(0, 200)}`;
  }
  const lb = r.steps.llama_bench;
  const ob = r.steps.ollama_bench;
  if (!lb) return "no llama bench";
  const llamaLine = `llama.cpp ${lb.samples} embeds · avg ${lb.avg_ms?.toFixed(1)} ms · p95 ${lb.p95_ms?.toFixed(1)} ms · ${lb.vec_dim}d · rss ${lb.rss_after_mb} MB`;
  if (!ob || ob.skipped) return llamaLine;
  return `${llamaLine} · ollama avg ${ob.avg_ms?.toFixed(1)} ms · ratio ${(lb.avg_ms / ob.avg_ms).toFixed(2)}x`;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
