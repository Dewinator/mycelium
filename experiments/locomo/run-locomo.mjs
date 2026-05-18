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
  loadDataset, findSample, projectSlugFor, parseArgs, ollamaChat, claudeCliChat,
  appendJSONL, OUT_ROOT, MemoryService, ProjectService, createEmbeddingProvider,
  SUPABASE_URL, SUPABASE_KEY, BM25, rrfMerge,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const sampleId = args.conv ?? "conv-26";
const maxQa = args["max-qa"] ? Number(args["max-qa"]) : Infinity;
const topK = args["top-k"] ? Number(args["top-k"]) : 25;
const provider = args.provider || "ollama"; // ollama | claude
const model = args.model || (provider === "claude" ? "claude-sonnet-4-6" : "qwen2.5:7b-instruct");
const numPredict = args["num-predict"] ? Number(args["num-predict"]) : 128;
const outSuffix = args["out-suffix"] || ""; // e.g. "-claude" -> out-claude/
const useRrf = !!args.rrf;            // --rrf enables BM25+dense RRF retrieval
const useCompact = !!args.compact;    // --compact: clean context for local models
const randomBaseline = !!args["random-baseline"]; // --random-baseline: no recall, random turns

const dataset = await loadDataset();
const sample = findSample(dataset, sampleId);
const slug = projectSlugFor(sampleId);

const embeddings = createEmbeddingProvider();
const memSvc = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const projects = new ProjectService(SUPABASE_URL, SUPABASE_KEY);

const project = await projects.getBySlug(slug);
if (!project) throw new Error(`project ${slug} not found — run ingest first`);

const outRoot = outSuffix ? OUT_ROOT.replace(/\/out$/, `/out${outSuffix}`) : OUT_ROOT;
const outFile = path.join(outRoot, sampleId, "predictions.jsonl");
await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, ""); // truncate

const speakerA = sample.conversation.speaker_a;
const speakerB = sample.conversation.speaker_b;

// Check whether this project has enriched memories (facts/summaries).
const { data: enrichCheck } = await memSvc.db
  .from("memories").select("id").eq("project_id", project.id)
  .contains("tags", ["locomo-enriched"]).limit(1);
const hasEnriched = enrichCheck && enrichCheck.length > 0;

// Fetch all raw (non-enriched) turns once — needed for both RRF and random-baseline.
let allDocs = null;
let bm25 = null;
if (useRrf || randomBaseline) {
  const { data: rows, error } = await memSvc.db
    .from("memories").select("id, content, tags").eq("project_id", project.id);
  if (error) throw new Error(`fetch all docs: ${error.message}`);
  allDocs = rows;
  if (useRrf) {
    bm25 = new BM25(rows.map((r) => r.content));
    console.log(`[${sampleId}] RRF mode — BM25 index built over ${rows.length} memories`);
  }
  if (randomBaseline) {
    // Keep only raw turns (exclude enriched) for a fair vanilla baseline.
    allDocs = rows.filter((r) => !(r.tags || []).includes("locomo-enriched"));
    console.log(`[${sampleId}] random-baseline mode — ${allDocs.length} raw turns available`);
  }
}

const SYSTEM = hasEnriched
  ? `You are answering questions about a long conversation between ${speakerA} and ${speakerB}. ` +
    `You will be shown two types of retrieved memory: EXTRACTED FACTS (pre-processed atomic facts, high precision) ` +
    `and CONVERSATION TURNS (verbatim dialog). ` +
    `For factual questions (who, what, when, where), prefer the EXTRACTED FACTS — they are more reliable than raw turns. ` +
    `Answer based ONLY on the retrieved context. Be concise — one short sentence or phrase. ` +
    `If the answer is a date or number, give it exactly. If you cannot determine the answer, say "I don't know".`
  : `You are answering questions about a long conversation between ${speakerA} and ${speakerB}. ` +
    `You will be shown conversation turns retrieved from memory. Each turn is prefixed with [DIA-ID SPEAKER @TIMESTAMP]. ` +
    `Answer the question based ONLY on the retrieved turns. Be concise — one short sentence or phrase. ` +
    `If the answer is a date, give the date. If you cannot determine the answer from the turns, say "I don't know".`;

const t0 = Date.now();
let n = 0;

for (const qa of sample.qa) {
  if (n >= maxQa) break;
  n += 1;

  let hits;
  if (randomBaseline && allDocs) {
    // Vanilla baseline: topK randomly sampled raw turns — no semantic retrieval.
    // Simple LCG seeded by QA index for reproducibility across runs.
    const pool = [...allDocs];
    let lcg = (n * 1664525 + 1013904223) >>> 0;
    for (let i = pool.length - 1; i > 0; i--) {
      lcg = (lcg * 1664525 + 1013904223) >>> 0;
      const j = lcg % (i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    hits = pool.slice(0, topK).map((r) => ({ content: r.content }));
  } else if (useRrf && bm25 && allDocs) {
    // Dense retrieval
    const denseHits = await memSvc.search(qa.question, undefined, topK, 0.6,
      { projectId: project.id, includePinnedGlobal: false });
    const denseOrder = denseHits.map((h) => h.content);
    // BM25 retrieval
    const bm25Order = bm25.topK(qa.question, topK).map(([idx]) => allDocs[idx].content);
    // RRF merge — use content string as stable key
    const mergedOrder = rrfMerge([denseOrder, bm25Order]);
    // Rebuild hit objects in merged order
    const denseMap = new Map(denseHits.map((h) => [h.content, h]));
    const docsMap = new Map(allDocs.map((d) => [d.content, { content: d.content }]));
    hits = mergedOrder.slice(0, topK).map((c) => denseMap.get(c) || docsMap.get(c)).filter(Boolean);
  } else {
    hits = await memSvc.search(qa.question, undefined, topK, 0.6,
      { projectId: project.id, includePinnedGlobal: false });
  }

  // Separate enriched memories (facts/summaries) from raw turns.
  // Enriched format: [D<sess>:<LETTER>… — raw turns use a digit after the colon.
  const enrichedHits = hits.filter((h) => /^\[D\d+:[A-Z]/.test(h.content));
  const turnHits = hits.filter((h) => !/^\[D\d+:[A-Z]/.test(h.content));

  // Sort raw turns chronologically; enriched facts go first.
  const sortedTurns = [...turnHits].sort((a, b) => {
    const pa = parseDiaId(a.content);
    const pb = parseDiaId(b.content);
    if (pa.s !== pb.s) return pa.s - pb.s;
    return pa.t - pb.t;
  });

  let ctxBlock;
  if (useCompact) {
    // Compact mode: clean bullet-point content, facts first — for local models.
    const parts = [];
    if (enrichedHits.length > 0) {
      parts.push("KEY FACTS:\n" + enrichedHits.map((h) => `• ${h.content}`).join("\n"));
    }
    if (sortedTurns.length > 0) {
      parts.push("CONTEXT:\n" + sortedTurns.map((h) => `• ${h.content}`).join("\n"));
    }
    ctxBlock = parts.join("\n\n");
  } else if (enrichedHits.length > 0) {
    ctxBlock =
      "EXTRACTED FACTS:\n" + enrichedHits.map((h) => h.content).join("\n") +
      "\n\nCONVERSATION TURNS:\n" + sortedTurns.map((h) => h.content).join("\n");
  } else {
    ctxBlock = sortedTurns.map((h) => h.content).join("\n");
  }

  const userMsg = (enrichedHits.length > 0 || useCompact)
    ? `Retrieved context:\n${ctxBlock}\n\nQuestion: ${qa.question}\n\nAnswer:`
    : `Retrieved conversation turns:\n${ctxBlock}\n\nQuestion: ${qa.question}\n\nAnswer:`;

  const t1 = Date.now();
  let prediction = "";
  let err = null;
  try {
    if (provider === "claude") {
      prediction = (await claudeCliChat({ model, system: SYSTEM, user: userMsg })).trim();
    } else {
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
    }
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
    retrieved_dia_ids: hits.map((h) => extractDiaId(h.content)).filter(Boolean),
    retrieved_count: hits.length,
    elapsed_ms: elapsedMs,
    model,
    error: err,
  });

  const stride = provider === "claude" ? 5 : 10;
  if (n % stride === 0 || err) {
    console.log(`[${sampleId}/${provider}] ${n}/${sample.qa.length} qa  · last ${elapsedMs}ms${err ? ` · ERR ${err}` : ""}`);
  }

  if (provider === "claude" && n < sample.qa.length) {
    await new Promise((r) => setTimeout(r, 1500));
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
