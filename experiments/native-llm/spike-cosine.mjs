#!/usr/bin/env node
// Spike 2c — cross-provider cosine validation (issue #178, doc §3 follow-up).
//
// Question: do node-llama-cpp and Ollama produce *compatible* embeddings for
// the same nomic-embed-text-v1.5 model+quant, or does the tokeniser
// divergence flagged in spike-embed.mjs break per-input vector identity?
//
// If cosine(llama_v, ollama_v) >= 0.95 across the corpus, an existing install
// can flip MYCELIUM_LLM_PROVIDER=llama-cpp without re-embedding its memories.
// Below that, switching providers becomes a one-shot embedding regeneration.
//
// Output: report-cross-cosine.json with per-sample cosine + aggregate stats.
//
// Reuses SAMPLES from spike-embed.mjs (same corpus → comparable benchmarks).

import { getLlama, LlamaLogLevel, resolveModelFile } from "node-llama-cpp";
import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, "models");

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

const ACCEPT_THRESHOLD = 0.95; // doc §3 — below this we cannot mix providers in one DB

async function main() {
  const QUANT = process.env.MYCELIUM_GGUF_QUANT ?? "Q5_K_M";
  await mkdir(MODELS_DIR, { recursive: true });

  const report = {
    spike: "issue-178-cross-cosine",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    quant: QUANT,
    sample_count: SAMPLES.length,
    accept_threshold: ACCEPT_THRESHOLD,
    steps: {},
  };

  // ---- llama.cpp embeddings ----------------------------------------------
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });
  report.steps.runtime = { gpu: llama.gpu };
  const modelUri = `hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.${QUANT}.gguf`;
  const modelPath = await resolveModelFile(modelUri, MODELS_DIR);
  const t_load = performance.now();
  const model = await llama.loadModel({ modelPath });
  report.steps.model_load = {
    ok: true,
    ms: performance.now() - t_load,
    uri: modelUri,
    embedding_vector_size: model.embeddingVectorSize,
  };
  const ctx = await model.createEmbeddingContext();
  await ctx.getEmbeddingFor(SAMPLES[0]); // warm-up

  const llamaVecs = [];
  for (const s of SAMPLES) {
    const e = await ctx.getEmbeddingFor(s);
    llamaVecs.push(Array.from(e.vector ?? e));
  }
  await ctx.dispose();
  await model.dispose();
  await llama.dispose();

  // ---- ollama embeddings -------------------------------------------------
  const { Ollama } = await import("ollama");
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const ollamaModel = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
  const o = new Ollama({ host: url });
  const probe = await fetch(url + "/api/tags").then((r) => r.json());
  const hasModel = (probe?.models ?? []).some((m) => m.name?.startsWith(ollamaModel));
  if (!hasModel) {
    report.steps.ollama_embed = { skipped: true, reason: `model ${ollamaModel} not in local Ollama` };
    return finalize(report);
  }
  await o.embed({ model: ollamaModel, input: SAMPLES[0] }); // warm-up
  const ollamaVecs = [];
  for (const s of SAMPLES) {
    const r = await o.embed({ model: ollamaModel, input: s });
    const v = r.embeddings?.[0] ?? r.embedding;
    ollamaVecs.push(Array.from(v));
  }

  // ---- cross cosine + aggregate -----------------------------------------
  const dimMatch = llamaVecs[0].length === ollamaVecs[0].length;
  const perSample = SAMPLES.map((s, i) => ({
    idx: i,
    chars: s.length,
    llama_norm: l2norm(llamaVecs[i]),
    ollama_norm: l2norm(ollamaVecs[i]),
    cosine: cosine(llamaVecs[i], ollamaVecs[i]),
    sample: s.slice(0, 80),
  }));
  const cosines = perSample.map((p) => p.cosine).sort((a, b) => a - b);

  // Off-diagonal sanity: cosine(llama_i, ollama_j) for i!=j should be much
  // lower than the diagonal — confirms the spaces are aligned per-input,
  // not just globally.
  const offDiag = [];
  for (let i = 0; i < SAMPLES.length; i++) {
    for (let j = 0; j < SAMPLES.length; j++) {
      if (i === j) continue;
      offDiag.push(cosine(llamaVecs[i], ollamaVecs[j]));
    }
  }
  offDiag.sort((a, b) => a - b);

  const minCos = cosines[0];
  const avgCos = avg(cosines);
  const medianCos = cosines[Math.floor(cosines.length / 2)];
  const p05Cos = cosines[Math.floor(cosines.length * 0.05)];

  report.steps.cross_cosine = {
    dim_llama: llamaVecs[0].length,
    dim_ollama: ollamaVecs[0].length,
    dim_match: dimMatch,
    diagonal: {
      min: minCos,
      avg: avgCos,
      median: medianCos,
      p05: p05Cos,
      max: cosines[cosines.length - 1],
    },
    off_diagonal: {
      min: offDiag[0],
      avg: avg(offDiag),
      median: offDiag[Math.floor(offDiag.length / 2)],
      max: offDiag[offDiag.length - 1],
    },
    per_sample: perSample,
  };

  const verdict = !dimMatch
    ? `dim mismatch — llama ${llamaVecs[0].length} vs ollama ${ollamaVecs[0].length}, cannot mix`
    : minCos >= ACCEPT_THRESHOLD
    ? `MIXABLE — diagonal min ${minCos.toFixed(4)} ≥ ${ACCEPT_THRESHOLD}; existing installs can flip provider without re-embedding`
    : avgCos >= ACCEPT_THRESHOLD
    ? `BORDERLINE — diagonal avg ${avgCos.toFixed(4)} ≥ ${ACCEPT_THRESHOLD} but min ${minCos.toFixed(4)} < threshold; per-input outliers exist`
    : `NOT MIXABLE — diagonal avg ${avgCos.toFixed(4)} < ${ACCEPT_THRESHOLD}; switching providers requires embedding regeneration`;
  report.verdict = verdict;

  return finalize(report);
}

function l2norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

async function finalize(report) {
  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nverdict: ${report.verdict ?? "incomplete"}`);
  await writeFile(
    path.join(__dirname, "report-cross-cosine.json"),
    JSON.stringify(report, null, 2)
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
