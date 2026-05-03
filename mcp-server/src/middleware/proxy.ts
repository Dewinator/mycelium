/**
 * Mycelium small-model middleware — Phase 1 reverse-proxy.
 * Issue #2 (N2 of the small-model-middleware epic).
 *
 * Architecture decisions (made unilaterally 2026-04-27, documentable in PR):
 *
 * - **Reverse-proxy, not openClaw plugin.** Per the issue body. Model-agnostic,
 *   testable against any LLM endpoint that speaks Ollama's `/api/chat` shape.
 * - **Phase 1: Ollama-only.** The local-model use case is the whole point of
 *   the small-model epic. Anthropic/OpenAI compatibility is Phase 2 — adds
 *   an extra adapter layer for `/v1/messages` / `/v1/chat/completions`.
 * - **Phase 1: stream:false enforced.** SSE streaming through an injection
 *   layer is non-trivial (the model emits before we'd see it) and would
 *   delay landing the keystone. Streaming lands as Phase 1.5.
 * - **Inject as a prepended system message** with a sentinel marker, not by
 *   mutating an existing system. Idempotent across repeat forwards. See
 *   inject.ts §strategy choices.
 * - **Best-effort prime fetch.** If Supabase / Ollama-embed is unreachable,
 *   we forward the request without injection rather than returning 5xx.
 * - **No auth in this layer.** Bearer tokens (if present) flow through
 *   transparently. mycelium runs on localhost; production deployment is
 *   out of scope for this skeleton.
 * - **Auto-Digest is active.** Idle-30min trigger via SessionTracker.reapIdle()
 *   on a periodic tick. Disable with `MYCELIUM_PROXY_AUTO_DIGEST=0`. Issue #4
 *   landed (N4 + N9).
 *
 * Default config:
 *   MYCELIUM_PROXY_PORT  = 18794   (1879x family, next free after motivation)
 *   OLLAMA_URL           = http://127.0.0.1:11434
 *   SUPABASE_URL/KEY     = inherit from MCP server env
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { PrimeFetcher } from "./prime-fetcher.js";
import { Absorber } from "./absorber.js";
import { SessionTracker } from "./session-tracker.js";
import { Digester } from "./digester.js";
import { injectContext, lastUserText, type ChatMessage } from "./inject.js";
import { createEmbeddingProvider } from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// docker/.env bootstrap — same pattern as scripts/dashboard-server.mjs.
// Lets the middleware run as a LaunchAgent / systemd unit without requiring
// the operator to copy the service-role JWT into a plist.
// process.env still wins over .env values when both are present.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..", "..", "..");
const ENV_FILE  = path.join(ROOT, "docker", ".env");

async function loadDotenv(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mint a service-role JWT from JWT_SECRET, mirroring dashboard-server.mjs. */
function signServiceRoleJwt(secret: string): string {
  const header  = { alg: "HS256", typ: "JWT" };
  const payload = { role: "service_role", iss: "supabase", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

const dotenv = await loadDotenv(ENV_FILE);
function envOr(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? dotenv[name] ?? fallback;
}

interface OllamaChatRequest {
  model:    string;
  messages: ChatMessage[];
  stream?:  boolean;
  // pass-through fields we don't touch:
  options?: Record<string, unknown>;
  format?:  string | object;
  keep_alive?: string | number;
  tools?:   unknown[];
}

const PROXY_PORT   = Number(envOr("MYCELIUM_PROXY_PORT", "18794"));
const OLLAMA_URL   = envOr("OLLAMA_URL", "http://127.0.0.1:11434")!;
const RECALL_LIMIT = Number(envOr("MYCELIUM_PROXY_RECALL_LIMIT", "5"));

// SUPABASE_URL is straightforward; SUPABASE_KEY can come from three places
// in priority order: explicit env, explicit dotenv, or self-minted from
// JWT_SECRET (the LaunchAgent path — operator only has to put JWT_SECRET in
// docker/.env, which is already there for the dashboard).
const SUPABASE_URL = envOr("SUPABASE_URL", "http://127.0.0.1:54321")!;
let SUPABASE_KEY = envOr("SUPABASE_KEY") ?? envOr("SUPABASE_ANON_KEY");
if (!SUPABASE_KEY) {
  const secret = envOr("JWT_SECRET");
  if (secret) {
    SUPABASE_KEY = signServiceRoleJwt(secret);
    console.error("[middleware] minted SUPABASE_KEY from JWT_SECRET in docker/.env");
  }
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[middleware] FATAL: SUPABASE_URL + SUPABASE_KEY (or JWT_SECRET) must be set in env or docker/.env");
  process.exit(1);
}

const EMBED_MODEL = envOr("EMBEDDING_MODEL", "nomic-embed-text")!;

// Shared embedding provider — picks Ollama (default) or llama-cpp via
// MYCELIUM_LLM_PROVIDER. Wiring it here lets the middleware respect the
// native-app provider switch (issue #178) without each class re-implementing
// the env-driven selection. The bound `embed` callback also gives us
// `sampleForEmbedding` (head+middle+tail truncation) for free on long
// auto-absorbed texts that the previous direct-fetch path silently
// truncated from the end.
const embeddingProvider = createEmbeddingProvider();
const sharedEmbed = (text: string) => embeddingProvider.embed(text);

const fetcher = new PrimeFetcher({
  supabaseUrl:    SUPABASE_URL,
  supabaseKey:    SUPABASE_KEY,
  ollamaUrl:      OLLAMA_URL,
  embeddingModel: EMBED_MODEL,
  embed:          sharedEmbed,
  recallLimit:    RECALL_LIMIT,
});

// Auto-Absorb post-processor (#4 partial — N4-Auto-Absorb only).
// Set MYCELIUM_PROXY_AUTO_ABSORB=0 to disable. Default ON because the
// whole point of the small-model epic is to capture learning the user
// would otherwise have to enter manually with `remember`.
const AUTO_ABSORB_ON = (envOr("MYCELIUM_PROXY_AUTO_ABSORB", "1") ?? "1") !== "0";
const absorber = AUTO_ABSORB_ON ? new Absorber({
  supabaseUrl:    SUPABASE_URL,
  supabaseKey:    SUPABASE_KEY,
  ollamaUrl:      OLLAMA_URL,
  embeddingModel: EMBED_MODEL,
  embed:          sharedEmbed,
}) : null;

// Auto-Digest (#4 + N9 spec). Per-session state, idle-30min trigger.
// MYCELIUM_PROXY_AUTO_DIGEST=0 disables; default on. Tick frequency
// configurable via MYCELIUM_PROXY_DIGEST_TICK_MS (default 60s).
const AUTO_DIGEST_ON = (envOr("MYCELIUM_PROXY_AUTO_DIGEST", "1") ?? "1") !== "0";
const IDLE_MS    = Number(envOr("MYCELIUM_PROXY_IDLE_MS",         String(30 * 60 * 1_000)));
const TICK_MS    = Number(envOr("MYCELIUM_PROXY_DIGEST_TICK_MS",  String(60_000)));

const tracker = new SessionTracker({ idleMs: IDLE_MS });
const digester = AUTO_DIGEST_ON ? new Digester(tracker, {
  supabaseUrl:    SUPABASE_URL,
  supabaseKey:    SUPABASE_KEY,
  ollamaUrl:      OLLAMA_URL,
  embeddingModel: EMBED_MODEL,
  embed:          sharedEmbed,
  tickMs:         TICK_MS,
}) : null;
digester?.start();

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type":   "application/json; charset=utf-8",
    "Content-Length": String(buf.length),
    "Cache-Control":  "no-store",
  });
  res.end(buf);
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: OllamaChatRequest;
  try {
    parsed = JSON.parse(raw) as OllamaChatRequest;
  } catch (e) {
    return jsonResponse(res, 400, { error: "invalid_json", detail: String(e) });
  }
  if (!Array.isArray(parsed.messages)) {
    return jsonResponse(res, 400, { error: "messages must be an array" });
  }

  // Phase 1: enforce non-streaming. Streaming with mid-flight injection is
  // Phase 1.5 (SSE rewriter on top of fetch().body).
  if (parsed.stream === true) {
    return jsonResponse(res, 400, {
      error: "streaming_not_supported_yet",
      hint:  "set stream:false; SSE pass-through is Phase 1.5",
    });
  }
  parsed.stream = false;

  // Optional task_type via header (the chat protocol has no slot for it).
  const taskType = (req.headers["x-mycelium-task-type"] as string | undefined)?.trim() || undefined;

  const taskText = lastUserText(parsed.messages);

  // N4 Auto-Digest — touch session BEFORE fetch so a session is tracked
  // even when the prime fetcher fails or the upstream is dead.
  const clientKey = SessionTracker.buildKey(
    req.socket.remoteAddress,
    req.headers["user-agent"] as string | undefined,
  );
  tracker.touch({
    client_key:   clientKey,
    model:        parsed.model,
    user_present: Boolean(taskText),
  });

  // Diff cache hit count before/after to detect whether THIS call landed in
  // the cache. Cheaper than threading an "isHit" flag through the fetcher.
  const cacheBefore = fetcher.cacheStats()?.hits ?? 0;
  const contextText = await fetcher.buildAndFormat(taskText, taskType);
  const cacheAfter  = fetcher.cacheStats()?.hits ?? 0;
  const cacheHit    = cacheAfter > cacheBefore;

  const injectedMessages = injectContext(parsed.messages, contextText);
  const upstreamBody = JSON.stringify({ ...parsed, messages: injectedMessages });

  // Forward to Ollama
  const upstreamUrl = new URL("/api/chat", OLLAMA_URL);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    upstreamBody,
    });
  } catch (e) {
    return jsonResponse(res, 502, {
      error:  "upstream_unreachable",
      target: String(upstreamUrl),
      detail: String(e),
    });
  }

  // N4 (Auto-Absorb): conservative regex extractor over user + assistant
  // text. Best-effort, fired in the background — must not delay the
  // response.
  const ct = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
  const buf = Buffer.from(await upstream.arrayBuffer());

  // Update session state with the upstream outcome.
  tracker.touch({
    client_key:   clientKey,
    model:        parsed.model,
    upstream_ok:  upstream.status >= 200 && upstream.status < 300,
  });

  if (absorber) {
    const assistantText = extractAssistantText(buf, ct);
    void absorber.processTurn(taskText, assistantText)
      .catch((e) => console.error("[middleware] auto-absorb threw:",
        e instanceof Error ? e.message : String(e)));
  }

  res.writeHead(upstream.status, {
    "Content-Type":              ct,
    "Content-Length":            String(buf.length),
    "Cache-Control":             "no-store",
    "X-Mycelium-Injected":       contextText ? "1" : "0",
    "X-Mycelium-Injected-Bytes": contextText ? String(Buffer.byteLength(contextText, "utf8")) : "0",
    "X-Mycelium-Cache":           cacheHit ? "hit" : "miss",
  });
  res.end(buf);
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Health includes the upstream targets so an operator can curl one URL to
  // diagnose a wedge.
  const checks = await Promise.all([
    fetch(new URL("/api/version", OLLAMA_URL))
      .then((r) => ({ ollama: r.ok ? "ok" : `http_${r.status}` }))
      .catch((e) => ({ ollama: `unreachable: ${String(e)}` })),
    fetch(new URL("/", SUPABASE_URL!))
      .then((r) => ({ supabase: r.ok ? "ok" : `http_${r.status}` }))
      .catch((e) => ({ supabase: `unreachable: ${String(e)}` })),
  ]);
  jsonResponse(res, 200, {
    status: "ok",
    proxy_port: PROXY_PORT,
    targets: { ollama: OLLAMA_URL, supabase: SUPABASE_URL },
    upstreams: Object.assign({}, ...checks),
    cache: fetcher.cacheStats(),
    auto_absorb: absorber ? absorber.stats() : { enabled: false },
    auto_digest: digester ? {
      enabled:  true,
      idle_ms:  IDLE_MS,
      tick_ms:  TICK_MS,
      sessions: tracker.size(),
      ...digester.stats(),
    } : { enabled: false },
    phase: 1,
  });
}

const server = http.createServer((req, res) => {
  // Same routes Ollama exposes (so existing clients can swap host without
  // touching their request shape) — plus /health for ops.
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/api/chat") return void handleChat(req, res);
  if (req.method === "GET"  && url === "/health")   return void handleHealth(req, res);
  // Pass-through for any other Ollama route — e.g. /api/tags, /api/version,
  // /api/embed (mycelium itself uses /api/embed). No injection on those.
  if (url.startsWith("/api/")) {
    void passThrough(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/**
 * Pull the assistant message text out of an Ollama /api/chat response. The
 * shape is {message: {role, content}, ...}. Returns undefined when the body
 * isn't JSON or doesn't carry the field — auto-absorb then runs on user
 * text only.
 */
function extractAssistantText(buf: Buffer, contentType: string): string | undefined {
  if (!contentType.includes("application/json")) return undefined;
  try {
    const j = JSON.parse(buf.toString("utf8")) as { message?: { role?: string; content?: string } };
    if (j.message?.role === "assistant" && typeof j.message.content === "string") {
      return j.message.content;
    }
  } catch { /* best-effort */ }
  return undefined;
}

async function passThrough(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const upstreamUrl = new URL(req.url ?? "/", OLLAMA_URL);
  let upstream: Response;
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    delete headers.host;
    delete headers["content-length"];
    const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req);
    upstream = await fetch(upstreamUrl, { method: req.method ?? "GET", headers, body });
  } catch (e) {
    return jsonResponse(res, 502, { error: "upstream_unreachable", detail: String(e) });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(upstream.status, { "Content-Type": ct, "Content-Length": String(buf.length) });
  res.end(buf);
}

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.error(`mycelium middleware (Phase 1) listening on http://127.0.0.1:${PROXY_PORT}`);
  console.error(`  → forwards /api/chat to ${OLLAMA_URL}/api/chat with prime_context_compact injected`);
  console.error(`  → recall_limit=${RECALL_LIMIT}, supabase=${SUPABASE_URL}`);
  console.error(`  → health check: curl http://127.0.0.1:${PROXY_PORT}/health`);
});

process.on("SIGTERM", () => { digester?.stop(); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { digester?.stop(); server.close(() => process.exit(0)); });
