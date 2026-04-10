#!/usr/bin/env node
// vectormemory dashboard — tiny HTTP host + PostgREST proxy.
//
// Why this exists:
//  - The dashboard HTML must be reachable from your phone over Tailscale,
//    not just localhost.
//  - PostgREST stays bound to 127.0.0.1 inside docker (security).
//  - The service_role JWT must not live in the browser. This proxy keeps it
//    server-side and injects it into the upstream call.
//
// Usage:
//   node scripts/dashboard-server.mjs            # binds 0.0.0.0:8787
//   PORT=9000 HOST=100.x.y.z node scripts/...    # custom bind
//
// Open from your phone (Tailscale connected to the same tailnet):
//   http://<mac-name>.<tailnet>.ts.net:8787/
// or http://<tailscale-ipv4>:8787/

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const DASH_DIR   = path.join(ROOT, "dashboard");
const ENV_FILE   = path.join(ROOT, "docker", ".env");

// --- load JWT_SECRET from docker/.env so we can mint a service_role JWT ---
async function loadEnv() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

// Minimal HS256 JWT signer using built-in crypto.
import crypto from "node:crypto";
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

const env  = await loadEnv();
const JWT_SECRET = process.env.JWT_SECRET || env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET not set (looked in docker/.env and process env).");
  process.exit(1);
}
const SERVICE_JWT = signJwt(
  { role: "service_role", iss: "vectormemory-dashboard", iat: Math.floor(Date.now() / 1000) },
  JWT_SECRET
);

const UPSTREAM = process.env.POSTGREST_URL || "http://127.0.0.1:54321";
const PORT     = Number(process.env.PORT || 8787);
const HOST     = process.env.HOST || "0.0.0.0";

// --- static file serving (just the dashboard dir) ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(DASH_DIR, rel);
  // Path traversal guard.
  if (!filePath.startsWith(DASH_DIR)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

// --- proxy /api/* → PostgREST, injecting the service_role JWT ---
async function proxyApi(req, res) {
  const upstreamPath = req.url.replace(/^\/api/, "") || "/";
  const upstreamUrl  = new URL(upstreamPath, UPSTREAM);

  // Buffer request body (POST/PATCH).
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // Forward only the headers PostgREST cares about; strip auth from client.
  const fwdHeaders = {
    "Content-Type": req.headers["content-type"] || "application/json",
    "Authorization": `Bearer ${SERVICE_JWT}`,
    "apikey": SERVICE_JWT,
  };
  const accept = req.headers["accept"];
  if (accept) fwdHeaders["Accept"] = accept;
  const prefer = req.headers["prefer"];
  if (prefer) fwdHeaders["Prefer"] = prefer;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unreachable", detail: String(e?.message || e) }));
  }
}

// --- helpers for /prime and /narrate (auto-priming entry for openClaw) -----

const OLLAMA_URL      = process.env.OLLAMA_URL      || "http://127.0.0.1:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";

async function callRpc(name, body = {}) {
  const r = await fetch(new URL(`/rpc/${name}`, UPSTREAM), {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "Authorization": `Bearer ${SERVICE_JWT}`,
      "apikey":        SERVICE_JWT,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`rpc ${name} failed: HTTP ${r.status}`);
  return r.json();
}

async function embed(text) {
  const r = await fetch(new URL("/api/embed", OLLAMA_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`ollama embed failed: HTTP ${r.status}`);
  const j = await r.json();
  return j.embeddings?.[0];
}

function formatPrime(ctx, taskDesc, taskExperiences, taskMemories) {
  const out = [];
  out.push("# Soul context");
  out.push("");
  const m = ctx.mood || {};
  if (m.n > 0) {
    out.push(`**Mood (${m.window_hours}h):** ${m.label}  (valence ${m.valence.toFixed(2)}, arousal ${m.arousal.toFixed(2)}, ${m.n} episodes)`);
  } else {
    out.push(`**Mood (${m.window_hours ?? 24}h):** neutral  (no recent episodes)`);
  }
  if (ctx.recent_pattern && ctx.recent_pattern.last_n > 0 && ctx.recent_pattern.success_rate != null) {
    out.push(`**Recent pattern:** last ${ctx.recent_pattern.last_n} tasks, ${Math.round(ctx.recent_pattern.success_rate * 100)}% success, avg difficulty ${ctx.recent_pattern.avg_difficulty.toFixed(2)}`);
  }
  if (ctx.top_traits?.length) {
    out.push("");
    out.push("**Who I am right now:**");
    for (const t of ctx.top_traits) {
      const sign = t.polarity > 0.1 ? "+" : t.polarity < -0.1 ? "−" : "·";
      out.push(`- ${sign} ${t.trait}  (evidence ${t.evidence_count})`);
    }
  }
  if (ctx.active_intentions?.length) {
    out.push("");
    out.push("**What I want:**");
    for (const i of ctx.active_intentions) {
      out.push(`- ${i.intention}  (priority ${i.priority.toFixed(2)}, progress ${Math.round(i.progress * 100)}%)`);
    }
  }
  if (ctx.open_conflicts?.length) {
    out.push("");
    out.push("**Inner tensions to be aware of:**");
    for (const c of ctx.open_conflicts.slice(0, 3)) {
      out.push(`- "${c.a_trait}" vs "${c.b_trait}"  (gap ${c.polarity_diff.toFixed(2)})`);
    }
  }
  if (taskDesc) {
    out.push("");
    out.push(`**For the task at hand — "${taskDesc}":**`);
    if (taskExperiences?.length) {
      out.push("");
      out.push("Past experiences that may apply:");
      for (const e of taskExperiences) {
        const tag = e.kind === "lesson" ? "LESSON" : (e.outcome ?? "exp").toUpperCase();
        out.push(`- [${tag}] ${(e.content || "").slice(0, 200)}`);
      }
    }
    if (taskMemories?.length) {
      out.push("");
      out.push("Relevant facts from memory:");
      for (const r of taskMemories) {
        out.push(`- ${(r.content || "").slice(0, 200)}`);
      }
    }
  }
  return out.join("\n");
}

function formatNarrate(n) {
  const out = [];
  const m = n.mood || {};
  if (m.n > 0) {
    out.push(`Right now I feel ${m.label}. In the last ${m.window_hours} hours I lived through ${m.n} episodes; on average their valence was ${m.valence.toFixed(2)} and their arousal ${m.arousal.toFixed(2)}.`);
  } else {
    out.push(`I am quiet — no recent episodes in the last ${m.window_hours ?? 24} hours.`);
  }
  if (n.identity_traits?.length) {
    const tlines = n.identity_traits.slice(0, 5).map(t => {
      const tone = t.polarity > 0.1 ? "I lean toward" : t.polarity < -0.1 ? "I struggle with" : "I notice";
      return `${tone} "${t.trait}"`;
    });
    out.push("");
    out.push("If I had to describe who I am: " + tlines.join("; ") + ".");
  }
  if (n.aspirations?.length) {
    out.push("");
    out.push("What I am reaching for: " + n.aspirations.map(a => `"${a.intention}" (${Math.round(a.progress * 100)}% there)`).join(", ") + ".");
  }
  if (n.recent_lessons?.length) {
    out.push("");
    out.push("Recently I have learned: " + n.recent_lessons.slice(0, 3).map(l => `"${l.lesson}"`).join("; ") + ".");
  }
  if (n.closest_relationships?.length) {
    out.push("");
    out.push("I have lived through the most with " + n.closest_relationships.map(p => `${p.name} (${p.encounter_count} encounters)`).join(", ") + ".");
  }
  if (n.inner_tensions?.length) {
    out.push("");
    out.push("I am holding contradictions: " + n.inner_tensions.map(t => `"${t.a}" vs "${t.b}"`).join("; ") + ".");
  }
  if (n.drift_7d?.drift != null && n.drift_7d.older_n > 0 && n.drift_7d.recent_n > 0) {
    const d = n.drift_7d.drift;
    const verb = d < 0.1 ? "I am stable." : d < 0.3 ? "I am slowly evolving." : "I am moving fast.";
    out.push("");
    out.push(`In the last 7 days my centroid has shifted by ${d.toFixed(3)}. ${verb}`);
  }
  return out.join("\n");
}

async function handlePrime(req, res) {
  try {
    const url  = new URL(req.url, "http://x");
    const task = url.searchParams.get("task") || "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "5", 10) || 5, 10);

    const ctx = await callRpc("prime_context_static");
    let taskExperiences = [], taskMemories = [];
    if (task) {
      try {
        const v = await embed(task);
        const [exps, mems] = await Promise.all([
          callRpc("recall_experiences", { query_embedding: v, query_text: task, match_count: limit, include_lessons: true }).catch(() => []),
          callRpc("match_memories_cognitive", { query_embedding: v, query_text: task, match_count: limit, vector_weight: 0.6, include_archived: false }).catch(() => []),
        ]);
        taskExperiences = exps;
        taskMemories    = mems;
      } catch (e) {
        // If Ollama is unreachable, just return the static block.
        console.error("prime: embed failed, returning static only:", e.message);
      }
    }
    const text = formatPrime(ctx, task, taskExperiences, taskMemories);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("prime failed: " + (e?.message || e));
  }
}

async function handleNarrate(_req, res) {
  try {
    const n = await callRpc("narrate_self");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(formatNarrate(n));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("narrate failed: " + (e?.message || e));
  }
}

const server = http.createServer((req, res) => {
  // Tiny access log.
  const t = new Date().toISOString();
  res.on("finish", () => console.log(`${t} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${res.statusCode}`));

  if (req.url.startsWith("/api/")) return proxyApi(req, res);
  if (req.url === "/prime" || req.url.startsWith("/prime?")) return handlePrime(req, res);
  if (req.url === "/narrate") return handleNarrate(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end("method not allowed"); return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`vectormemory dashboard listening on http://${HOST}:${PORT}`);
  console.log(`upstream PostgREST: ${UPSTREAM}`);
  console.log(`open from your phone over Tailscale and head to port ${PORT}`);
});
