// Shared helpers for the LoCoMo evaluation pipeline.
// Loads env from ../../.mcp.json, wires Ollama + PostgrestClient.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const EXP_ROOT = __dirname;
export const DATASET_PATH = path.resolve(__dirname, "dataset/data/locomo10.json");
export const OUT_ROOT = path.resolve(__dirname, "out");

const mcpCfg = JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, ".mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
for (const k of Object.keys(env)) process.env[k] ||= env[k];

const DIST = path.resolve(REPO_ROOT, "mcp-server/dist");
export const { MemoryService }           = await import(path.join(DIST, "services/supabase.js"));
export const { ProjectService }          = await import(path.join(DIST, "services/projects.js"));
export const { createEmbeddingProvider } = await import(path.join(DIST, "services/embeddings.js"));

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

export async function loadDataset() {
  return JSON.parse(await fs.readFile(DATASET_PATH, "utf8"));
}

export function findSample(dataset, sampleId) {
  const s = dataset.find((x) => x.sample_id === sampleId);
  if (!s) {
    const ids = dataset.map((x) => x.sample_id).join(", ");
    throw new Error(`sample_id "${sampleId}" not found. Available: ${ids}`);
  }
  return s;
}

export function listSampleIds(dataset) {
  return dataset.map((x) => x.sample_id);
}

// Unique slug for a per-conversation project — used to scope memories.
export function projectSlugFor(sampleId) {
  return `locomo-${sampleId}`.toLowerCase();
}

// Walk a conversation's sessions in chronological order, yielding turns
// enriched with session number and a parsed timestamp.
export function* iterTurns(sample) {
  const conv = sample.conversation;
  const sessionKeys = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
  for (const key of sessionKeys) {
    const sessionNum = Number(key.split("_")[1]);
    const dt = conv[`${key}_date_time`] || null;
    const turns = conv[key] || [];
    for (const turn of turns) {
      yield { sessionNum, dateTime: dt, turn };
    }
  }
}

// Render a turn as a stable, unique memory content line.
// The dia_id prefix forces uniqueness so the embedding-dedup never collapses
// short turns ("Yeah.", "Sure.") into one row.
export function renderTurnContent({ turn, sessionNum, dateTime }) {
  const dia = turn.dia_id || `D${sessionNum}:?`;
  const speaker = turn.speaker || "?";
  let text = (turn.text || "").trim();
  if (turn.blip_caption) text += ` [image: ${turn.blip_caption}]`;
  const ts = dateTime ? ` @${dateTime}` : "";
  return `[${dia} ${speaker}${ts}] ${text}`;
}

// Direct INSERT into memories — bypasses MemoryService.create() to avoid
// the 0.92-cosine dedup, which would silently drop near-identical turns.
export async function insertMemoryDirect(memSvc, row) {
  const { data, error } = await memSvc.db
    .from("memories")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`insert memory: ${error.message || JSON.stringify(error)}`);
  return data.id;
}

// Claude CLI subprocess wrapper — uses the user's authenticated Claude Code
// session (Pro/Max OAuth), no API key needed. Each call is a fresh process,
// stateless. Cold-start ~2-3 s + model time.
import { spawn } from "node:child_process";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function claudeCliChatOnce({ model, system, user, maxTurns, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--model", model,
      "--max-turns", String(maxTurns),
    ];
    if (system) args.push("--system-prompt", system);
    args.push(user);
    const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 200)}`));
      else resolve(out.trim());
    });
    proc.on("error", (e) => { clearTimeout(killer); reject(e); });
  });
}

export async function claudeCliChat({ model, system, user, maxTurns = 1, timeoutMs = 120000, retries = 3, backoffMs = 15000 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = await claudeCliChatOnce({ model, system, user, maxTurns, timeoutMs });
      if (!out || !out.trim()) throw new Error("claude CLI returned empty output");
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = backoffMs * Math.pow(2, attempt);
        console.warn(`[claudeCliChat] attempt ${attempt + 1}/${retries + 1} failed: ${e.message} — retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// Minimal Ollama chat wrapper.
export async function ollamaChat({ model, messages, num_predict = 256, temperature = 0 }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { num_predict, temperature },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ollama ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.message?.content ?? "";
}

export async function readJSON(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

export async function writeJSON(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2));
}

export async function appendJSONL(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(obj) + "\n");
}

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.slice(2).split("=");
    out[k] = rest.length ? rest.join("=") : true;
  }
  return out;
}

// ── BM25 + RRF retrieval utilities ───────────────────────────────────────────

const _STOP = new Set(
  "a an the and or of in on at to for with from by is are was were be been being have has had do does did this that these those it its as i you he she we they me him her us them my your his our their"
    .split(" ")
);

export function tokenizeBM25(s) {
  return s
    .toLowerCase()
    .replace(/\[d\d+:[^\]]*\]/g, " ") // strip [DIA-ID …] prefix
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !_STOP.has(t));
}

export class BM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map(tokenizeBM25);
    this.N = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.length, 0) / (this.N || 1);
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
      s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgdl)));
    }
    return s;
  }
  topK(query, k) {
    const q = tokenizeBM25(query);
    return this.docs
      .map((_, i) => [i, this.score(q, i)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }
}

// Reciprocal Rank Fusion over arrays of content strings (best-first order).
export function rrfMerge(rankings, k = 60) {
  const score = new Map();
  for (const rank of rankings) {
    rank.forEach((id, idx) => {
      score.set(id, (score.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
