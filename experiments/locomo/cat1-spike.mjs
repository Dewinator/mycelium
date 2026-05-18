#!/usr/bin/env node
// cat1-spike.mjs — compare four retrieval methods on LoCoMo cat-1 (single-hop)
// QA, isolated from the production recall path. Reports recall@5/10/25 per
// method on already-ingested per-conv projects.
//
//   A · pure-dense        vector_weight=1.0  (RPC match_memories_cognitive)
//   B · current-hybrid    vector_weight=0.6  (RPC, today's default)
//   C · bm25-english      Okapi BM25 in-process on raw turn content
//   D · rrf(dense+bm25)   Reciprocal Rank Fusion of A + C
//
// Usage:
//   node experiments/locomo/cat1-spike.mjs --conv=conv-26
//   node experiments/locomo/cat1-spike.mjs --all

import {
  loadDataset, findSample, listSampleIds, projectSlugFor, parseArgs,
  MemoryService, ProjectService, createEmbeddingProvider,
  SUPABASE_URL, SUPABASE_KEY,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dataset = await loadDataset();
const targets = args.all ? listSampleIds(dataset) : [args.conv ?? "conv-26"];
const TOP_K = 25;
const RRF_K = 60; // standard RRF constant

const embeddings = createEmbeddingProvider();
const memSvc = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const projects = new ProjectService(SUPABASE_URL, SUPABASE_KEY);

// -------- BM25 (Okapi) ----------------------------------------------------

const STOP = new Set("a an the and or of in on at to for with from by is are was were be been being have has had do does did this that these those it its as i you he she we they me him her us them my your his our their".split(" "));

function tokenize(s) {
  return s.toLowerCase().replace(/\[d\d+:\d+[^\]]*\]/g, " ") // strip [DIA-ID …]
                       .replace(/[^a-z0-9 ]+/g, " ")
                       .split(/\s+/)
                       .filter((t) => t && t.length > 1 && !STOP.has(t));
}

class BM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.docs = docs.map(tokenize);
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.length, 0) / this.N || 1;
    this.df = new Map();
    for (const d of this.docs) {
      for (const t of new Set(d)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.idf = new Map();
    for (const [t, df] of this.df) {
      this.idf.set(t, Math.log(1 + (this.N - df + 0.5) / (df + 0.5)));
    }
  }
  score(qTokens, di) {
    const doc = this.docs[di];
    const dl = doc.length || 1;
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = this.idf.get(t) || 0;
      const denom = f + this.k1 * (1 - this.b + this.b * dl / this.avgdl);
      s += idf * ((f * (this.k1 + 1)) / denom);
    }
    return s;
  }
  topK(query, k) {
    const q = tokenize(query);
    const scored = this.docs.map((_, i) => [i, this.score(q, i)]);
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k);
  }
}

// -------- helpers ---------------------------------------------------------

function extractDiaId(content) {
  const m = content.match(/^\[(D\d+:\d+)\b/);
  return m ? m[1] : null;
}

function recallAtK(retrievedDiaIds, goldEvidence, k) {
  if (!goldEvidence || goldEvidence.length === 0) return null;
  const top = new Set(retrievedDiaIds.slice(0, k));
  const gold = new Set(goldEvidence);
  let hit = 0;
  for (const g of gold) if (top.has(g)) hit += 1;
  return hit / gold.size;
}

function rrf(rankings, k = RRF_K) {
  // rankings: array of arrays of dia_ids, ordered best-first per method
  const score = new Map();
  for (const rank of rankings) {
    rank.forEach((id, idx) => {
      score.set(id, (score.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// -------- main ------------------------------------------------------------

const summary = [];

for (const sampleId of targets) {
  const sample = findSample(dataset, sampleId);
  const slug = projectSlugFor(sampleId);
  const project = await projects.getBySlug(slug);
  if (!project) { console.error(`[${sampleId}] no project — skipping`); continue; }

  const cat1 = sample.qa.filter((q) => q.category === 1);
  if (!cat1.length) { console.error(`[${sampleId}] no cat-1 QA — skipping`); continue; }

  // Pull all turns for this project once for BM25 corpus.
  const { data: rows, error } = await memSvc.db
    .from("memories")
    .select("id, content, metadata")
    .eq("project_id", project.id);
  if (error) throw new Error(`fetch turns: ${error.message}`);
  const docs = rows.map((r) => r.content);
  const docDia = rows.map((r) => r.metadata?.dia_id || extractDiaId(r.content));
  const bm25 = new BM25(docs);

  console.log(`[${sampleId}] ${cat1.length} cat-1 QA · ${rows.length} turns ingested`);

  const accA = { 5: [], 10: [], 25: [] };
  const accB = { 5: [], 10: [], 25: [] };
  const accC = { 5: [], 10: [], 25: [] };
  const accD = { 5: [], 10: [], 25: [] };

  let i = 0;
  for (const qa of cat1) {
    i += 1;
    const evidence = qa.evidence || [];
    if (!evidence.length) continue;

    // A · pure dense (RPC, weight=1.0)
    const hitsA = await memSvc.search(qa.question, undefined, TOP_K, 1.0,
      { projectId: project.id, includePinnedGlobal: false });
    const diaA = hitsA.map((h) => extractDiaId(h.content)).filter(Boolean);

    // B · current hybrid (RPC, weight=0.6 — today's baseline)
    const hitsB = await memSvc.search(qa.question, undefined, TOP_K, 0.6,
      { projectId: project.id, includePinnedGlobal: false });
    const diaB = hitsB.map((h) => extractDiaId(h.content)).filter(Boolean);

    // C · BM25 over conv corpus
    const top = bm25.topK(qa.question, TOP_K);
    const diaC = top.map(([idx]) => docDia[idx]).filter(Boolean);

    // D · RRF(A_full, C_full)
    // A and C are already truncated to TOP_K — fine for RRF since gold evidence
    // is single-hop and almost always in top-25 of *some* method.
    const diaD = rrf([diaA, diaC]).slice(0, TOP_K);

    for (const k of [5, 10, 25]) {
      accA[k].push(recallAtK(diaA, evidence, k));
      accB[k].push(recallAtK(diaB, evidence, k));
      accC[k].push(recallAtK(diaC, evidence, k));
      accD[k].push(recallAtK(diaD, evidence, k));
    }
    if (i % 10 === 0) console.log(`  [${sampleId}] ${i}/${cat1.length} qa done`);
  }

  function mean(xs) { const v = xs.filter((x) => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
  const row = {
    conv: sampleId,
    n: cat1.length,
    A_5: mean(accA[5]), A_10: mean(accA[10]), A_25: mean(accA[25]),
    B_5: mean(accB[5]), B_10: mean(accB[10]), B_25: mean(accB[25]),
    C_5: mean(accC[5]), C_10: mean(accC[10]), C_25: mean(accC[25]),
    D_5: mean(accD[5]), D_10: mean(accD[10]), D_25: mean(accD[25]),
  };
  summary.push(row);
}

// -------- print summary table --------------------------------------------

console.log("\n=== cat-1 single-hop recall@k — by method ===");
console.log("conv       n   | A·dense  5/10/25  | B·hybrid 5/10/25  | C·bm25   5/10/25  | D·RRF    5/10/25");
for (const r of summary) {
  const fmt = (a, b, c) => `${(a*100).toFixed(0).padStart(3)}/${(b*100).toFixed(0).padStart(3)}/${(c*100).toFixed(0).padStart(3)}`;
  console.log(
    `${r.conv.padEnd(10)} ${String(r.n).padStart(3)} | ${fmt(r.A_5,r.A_10,r.A_25)}        | ${fmt(r.B_5,r.B_10,r.B_25)}        | ${fmt(r.C_5,r.C_10,r.C_25)}        | ${fmt(r.D_5,r.D_10,r.D_25)}`
  );
}
if (summary.length > 1) {
  const wmean = (key) => summary.reduce((s, r) => s + r[key] * r.n, 0) / summary.reduce((s, r) => s + r.n, 0);
  const fmt = (a, b, c) => `${(a*100).toFixed(0).padStart(3)}/${(b*100).toFixed(0).padStart(3)}/${(c*100).toFixed(0).padStart(3)}`;
  const N = summary.reduce((s, r) => s + r.n, 0);
  console.log(
    `${"WMEAN".padEnd(10)} ${String(N).padStart(3)} | ${fmt(wmean("A_5"),wmean("A_10"),wmean("A_25"))}        | ${fmt(wmean("B_5"),wmean("B_10"),wmean("B_25"))}        | ${fmt(wmean("C_5"),wmean("C_10"),wmean("C_25"))}        | ${fmt(wmean("D_5"),wmean("D_10"),wmean("D_25"))}`
  );
}
