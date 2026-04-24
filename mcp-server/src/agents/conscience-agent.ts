import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { Agent, AgentEventBus, BusEvent } from "./event-bus.js";

/**
 * ConscienceAgent
 * ----------------
 * Subscribes to `created` events. For each new memory it asks Qwen (via the
 * local OpenClaw gateway) whether the new content contradicts anything already
 * known. If yes, it:
 *   1. logs a `conscience_warning` event on the new memory
 *   2. chains `new --contradicts--> old` into memory_relations
 *
 * Why go through the gateway instead of a second Ollama:
 *   The host already runs one Qwen model (M4/16GB is tight). The gateway
 *   multiplexes provider calls and gives us a uniform auth/rate-limit story.
 *
 * Rate-limiting: max 1 concurrent gateway call, per-memory de-dupe (Set of
 * processed ids capped at 5k), skip re-running on cold-start replays.
 *
 * The gateway call uses the `openclaw agent --agent main --json` subprocess.
 * The WebSocket path is more efficient but requires handshake + request/response
 * matching; for a low-volume background check (a few memories per minute at
 * peak) the subprocess cost is acceptable.
 */

interface ConscienceVerdict {
  contradicts_id?:   string | null;
  confidence?:       number;       // 0..1
  reason?:           string;
}

export interface ConscienceOptions {
  agentId?:       string;          // openclaw agent id, default "main"
  topK?:          number;          // neighbours to compare against
  timeoutSec?:    number;          // gateway timeout per call
  minConfidence?: number;          // verdicts below this are ignored
  thinking?:      "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  openclawBin?:   string;          // override path to CLI
}

export class ConscienceAgent implements Agent {
  readonly name = "conscience";
  readonly subscribedEvents = ["created"];

  private db: PostgrestClient;
  private processed = new Set<string>();
  private inFlight = false;
  private opts: Required<ConscienceOptions>;

  constructor(supabaseUrl: string, supabaseKey: string, opts: ConscienceOptions = {}) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.opts = {
      agentId:       opts.agentId       ?? "main",
      topK:          opts.topK          ?? 3,
      timeoutSec:    opts.timeoutSec    ?? 30,
      minConfidence: opts.minConfidence ?? 0.6,
      thinking:      opts.thinking      ?? "low",
      openclawBin:   opts.openclawBin   ?? "openclaw",
    };
  }

  async handle(event: BusEvent, bus: AgentEventBus): Promise<void> {
    if (!event.memory_id) return;
    if (this.processed.has(event.memory_id)) return;
    if (this.inFlight) return; // drop; next tick will re-queue via cursor? NO — cursor advances. So we just skip.

    this.processed.add(event.memory_id);
    if (this.processed.size > 5000) {
      const arr = [...this.processed];
      this.processed = new Set(arr.slice(arr.length - 2500));
    }

    this.inFlight = true;
    try {
      await this.checkOne(event.memory_id, bus);
    } catch (err) {
      console.error(`[conscience] ${event.memory_id.slice(0, 8)} failed:`,
        err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
    }
  }

  private async checkOne(memoryId: string, bus: AgentEventBus): Promise<void> {
    // 1) load the new memory
    const { data: memRows, error: memErr } = await this.db
      .from("memories")
      .select("id,content,category,tags,stage,embedding")
      .eq("id", memoryId)
      .limit(1);
    if (memErr || !memRows || memRows.length === 0) return;
    const mem = memRows[0] as { id: string; content: string; category: string; tags: string[]; embedding: number[] | null };
    if (!mem.content || mem.content.length < 20) return;   // skip trivial
    if (!mem.embedding) return;                             // need embedding for neighbour search

    // 2) find top-K semantically similar *older* memories, excluding self.
    //    We reuse the existing hybrid search via RPC.
    const { data: neighs, error: nErr } = await this.db.rpc("match_memories_cognitive", {
      query_embedding: mem.embedding,
      query_text:      mem.content.slice(0, 400),
      match_count:     this.opts.topK + 1,
      vector_weight:   0.7,
      include_archived: false,
    });
    if (nErr) {
      console.error(`[conscience] neighbour search error: ${nErr.message ?? nErr}`);
      return;
    }
    const candidates = ((neighs ?? []) as Array<{ id: string; content: string; category: string }>)
      .filter(n => n.id !== memoryId)
      .slice(0, this.opts.topK);
    if (candidates.length === 0) return;

    // 3) ask the gateway for a verdict
    const verdict = await this.callGateway(mem, candidates);
    if (!verdict || !verdict.contradicts_id) return;
    if ((verdict.confidence ?? 0) < this.opts.minConfidence) return;
    if (!candidates.some(c => c.id === verdict.contradicts_id)) {
      // model hallucinated an id — ignore
      return;
    }

    // 4) log warning event + chain relation.
    //    Two events share one trace_id so a future "contradiction_resolved"
    //    event can correlate back. `conscience_warning` is the human-readable
    //    surface; `contradiction_detected` is the observable counted by the
    //    frustration term of compute_affect() — see docs/affect-observables.md.
    const reason = (verdict.reason ?? "").slice(0, 500);
    const traceId = randomUUID();
    const payload = {
      contradicts_id: verdict.contradicts_id,
      confidence:     verdict.confidence,
      reason,
    };
    await bus.emit(mem.id, "conscience_warning",    this.name, payload, traceId);
    await bus.emit(mem.id, "contradiction_detected", this.name, payload, traceId);
    const { error: chainErr } = await this.db.rpc("chain_memories", {
      p_a_id:   mem.id,
      p_b_id:   verdict.contradicts_id,
      p_type:   "contradicts",
      p_reason: reason,
      p_weight: verdict.confidence ?? 0.7,
    });
    if (chainErr) {
      console.error(`[conscience] chain failed: ${chainErr.message ?? chainErr}`);
    } else {
      console.error(`[conscience] ${mem.id.slice(0,8)} ⚠ contradicts ${verdict.contradicts_id.slice(0,8)}  (conf=${verdict.confidence?.toFixed(2)})`);
    }
  }

  private async callGateway(
    mem:        { id: string; content: string; category: string; tags: string[] },
    candidates: Array<{ id: string; content: string; category: string }>,
  ): Promise<ConscienceVerdict | null> {
    const prompt = buildPrompt(mem, candidates);
    const stdout = await runOpenClawAgent({
      bin:        this.opts.openclawBin,
      agentId:    this.opts.agentId,
      message:    prompt,
      timeoutSec: this.opts.timeoutSec,
      thinking:   this.opts.thinking,
    });
    if (!stdout) return null;
    return parseVerdict(stdout, candidates);
  }
}

// ---------------------------------------------------------------------------
// prompt construction + verdict parsing
// ---------------------------------------------------------------------------
function buildPrompt(
  mem: { id: string; content: string; category: string; tags: string[] },
  candidates: Array<{ id: string; content: string; category: string }>,
): string {
  const tagLine = (mem.tags ?? []).length ? ` (tags: ${mem.tags.join(", ")})` : "";
  const nList = candidates.map((c, i) =>
    `[${i + 1}] id=${c.id} (${c.category})\n${c.content.slice(0, 400)}`
  ).join("\n\n");
  return [
    "You are a consistency-check agent for a memory system. A NEW memory has just been stored.",
    "Your job: does the new memory CONTRADICT any of the existing candidate memories? Not merely different — a direct contradiction (same subject, mutually exclusive claim).",
    "",
    `NEW MEMORY (category=${mem.category}${tagLine}):`,
    mem.content.slice(0, 800),
    "",
    "EXISTING CANDIDATES:",
    nList,
    "",
    "Respond with a single compact JSON object and nothing else. Schema:",
    '{"contradicts_id": "<uuid of the contradicted candidate OR null>", "confidence": <0..1>, "reason": "<one sentence why, or empty>"}',
    "",
    "If there is no contradiction, use contradicts_id=null and confidence=0. Do not invent ids; only pick from the candidate ids above.",
  ].join("\n");
}

function parseVerdict(
  raw: string,
  candidates: Array<{ id: string }>,
): ConscienceVerdict | null {
  // Try to pull the first JSON object out of the text.
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const id = typeof p.contradicts_id === "string" ? p.contradicts_id : null;
  const conf = typeof p.confidence === "number" ? p.confidence : 0;
  const reason = typeof p.reason === "string" ? p.reason : "";
  if (!id) return { contradicts_id: null, confidence: 0, reason };
  if (!candidates.some(c => c.id === id)) return { contradicts_id: null, confidence: 0, reason };
  return { contradicts_id: id, confidence: conf, reason };
}

// ---------------------------------------------------------------------------
// subprocess runner for `openclaw agent --agent <id> --json --message <m>`
// ---------------------------------------------------------------------------
function runOpenClawAgent(args: {
  bin:        string;
  agentId:    string;
  message:    string;
  timeoutSec: number;
  thinking:   string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(args.bin, [
      "agent",
      "--agent",    args.agentId,
      "--json",
      "--thinking", args.thinking,
      "--timeout",  String(args.timeoutSec),
      "--message",  args.message,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "", err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      console.error(`[conscience] gateway timeout after ${args.timeoutSec}s`);
      resolve(null);
    }, (args.timeoutSec + 5) * 1000);

    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[conscience] openclaw exited ${code}: ${err.slice(0, 200)}`);
        resolve(null);
        return;
      }
      // openclaw agent --json prints a JSON object; we want the assistant message text.
      resolve(extractAssistantText(out));
    });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.error(`[conscience] spawn error: ${e.message}`);
      resolve(null);
    });
  });
}

function extractAssistantText(stdout: string): string {
  // The `openclaw agent --json` wrapper prints a few stderr-ish lines
  // (plugins, push-notifications) before the real JSON body, so we have to
  // locate the first balanced JSON object rather than JSON.parse the whole
  // stdout. The canonical response shape is
  //   { runId, status, summary, result: { payloads: [{ text }], meta } }
  // so we drill into result.payloads[*].text first. If the shape changes,
  // fall back to a list of likely keys, then to raw stdout.
  const body = sliceFirstJsonObject(stdout);
  if (!body) return stdout.trim();
  let j: unknown;
  try { j = JSON.parse(body); } catch { return body; }
  if (typeof j === "string") return j;
  if (!j || typeof j !== "object") return body;
  const obj = j as Record<string, unknown>;

  // openclaw result.payloads[*].text
  const result = obj.result as Record<string, unknown> | undefined;
  const payloads = result?.payloads as Array<{ text?: unknown }> | undefined;
  if (Array.isArray(payloads)) {
    const joined = payloads
      .map(p => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  const candidates: unknown[] = [
    obj.assistant_text, obj.text, obj.reply, obj.message, obj.output, obj.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return body;
}

function sliceFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc)       esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"')  inStr = false;
      continue;
    }
    if (ch === '"')       inStr = true;
    else if (ch === "{")  depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
