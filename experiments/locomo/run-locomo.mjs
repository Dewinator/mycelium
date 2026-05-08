#!/usr/bin/env node
// run-locomo.mjs — answer every QA pair for one conversation, using
// mycelium's recall (project-scoped) + a local LLM as answerer.
//
// Output: out/<sample_id>/predictions.jsonl (one row per QA).
//
// Usage:
//   node experiments/locomo/run-locomo.mjs --conv=conv-26
//   node experiments/locomo/run-locomo.mjs --conv=conv-26 --max-qa=10 --top-k=20
//   node experiments/locomo/run-locomo.mjs --conv=conv-26 --model=qwen3:8b

import path from "node:path";
import fs from "node:fs/promises";
import {
  loadDataset, findSample, projectSlugFor, parseArgs, ollamaChat,
  appendJSONL, OUT_ROOT, MemoryService, ProjectService, createEmbeddingProvider,
  SUPABASE_URL, SUPABASE_KEY,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const sampleId = args.conv ?? "conv-26";
const maxQa = args["max-qa"] ? Number(args["max-qa"]) : Infinity;
const topK = args["top-k"] ? Number(args["top-k"]) : 25;
const model = args.model || "qwen2.5:7b-instruct";
const numPredict = args["num-predict"] ? Number(args["num-predict"]) : 128;

const dataset = await loadDataset();
const sample = findSample(dataset, sampleId);
const slug = projectSlugFor(sampleId);

const embeddings = createEmbeddingProvider();
const memSvc = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const projects = new ProjectService(SUPABASE_URL, SUPABASE_KEY);

const project = await projects.getBySlug(slug);
if (!project) throw new Error(`project ${slug} not found — run ingest first`);

const outFile = path.join(OUT_ROOT, sampleId, "predictions.jsonl");
await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, ""); // truncate

const speakerA = sample.conversation.speaker_a;
const speakerB = sample.conversation.speaker_b;

const SYSTEM = `You are answering questions about a long conversation between ${speakerA} and ${speakerB}. ` +
  `You will be shown conversation turns retrieved from memory. Each turn is prefixed with [DIA-ID SPEAKER @TIMESTAMP]. ` +
  `Answer the question based ONLY on the retrieved turns. Be concise — one short sentence or phrase. ` +
  `If the answer is a date, give the date. If you cannot determine the answer from the turns, say "I don't know".`;

const t0 = Date.now();
let n = 0;

for (const qa of sample.qa) {
  if (n >= maxQa) break;
  n += 1;

  const hits = await memSvc.search(
    qa.question,
    undefined,
    topK,
    0.6,
    { projectId: project.id, includePinnedGlobal: false }
  );

  // Sort retrieved turns chronologically by dia_id (D<sess>:<turn>) so the
  // answerer sees them in conversation order, not by relevance.
  const sorted = [...hits].sort((a, b) => {
    const pa = parseDiaId(a.content);
    const pb = parseDiaId(b.content);
    if (pa.s !== pb.s) return pa.s - pb.s;
    return pa.t - pb.t;
  });

  const ctxBlock = sorted.map((h) => h.content).join("\n");

  const userMsg = `Retrieved conversation turns:\n${ctxBlock}\n\nQuestion: ${qa.question}\n\nAnswer:`;

  const t1 = Date.now();
  let prediction = "";
  let err = null;
  try {
    prediction = (await ollamaChat({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
      num_predict: numPredict,
      temperature: 0,
    })).trim();
    // qwen3 sometimes prepends <think>…</think> — strip it.
    prediction = prediction.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  } catch (e) {
    err = String(e);
  }
  const elapsedMs = Date.now() - t1;

  await appendJSONL(outFile, {
    sample_id: sampleId,
    qa_index: n - 1,
    question: qa.question,
    gold_answer: qa.answer,
    category: qa.category,
    evidence: qa.evidence ?? [],
    prediction,
    retrieved_dia_ids: sorted.map((h) => extractDiaId(h.content)).filter(Boolean),
    retrieved_count: sorted.length,
    elapsed_ms: elapsedMs,
    model,
    error: err,
  });

  if (n % 10 === 0 || err) {
    console.log(`[${sampleId}] ${n}/${sample.qa.length} qa  · last ${elapsedMs}ms${err ? ` · ERR ${err}` : ""}`);
  }
}

const totalMs = Date.now() - t0;
console.log(`[${sampleId}] done — ${n} QA answered in ${(totalMs / 1000).toFixed(1)}s · written to ${outFile}`);

function parseDiaId(content) {
  const m = content.match(/^\[D(\d+):(\d+)\b/);
  if (!m) return { s: 9999, t: 9999 };
  return { s: Number(m[1]), t: Number(m[2]) };
}

function extractDiaId(content) {
  const m = content.match(/^\[(D\d+:\d+)\b/);
  return m ? m[1] : null;
}
