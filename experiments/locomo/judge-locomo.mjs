#!/usr/bin/env node
// judge-locomo.mjs — score a predictions.jsonl file against gold answers
// using an LLM-as-judge. Default judge is local qwen3:8b (free). Pass
// --judge=openai or --judge=anthropic to cross-check with a cloud model
// (requires OPENAI_API_KEY / ANTHROPIC_API_KEY in env).
//
// Output: out/<sample_id>/judgment.json with per-QA verdicts and
// per-category accuracy.
//
// Usage:
//   node experiments/locomo/judge-locomo.mjs --conv=conv-26
//   node experiments/locomo/judge-locomo.mjs --conv=conv-26 --judge=openai --judge-model=gpt-4o-mini

import path from "node:path";
import fs from "node:fs/promises";
import { OUT_ROOT, ollamaChat, parseArgs, writeJSON } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const sampleId = args.conv ?? "conv-26";
const judge = args.judge || "ollama"; // ollama | openai | anthropic
const judgeModel =
  args["judge-model"] ||
  (judge === "ollama" ? "qwen2.5:7b-instruct" : judge === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");

const predFile = path.join(OUT_ROOT, sampleId, "predictions.jsonl");
const outFile = path.join(OUT_ROOT, sampleId, "judgment.json");

const lines = (await fs.readFile(predFile, "utf8")).split("\n").filter(Boolean);
const preds = lines.map((l) => JSON.parse(l));
console.log(`[${sampleId}] ${preds.length} predictions to judge with ${judge}/${judgeModel}`);

const SYSTEM = `You are a strict evaluator for question answering. ` +
  `Compare a predicted answer to a gold answer for a question about a long conversation. ` +
  `Decide whether the prediction is correct, partially correct, or wrong. ` +
  `Answer with EXACTLY one of these tokens on the first line: CORRECT, PARTIAL, WRONG. ` +
  `Then on a second line write a one-sentence justification.`;

const verdicts = [];
const t0 = Date.now();

for (let i = 0; i < preds.length; i++) {
  const p = preds[i];
  const userMsg =
    `Question: ${p.question}\n` +
    `Gold answer: ${p.gold_answer}\n` +
    `Predicted answer: ${p.prediction || "<empty>"}\n\n` +
    `Verdict:`;

  let raw = "";
  let err = null;
  try {
    raw = await callJudge({ system: SYSTEM, user: userMsg, judge, model: judgeModel });
  } catch (e) {
    err = String(e);
  }
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  const verdictTok = (cleaned.match(/\b(CORRECT|PARTIAL|WRONG)\b/i) || [])[1]?.toUpperCase() || "WRONG";

  verdicts.push({
    qa_index: p.qa_index,
    category: p.category,
    question: p.question,
    gold_answer: p.gold_answer,
    prediction: p.prediction,
    retrieved_dia_ids: p.retrieved_dia_ids,
    evidence: p.evidence,
    verdict: verdictTok,
    raw_judgment: cleaned,
    error: err,
  });

  if ((i + 1) % 25 === 0) console.log(`[${sampleId}] judged ${i + 1}/${preds.length}`);
}

// Aggregate scores. CORRECT=1, PARTIAL=0.5, WRONG=0.
const score = (v) => (v === "CORRECT" ? 1 : v === "PARTIAL" ? 0.5 : 0);
const overall = verdicts.reduce((s, v) => s + score(v.verdict), 0) / verdicts.length;
const byCat = {};
for (const v of verdicts) {
  byCat[v.category] ??= { n: 0, sum: 0, correct: 0, partial: 0, wrong: 0 };
  byCat[v.category].n += 1;
  byCat[v.category].sum += score(v.verdict);
  byCat[v.category][v.verdict.toLowerCase()] = (byCat[v.category][v.verdict.toLowerCase()] || 0) + 1;
}
for (const k of Object.keys(byCat)) {
  byCat[k].accuracy = byCat[k].sum / byCat[k].n;
}

// Retrieval-evidence overlap: fraction of QA where at least one gold
// evidence dia_id was in the top-K recall.
let withEv = 0, hitEv = 0;
for (const v of verdicts) {
  if (!v.evidence || !v.evidence.length) continue;
  withEv += 1;
  if (v.evidence.some((e) => v.retrieved_dia_ids.includes(e))) hitEv += 1;
}
const recallEvidence = withEv ? hitEv / withEv : null;

const summary = {
  sample_id: sampleId,
  judge,
  judge_model: judgeModel,
  total_qa: verdicts.length,
  accuracy_overall: overall,
  accuracy_by_category: byCat,
  retrieval_evidence_recall: recallEvidence,
  judge_elapsed_s: (Date.now() - t0) / 1000,
  verdicts,
};

await writeJSON(outFile, summary);
console.log(`[${sampleId}] judgment written to ${outFile}`);
console.log(`[${sampleId}] overall accuracy: ${(overall * 100).toFixed(1)}%`);
console.log(`[${sampleId}] retrieval evidence-recall: ${recallEvidence == null ? "n/a" : (recallEvidence * 100).toFixed(1) + "%"}`);
for (const [cat, v] of Object.entries(byCat)) {
  console.log(`[${sampleId}]   cat ${cat}: ${(v.accuracy * 100).toFixed(1)}% (n=${v.n})`);
}

async function callJudge({ system, user, judge, model }) {
  if (judge === "ollama") {
    return await ollamaChat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      num_predict: 80,
      temperature: 0,
    });
  }
  if (judge === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY missing");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
  }
  if (judge === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY missing");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 80,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.content?.[0]?.text ?? "";
  }
  throw new Error(`unknown judge "${judge}"`);
}
