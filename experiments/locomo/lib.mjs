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
export async function claudeCliChat({ model, system, user, maxTurns = 1, timeoutMs = 120000 }) {
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
