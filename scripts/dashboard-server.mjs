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
import https from "node:https";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Federation TLS helpers — only loaded when MYCELIUM_FEATURE_FEDERATION=1.
// Refocus 2026-04-26 moved tls-host.mjs to scripts/deferred/lib/, so the
// static import broke the dashboard for everyone else. Loaded lazily below.
let ensureHostCert, peerPubkeyFromCert, peerCertFingerprint;

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const DASH_DIR   = path.join(ROOT, "dashboard");
const ENV_FILE   = path.join(ROOT, "docker", ".env");

// FederationService lives in the compiled MCP server. We import it at runtime
// so the dashboard and the MCP server share the same crypto logic.
// Federation is deferred (CLAUDE.md roadmap step 5) — federation.js is no
// longer produced by the build. Load lazily only when MYCELIUM_FEATURE_FEDERATION=1
// so the dashboard still boots in the default no-federation mode.
const FED_DIST   = path.join(ROOT, "mcp-server", "dist", "services");
let FederationService = null;
let FedGuardService = null;
if (process.env.MYCELIUM_FEATURE_FEDERATION === "1") {
  try {
    ({ FederationService } = await import(path.join(FED_DIST, "federation.js")));
    ({ GuardService: FedGuardService } = await import(path.join(FED_DIST, "guard.js")));
  } catch (err) {
    console.error("federation imports failed — feature flag set but dist missing:", err.message);
    FederationService = null;
    FedGuardService = null;
  }
}

// Swarm Phase 3c (issue #87): /.well-known/mycelium-node handler + node
// identity adapter both live in the compiled MCP server tree so they share
// signing primitives with the rest of the swarm code path.
const { NodeIdentityService } = await import(path.join(FED_DIST, "node-identity.js"));
const SWARM_ENDPOINTS_DIST = path.join(ROOT, "mcp-server", "dist", "swarm", "endpoints");
const { buildNodeAdvertisementResponse } = await import(
  path.join(SWARM_ENDPOINTS_DIST, "node-advertisement.js")
);
// Swarm sub-phase 4e (issue #105): GET /swarm/lessons/{id}/proof. The
// handler module shipped in PR #128 but never got wired into an HTTP host,
// so the endpoint was unreachable. Wiring it here closes that gap.
const { buildLessonProofResponse } = await import(
  path.join(SWARM_ENDPOINTS_DIST, "lesson-proof.js")
);
// Swarm sub-phase 4j (issue #138): POST /swarm/lessons admission pipeline.
// Mirrors the #128 → #152 substrate-then-wiring split — PR #154 shipped the
// pure handler with 19 contract tests; this wiring mounts it on the HTTP
// host so a peer can actually post a Lesson envelope.
const { admitSwarmLesson } = await import(
  path.join(SWARM_ENDPOINTS_DIST, "lesson-admission.js")
);

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

const UPSTREAM   = process.env.POSTGREST_URL   || "http://127.0.0.1:54321";
const BELIEF     = process.env.BELIEF_URL      || "http://127.0.0.1:18790";
const MOTIVATION = process.env.MOTIVATION_URL  || "http://127.0.0.1:18792";
const GUARD      = process.env.GUARD_URL       || "http://127.0.0.1:18793";
const PORT       = Number(process.env.PORT || 8787);
const HOST       = process.env.HOST || "0.0.0.0";

// --- feature flags (Reed 2026-04-26 product pivot) ---------------------------
// These four feature areas are kept in the codebase but hidden from the user
// surface until the neurochemistry / memory core is settled. Routes return 410
// Gone when disabled. Flip the env to true to re-enable a single area.
const FEATURE = {
  pairing:    process.env.MYCELIUM_FEATURE_PAIRING    === "1",
  population: process.env.MYCELIUM_FEATURE_POPULATION === "1",
  federation: process.env.MYCELIUM_FEATURE_FEDERATION === "1",
  teacher:    process.env.MYCELIUM_FEATURE_TEACHER    === "1",
};
function deferred(res, name) {
  res.writeHead(410, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "feature_deferred", feature: name }));
}

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
  // If the path has no extension (e.g. /setup), try the .html sibling.
  // This keeps URLs clean (/setup) without the legacy file dance.
  const candidates = path.extname(filePath) ? [filePath] : [filePath, `${filePath}.html`];
  for (const candidate of candidates) {
    try {
      const data = await fs.readFile(candidate);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(candidate)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
      return;
    } catch { /* try next candidate */ }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
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

// PostgREST direct-table GET — used by /swarm-overview to read Phase 4
// substrate tables that don't (yet) have a dedicated RPC. Path is the part
// after /, e.g. "swarm_lessons?select=...&order=...".
async function pgGet(path) {
  const r = await fetch(new URL(`/${path}`, UPSTREAM), {
    method: "GET",
    headers: {
      "Accept":        "application/json",
      "Authorization": `Bearer ${SERVICE_JWT}`,
      "apikey":        SERVICE_JWT,
    },
  });
  if (!r.ok) throw new Error(`postgrest GET /${path} failed: HTTP ${r.status}`);
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

// --- /skills and /causal — learning-layer panels ---------------------------
async function handleSkills(_req, res) {
  try {
    const stats = await callRpc("skill_stats");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(stats));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "skill_stats failed", detail: String(e?.message || e) }));
  }
}

async function handleCausal(_req, res) {
  // Latest 20 causal edges joined with both experiences' summaries so the
  // dashboard can render a human-readable list.
  try {
    const r = await fetch(
      new URL("/experience_causes?select=id,relation,confidence,evidence_count,source,created_at,cause:cause_id(id,summary,outcome),effect:effect_id(id,summary,outcome)&order=last_reinforced_at.desc&limit=20", UPSTREAM),
      { headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" } }
    );
    const body = await r.text();
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "causal fetch failed", detail: String(e?.message || e) }));
  }
}

// --- /affect and /belief/* — regulator + active-inference panels ----------
async function handleAffect(_req, res) {
  try {
    const state = await callRpc("affect_get");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(state));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "affect_get failed", detail: String(e?.message || e) }));
  }
}

// /affect/history?hours=72&bucket=60 → time-series + per-trigger breakdown
// for the issue #11 phase-10 tuning surface (mig 064).
async function handleAffectHistory(req, res) {
  try {
    const u = new URL(req.url, "http://x");
    const hours = clampInt(u.searchParams.get("hours"), 1, 720, 72);
    const bucket = clampInt(u.searchParams.get("bucket"), 1, 1440, 60);
    const [series, triggers] = await Promise.all([
      callRpc("affect_history_series",   { p_hours: hours, p_bucket_minutes: bucket }),
      callRpc("affect_history_triggers", { p_hours: hours }),
    ]);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ series, triggers }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "affect_history failed", detail: String(e?.message || e) }));
  }
}

function clampInt(raw, lo, hi, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

async function proxyBelief(req, res) {
  // /belief/health and /belief/model → sidecar on 127.0.0.1:18790
  const sub = req.url.replace(/^\/belief/, "") || "/health";
  const upstreamUrl = new URL(sub, BELIEF);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const upstream = await fetch(upstreamUrl, { signal: controller.signal });
    clearTimeout(timer);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "unreachable",
      detail: String(e?.message || e),
      url: String(upstreamUrl),
    }));
  }
}

// --- /motivation/* — Schicht 4 Panels ------------------------------------
async function proxyMotivation(req, res) {
  const sub = req.url.replace(/^\/motivation/, "") || "/health";
  const upstreamUrl = new URL(sub, MOTIVATION);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { "Content-Type": req.headers["content-type"] || "application/json" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "unreachable",
      detail: String(e?.message || e),
      url: String(upstreamUrl),
    }));
  }
}

async function handleMotivationStats(_req, res) {
  try {
    const [stats, hint] = await Promise.all([
      callRpc("motivation_stats"),
      callRpc("motivation_neurochem_hint", { p_label: "main" }).catch(() => null),
    ]);
    let coupling = null;
    if (hint && hint.exists) {
      const bands = await callRpc("motivation_dynamic_bands", { p_noradrenaline: hint.noradrenaline }).catch(() => null);
      coupling = {
        serotonin: hint.serotonin,
        noradrenaline: hint.noradrenaline,
        dopamine_prediction: hint.dopamine_prediction,
        consecutive_failures: hint.consecutive_failures,
        time_multiplier: Math.max(1.0, 2.0 - (hint.serotonin ?? 0.5)),
        bands: bands?.thresholds ?? null,
        band_shift: bands?.shift ?? null,
      };
    }
    // Spread coupling into stats object so existing frontend readers still work;
    // new coupling info lives under stats._coupling.
    const merged = { ...(stats || {}), _coupling: coupling };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(merged));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "motivation_stats failed", detail: String(e?.message || e) }));
  }
}

// --- /identity/* — Schicht 5 Panels --------------------------------------
async function handleSelfModel(_req, res) {
  try {
    const m = await callRpc("self_model_current");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(m));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "self_model_current failed", detail: String(e?.message || e) }));
  }
}

async function handleGenomes(_req, res) {
  try {
    const g = await callRpc("genome_list");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(g));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "genome_list failed", detail: String(e?.message || e) }));
  }
}

// --- /guard/* — proxy to guard sidecar + summary -------------------------
async function proxyGuard(req, res) {
  const sub = req.url.replace(/^\/guard/, "") || "/health";
  const upstreamUrl = new URL(sub, GUARD);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { "Content-Type": req.headers["content-type"] || "application/json" },
      body: ["GET","HEAD"].includes(req.method) ? undefined : body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "unreachable", detail: String(e?.message || e), url: String(upstreamUrl) }));
  }
}

// --- /tinder/* — swipe store + profile cards -----------------------------
async function handleTinderCards(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const viewer = url.searchParams.get("viewer") || "main";
    const user   = url.searchParams.get("user")   || "reed";
    const limit  = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
    const incl   = url.searchParams.get("include_seen") === "1";
    const data = await callRpc("bot_profile_cards", {
      p_viewer_genome_label: viewer, p_viewer_user: user,
      p_limit: limit, p_include_seen: incl,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "cards failed", detail: String(e?.message || e) }));
  }
}

async function handleTinderSwipe(req, res) {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
  if (!body.swiper || !body.target || !body.direction) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "swiper, target, direction required" }));
    return;
  }
  try {
    const result = await callRpc("swipe_record", {
      p_swiper_user:         body.swiper_user || "reed",
      p_swiper_genome_label: body.swiper,
      p_target_genome_label: body.target,
      p_direction:           body.direction,
      p_notes:               body.notes || null,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}

async function handleTinderMatches(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const viewer = url.searchParams.get("viewer") || "main";
    const user   = url.searchParams.get("user")   || "reed";
    const data = await callRpc("matches_for", {
      p_viewer_genome_label: viewer, p_viewer_user: user,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "matches failed", detail: String(e?.message || e) }));
  }
}

// --- /breed — spawn breed-agents.mjs, stream output back -----------------
const VALID_BREED_KEYS = new Set([
  "parent-a", "parent-b", "child", "mutation-rate",
  "inheritance", "allow", "notes",
]);
function buildBreedArgs(body) {
  const out = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!VALID_BREED_KEYS.has(k)) continue;
    if (typeof v === "string" && !/^[a-zA-Z0-9._\/+:@ ,=-]{1,300}$/.test(v)) continue;
    if (v === true || v === "true") out.push(`--${k}`);
    else if (v === false || v === "false") continue;
    else out.push(`--${k}=${v}`);
  }
  return out;
}

async function handleBreed(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { body = {}; }
  if (!body["parent-a"] || !body["parent-b"] || !body.child) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "parent-a, parent-b, child required" }));
    return;
  }
  const args = buildBreedArgs(body);
  const script = path.join(ROOT, "scripts/breed-agents.mjs");
  const child = spawn("node", [script, ...args], {
    cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  child.stdout.on("data", (d) => res.write(d));
  child.stderr.on("data", (d) => res.write(d));
  child.on("close", (code) => { res.write(`\n=== exit ${code} ===\n`); res.end(); });
  child.on("error", (e) => { res.write(`\n=== spawn error: ${e.message} ===\n`); res.end(); });
}

// --- /genome-lifecycle — archive/pause/reactivate/cull ------------------
async function handleGenomeLifecycle(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
  const { label, action, reason, confirm } = body;
  if (!label || !action) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "label + action required" }));
    return;
  }
  if (!["archive", "pause", "reactivate", "cull"].includes(action)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `unknown action '${action}'` }));
    return;
  }
  // Extra gate for cull: typed-confirmation must match label exactly.
  if (action === "cull") {
    if (confirm !== `CULL ${label}`) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `cull requires confirm: "CULL ${label}" (typed exactly)` }));
      return;
    }
    if (!reason || reason.length < 5) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "cull requires reason ≥5 chars" }));
      return;
    }
  }
  try {
    const fn = `genome_${action}`;
    const args = action === "reactivate" ? { p_label: label }
              : action === "cull"       ? { p_label: label, p_reason: reason }
              : { p_label: label, p_reason: reason ?? null };
    const out = await callRpc(fn, args);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, genome: out }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}

// --- /fitness-history?label=X — timeseries for trend chart ---------------
async function handleFitnessHistory(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const label = url.searchParams.get("label");
    const limit = parseInt(url.searchParams.get("limit") || "30", 10);
    if (!label) throw new Error("label param required");
    const rows = await callRpc("fitness_history", { p_label: label, p_limit: limit });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(rows));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "fitness_history failed", detail: String(e?.message || e) }));
  }
}

// --- /fitness-snapshot (POST) — trigger a new fitness measurement --------
async function handleFitnessSnapshot(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
  const label = body.label || "main";
  const windowDays = parseInt(body.window_days ?? 30, 10);
  try {
    // Resolve genome_id
    const genomes = await callRpc("genome_list");
    const g = (genomes || []).find((x) => x.label === label);
    if (!g) throw new Error(`genome '${label}' not found`);
    // Fetch experiences for this window, compute fitness, insert
    const cutoffIso = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
    const midIso    = new Date(Date.now() - (windowDays / 2) * 24 * 3600_000).toISOString();

    const expResp = await fetch(
      `${UPSTREAM}/experiences?select=id,outcome,valence,tags,created_at,metadata&created_at=gte.${encodeURIComponent(cutoffIso)}&limit=2000`,
      { headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT } }
    );
    if (!expResp.ok) throw new Error(`experiences fetch failed: ${expResp.status}`);
    const experiences = await expResp.json();

    const memResp = await fetch(
      `${UPSTREAM}/memories?select=id,tags,created_at&created_at=gte.${encodeURIComponent(cutoffIso)}&limit=2000`,
      { headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT } }
    );
    if (!memResp.ok) throw new Error(`memories fetch failed: ${memResp.status}`);
    const memories = await memResp.json();

    const outMap = { success: 1.0, partial: 0.5, failure: 0.0, unknown: 0.4 };
    const rated = experiences.map(e => outMap[e.outcome ?? "unknown"] ?? 0.4);
    const avgOutcome = rated.length ? rated.reduce((a,b) => a+b, 0) / rated.length : 0;

    const older = experiences.filter(e => e.created_at <  midIso).map(e => outMap[e.outcome ?? "unknown"] ?? 0.4);
    const newer = experiences.filter(e => e.created_at >= midIso).map(e => outMap[e.outcome ?? "unknown"] ?? 0.4);
    const oAvg = older.length ? older.reduce((a,b)=>a+b,0)/older.length : avgOutcome;
    const nAvg = newer.length ? newer.reduce((a,b)=>a+b,0)/newer.length : avgOutcome;
    const growth = Math.max(0, Math.min(1, 0.5 + (nAvg - oAvg)));

    const tagSet = new Set();
    for (const e of experiences) (e.tags || []).forEach(t => tagSet.add(t));
    for (const m of memories)    (m.tags || []).forEach(t => tagSet.add(t));
    const breadth = Math.min(1, tagSet.size / 20);

    const selfGen = experiences.filter(e => {
      const tags = e.tags || [];
      return tags.includes("self_generated") ||
             (e.metadata?.source === "motivation_engine");
    });
    const autonomy = Math.min(1, selfGen.length / 10);

    const fitness = 0.4 * avgOutcome + 0.25 * growth + 0.2 * breadth + 0.15 * autonomy;

    const insResp = await fetch(`${UPSTREAM}/agent_fitness_history`, {
      method: "POST",
      headers: { ...{ "Content-Type": "application/json", "Prefer": "return=representation",
        Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT } },
      body: JSON.stringify({
        genome_id: g.id,
        window_days: windowDays,
        avg_outcome: Number(avgOutcome.toFixed(4)),
        growth:      Number(growth.toFixed(4)),
        breadth:     Number(breadth.toFixed(4)),
        autonomy:    Number(autonomy.toFixed(4)),
        fitness:     Number(fitness.toFixed(4)),
        based_on_n:  experiences.length,
        details: { tag_diversity: tagSet.size, older_n: older.length, newer_n: newer.length },
      }),
    });
    if (!insResp.ok) throw new Error(`insert fitness failed: ${insResp.status} ${await insResp.text()}`);
    const row = (await insResp.json())[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, row }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}

// --- /genome-details — full genome + inheritance preview -----------------
async function handleGenomeDetails(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const label = url.searchParams.get("label");
    if (!label) throw new Error("label param required");
    const [genomes, inheritance, prov] = await Promise.all([
      callRpc("genome_list"),
      callRpc("genome_inheritance", { p_label: label }),
      callRpc("provenance_summary", { p_label: label }),
    ]);
    const genome = (genomes || []).find(g => g.label === label) || null;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ genome, inheritance, provenance: prov }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "genome details failed", detail: String(e?.message || e) }));
  }
}

// --- /provision — spawn provision-instance.mjs, stream output back -------
const VALID_PROVISION_KEYS = new Set([
  "label", "parent", "port-offset", "workspace",
  "gateway-port", "belief-port", "motivation-port", "dashboard-port", "cockpit-port",
  "base-model", "teacher-model", "dry-run", "force",
]);
function buildProvisionArgs(body) {
  const out = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!VALID_PROVISION_KEYS.has(k)) continue;
    // Only allow safe chars — defense in depth against arg injection.
    if (typeof v === "string" && !/^[a-zA-Z0-9._\/+:@=-]{1,200}$/.test(v)) continue;
    if (v === true || v === "true") out.push(`--${k}`);
    else if (v === false || v === "false") continue;
    else out.push(`--${k}=${v}`);
  }
  return out;
}

async function handleProvision(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { body = {}; }
  if (!body.label) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "label required" }));
    return;
  }
  // Always dry-run by default in the UI call — user confirms separately for real
  const args = buildProvisionArgs(body);
  const script = path.join(ROOT, "scripts/provision-instance.mjs");
  const child = spawn("node", [script, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  child.stdout.on("data", (d) => res.write(d));
  child.stderr.on("data", (d) => res.write(d));
  child.on("close", (code) => {
    res.write(`\n=== exit ${code} ===\n`);
    res.end();
  });
  child.on("error", (e) => {
    res.write(`\n=== spawn error: ${e.message} ===\n`);
    res.end();
  });
}

async function handleAgents(_req, res) {
  try {
    const [agents, genomes, prov] = await Promise.all([
      callRpc("agents_live"),
      callRpc("genome_list"),
      callRpc("provenance_summary"),
    ]);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ agents, genomes, provenance: prov }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "agents fetch failed", detail: String(e?.message || e) }));
  }
}

// /swarm-overview — Phase 4 substrate aggregator for the dashboard's
// Schwarm tab. Reads the SWARM_SPEC v1.1 tables (swarm_lessons, nodes,
// trust_edge_log, swarm_lesson_contradictions, tier_promotion_log,
// lesson_diversity_log, lesson_evidence_origin) and ships everything in a
// single round-trip so the UI doesn't have to fan out N fetches itself.
async function handleSwarmOverview(_req, res) {
  try {
    const [
      swarmLessons,
      peers,
      trustLog,
      contradictions,
      promotions,
      diversityAudits,
      kpiCounts,
      evidenceCounts,
    ] = await Promise.all([
      // §3.7 swarm_lessons — most-recent 25 lessons
      pgGet("swarm_lessons?select=id,content,lesson_tier,origin_node_id,signed_at,received_at,signature_verified_at,spec_version,local_weight,synthesized_from_cluster_size&order=received_at.desc.nullslast,signed_at.desc&limit=25"),
      // peers — every node row except is_self, ordered by last contact
      pgGet("nodes?select=node_id,display_name,is_self,trust_weight,trust_reason,last_seen_at,quarantined_until,consecutive_rejections&is_self=eq.false&order=last_seen_at.desc.nullslast&limit=20"),
      // §10.1/10.2 trust_edge_log — last 15 movements (display_name resolved below)
      pgGet("trust_edge_log?select=id,node_id,weight_before,weight_after,reason,at&order=at.desc&limit=15"),
      // §10.3 swarm_lesson_contradictions — top 10 most recent. Reads the
      // "active" view (migration 086) so operator-resolved or REM-falsified
      // pairs drop out of the dashboard automatically without an extra
      // application-level filter.
      pgGet("swarm_lesson_contradictions_active?select=id,a_id,b_id,cosine_similarity,confidence,reason,detected_at,evidence_count&order=detected_at.desc&limit=10"),
      // §10.6 tier_promotion_log — top 15 promotions
      pgGet("tier_promotion_log?select=id,lesson_id,from_tier,to_tier,reason,evidence_ids,at&order=at.desc&limit=15"),
      // §10.4 lesson_diversity_log — top 15 audits
      pgGet("lesson_diversity_log?select=id,lesson_id,prev_weight,new_weight,topic_cohort_size,near_dup_origin_count,over_concentration,reason,at&order=at.desc&limit=15"),
      // KPI roll-up — small queries with HEAD-style counts
      Promise.all([
        pgGet("swarm_lessons?select=id&lesson_tier=eq.A&limit=1000"),
        pgGet("swarm_lessons?select=id&lesson_tier=eq.B&limit=1000"),
        pgGet("nodes?select=node_id&is_self=eq.false&limit=1000"),
        pgGet("nodes?select=node_id&is_self=eq.false&quarantined_until=gt.now&limit=1000"),
        pgGet("swarm_lesson_contradictions_active?select=id&limit=1000"),
        pgGet(`tier_promotion_log?select=id&at=gte.${new Date(Date.now() - 30 * 86400_000).toISOString()}&limit=1000`),
        pgGet("lesson_diversity_log?select=id,over_concentration&limit=1000"),
      ]),
      // Evidence-leaf counts — distinct lesson_ids and total leaves
      pgGet("lesson_evidence_origin?select=lesson_id&limit=10000"),
    ]);

    const [tierA, tierB, peersAll, peersQuar, contraAll, promo30d, divAll] = kpiCounts;
    const evidenceLeafCount = Array.isArray(evidenceCounts) ? evidenceCounts.length : 0;
    const evidenceLessonCount = new Set(
      (evidenceCounts || []).map((r) => r.lesson_id).filter(Boolean)
    ).size;
    const diversityConcentrated = (divAll || []).filter((r) => r.over_concentration).length;

    // Resolve content previews for contradictions in one extra fetch.
    let contradictsResolved = [];
    if (contradictions.length > 0) {
      const ids = [
        ...new Set(contradictions.flatMap((c) => [c.a_id, c.b_id])),
      ];
      const inList = ids.map((x) => `"${x}"`).join(",");
      const detail = ids.length
        ? await pgGet(
            `swarm_lessons?select=id,content,origin_node_id,signed_at&id=in.(${inList})`,
          )
        : [];
      const byId = new Map(detail.map((r) => [r.id, r]));
      contradictsResolved = contradictions.map((c) => {
        const a = byId.get(c.a_id) || {};
        const b = byId.get(c.b_id) || {};
        return {
          ...c,
          a_content: a.content,
          a_origin:  a.origin_node_id,
          a_signed_at: a.signed_at,
          b_content: b.content,
          b_origin:  b.origin_node_id,
          b_signed_at: b.signed_at,
        };
      });
    }

    // Resolve display_name for the trust_log via the peers list we already
    // have (no FK embed — keeps the query working without a declared FK).
    const peerById = new Map((peers || []).map((p) => [p.node_id, p]));
    const trustLogFlat = (trustLog || []).map((r) => ({
      ...r,
      display_name: peerById.get(r.node_id)?.display_name || null,
    }));

    // evidence_count for promotions (length of evidence_ids array if present).
    const promotionsFlat = (promotions || []).map((r) => ({
      ...r,
      evidence_count: Array.isArray(r.evidence_ids) ? r.evidence_ids.length : null,
    }));

    res.writeHead(200, {
      "Content-Type":  "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      kpis: {
        tier_a: tierA.length,
        tier_b: tierB.length,
        peers_known: peersAll.length,
        peers_quarantined: peersQuar.length,
        contradicts: contraAll.length,
        promotions_30d: promo30d.length,
        evidence_leaves: evidenceLeafCount,
        evidence_lessons: evidenceLessonCount,
        diversity_checks: divAll.length,
        diversity_concentrated: diversityConcentrated,
      },
      swarm_lessons: swarmLessons,
      peers,
      trust_log: trustLogFlat,
      contradicts: contradictsResolved,
      promotions: promotionsFlat,
      diversity_audits: diversityAudits,
    }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "swarm-overview failed", detail: String(e?.message || e) }));
  }
}

async function handleMatches(_req, res) {
  // Compute pairing suggestions: for each pair of genomes, compute a "match score"
  // based on (complementary strengths) × (similar interests) × (fitness × fitness).
  try {
    const genomes = await callRpc("genome_list");
    if (!Array.isArray(genomes) || genomes.length < 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ matches: [], note: "need ≥2 genomes" }));
      return;
    }
    const rows = [];
    for (let i = 0; i < genomes.length; i++) {
      for (let j = i + 1; j < genomes.length; j++) {
        const a = genomes[i], b = genomes[j];
        const interestOverlap = intersect(a.interests || [], b.interests || []).length;
        const valueOverlap    = intersect(a.values    || [], b.values    || []).length;
        // complementary traits: bigger gap = more potential
        const traitGap = (
          Math.abs((a.curiosity_baseline ?? 0.5) - (b.curiosity_baseline ?? 0.5)) +
          Math.abs((a.exploration_rate  ?? 0.5) - (b.exploration_rate  ?? 0.5)) +
          Math.abs((a.risk_tolerance    ?? 0.5) - (b.risk_tolerance    ?? 0.5))
        ) / 3;
        const fitA = a.latest_fitness?.fitness ?? 0.5;
        const fitB = b.latest_fitness?.fitness ?? 0.5;
        const fitnessProduct = fitA * fitB;
        // score: emphasise aligned interests (shared world) + complementary traits + fitness
        const score = (interestOverlap / 10) * 0.3 + (valueOverlap / 6) * 0.2 + traitGap * 0.25 + fitnessProduct * 0.25;
        rows.push({
          parent_a: a.label, parent_b: b.label,
          interest_overlap: interestOverlap, value_overlap: valueOverlap,
          trait_gap: Number(traitGap.toFixed(3)),
          fitness_a: fitA, fitness_b: fitB,
          score: Number(score.toFixed(3)),
        });
      }
    }
    rows.sort((x, y) => y.score - x.score);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ matches: rows.slice(0, 20) }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "matches failed", detail: String(e?.message || e) }));
  }
}

function intersect(a, b) {
  const s = new Set(a);
  return (b || []).filter(x => s.has(x));
}

async function handleSleep(_req, res) {
  try {
    const [summary, recent] = await Promise.all([
      callRpc("sleep_summary"),
      callRpc("sleep_recent", { p_limit: 14 }),
    ]);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ summary, recent }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sleep fetch failed", detail: String(e?.message || e) }));
  }
}

async function handleInheritance(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const label = url.searchParams.get("label") || "main";
    const data = await callRpc("genome_inheritance", { p_label: label });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "genome_inheritance failed", detail: String(e?.message || e) }));
  }
}

async function handleEmergence(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 100);
    const only_open = url.searchParams.get("only_open") === "1";
    const rows = await callRpc("emergence_recent", { p_limit: limit, p_only_open: only_open });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(rows));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "emergence_recent failed", detail: String(e?.message || e) }));
  }
}

async function handleNeurochemistry(req, res) {
  try {
    const urlObj = new URL(req.url, "http://local");
    const label = urlObj.searchParams.get("label") || "main";
    const [state, compat, recall, horizon, history] = await Promise.all([
      callRpc("neurochem_get",               { p_label: label }),
      callRpc("neurochem_get_compat",        { p_label: label }),
      callRpc("neurochem_get_recall_params", { p_label: label }),
      callRpc("neurochem_get_horizon",       { p_label: label }),
      callRpc("neurochem_history",           { p_label: label, p_limit: 30 }),
    ]);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      label,
      state, compat, recall_params: recall, horizon, history,
      generated_at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "neurochemistry failed", detail: String(e?.message || e) }));
  }
}

async function handleFederationStatus(_req, res) {
  // Aggregator — browser-facing read-only view of the federation layer.
  try {
    const [host, trust, peers, imports, revocations] = await Promise.all([
      callRpc("host_identity_current"),
      callRpc("trust_list", { p_include_revoked: false }),
      callRpc("peers_list", { p_only_autosync: false }),
      callRpc("federation_recent", { p_limit: 20 }),
      callRpc("revocations_list_signed", { p_only_signed: false }),
    ]);
    const hostInfo = host && typeof host === "object" && Object.keys(host).length > 0 ? host : null;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      host:        hostInfo,
      trust_roots: Array.isArray(trust) ? trust : [],
      peers:       Array.isArray(peers) ? peers : [],
      recent_imports: Array.isArray(imports) ? imports : [],
      revocations: Array.isArray(revocations) ? revocations : [],
      generated_at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "federation status failed", detail: String(e?.message || e) }));
  }
}

async function handleNarrate(req, res) {
  try {
    const urlObj = new URL(req.url, "http://local");
    const label = urlObj.searchParams.get("label") || "main";
    const [n, phys] = await Promise.all([
      callRpc("narrate_self"),
      callRpc("narrate_neurochem", { p_label: label }).catch(() => null),
    ]);
    let out = formatNarrate(n);
    if (phys && phys.exists && phys.text) {
      out += `\n\n**Physiology (${label}):** ${phys.text}\n`;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(out);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("narrate failed: " + (e?.message || e));
  }
}

// --- /relations-graph — nodes + edges für das synapsen-panel ---------------
async function handleRelationsGraph(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const limit        = Math.min(parseInt(url.searchParams.get("limit")        || "400", 10) || 400, 2000);
    const types        = url.searchParams.get("types");                        // "caused_by,led_to,..."
    const includeHebb  = url.searchParams.get("hebbian")  !== "0";
    const minWeight    = parseFloat(url.searchParams.get("min_weight") || "0");
    const minHebbWeight= parseFloat(url.searchParams.get("min_hebb")   || "0");
    const category     = url.searchParams.get("category");                     // people|projects|topics|decisions
    const focusId      = url.searchParams.get("focus");                        // optional center
    const depth        = Math.min(parseInt(url.searchParams.get("depth") || "2", 10) || 2, 4);
    // Inter-Cluster-Brücken: zusätzliche top-K Kanten nach weight.desc (ohne
    // min_weight-Filter), damit der Client wirklich isolierte Komponenten via
    // dominante Synapse verbinden kann. Floor verhindert Noise.
    const wantBridges  = url.searchParams.get("bridges") === "1";
    const bridgeFloor  = Math.max(0, Math.min(0.99,
      parseFloat(url.searchParams.get("bridge_min_weight") || "0.5")));
    const bridgeTopK   = Math.min(500, parseInt(url.searchParams.get("bridge_top") || "300", 10) || 300);

    // --- 1) typed relations --------------------------------------------------
    const relsUrl = new URL("/memory_relations", UPSTREAM);
    relsUrl.searchParams.set("select", "a_id,b_id,type,weight,evidence_count,reason");
    relsUrl.searchParams.set("order",  "last_reinforced_at.desc");
    relsUrl.searchParams.set("limit",  String(limit));
    if (types)      relsUrl.searchParams.set("type",   `in.(${types})`);
    if (minWeight)  relsUrl.searchParams.set("weight", `gte.${minWeight}`);

    const relsResp = await fetch(relsUrl, {
      headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
    });
    if (!relsResp.ok) throw new Error(`memory_relations HTTP ${relsResp.status}`);
    const rels = await relsResp.json();

    const edges = rels.map(r => ({
      a: r.a_id, b: r.b_id, type: r.type,
      weight: r.weight, evidence: r.evidence_count,
      reason: r.reason, kind: "typed",
    }));

    // --- 2) optional Hebbian (undirected) -----------------------------------
    if (includeHebb) {
      const hebbUrl = new URL("/memory_links", UPSTREAM);
      hebbUrl.searchParams.set("select", "a,b,weight,coactivation_count");
      hebbUrl.searchParams.set("weight", `gte.${minHebbWeight}`);
      hebbUrl.searchParams.set("order",  "weight.desc");
      hebbUrl.searchParams.set("limit",  "400");
      const hebbResp = await fetch(hebbUrl, {
        headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
      });
      if (hebbResp.ok) {
        const hebb = await hebbResp.json();
        for (const h of hebb) edges.push({
          a: h.a, b: h.b, type: "hebbian",
          weight: h.weight, evidence: h.coactivation_count ?? 0, kind: "hebbian",
        });
      }
    }

    // --- 2b) Inter-Cluster-Bridge-Kandidaten (top-K nach weight.desc) -------
    // Diese Kandidaten ignorieren min_weight/min_hebb absichtlich — sie sollen
    // dem Client erlauben, zwischen Komponenten zu vermitteln, die durch den
    // User-Filter gerade getrennt wurden. Floor (bridgeFloor) verhindert Noise.
    const bridgeCandidates = [];
    if (wantBridges) {
      const seenPairs = new Set(
        edges.map(e => {
          const lo = e.a < e.b ? e.a : e.b;
          const hi = e.a < e.b ? e.b : e.a;
          return `${lo}|${hi}|${e.type}`;
        })
      );

      const brUrl = new URL("/memory_relations", UPSTREAM);
      brUrl.searchParams.set("select", "a_id,b_id,type,weight,evidence_count,reason");
      brUrl.searchParams.set("order",  "weight.desc");
      brUrl.searchParams.set("limit",  String(bridgeTopK));
      if (types)        brUrl.searchParams.set("type",   `in.(${types})`);
      if (bridgeFloor)  brUrl.searchParams.set("weight", `gte.${bridgeFloor}`);
      const brResp = await fetch(brUrl, {
        headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
      });
      if (brResp.ok) {
        const brRows = await brResp.json();
        for (const r of brRows) {
          const lo = r.a_id < r.b_id ? r.a_id : r.b_id;
          const hi = r.a_id < r.b_id ? r.b_id : r.a_id;
          const k  = `${lo}|${hi}|${r.type}`;
          if (seenPairs.has(k)) continue;
          seenPairs.add(k);
          bridgeCandidates.push({
            a: r.a_id, b: r.b_id, type: r.type,
            weight: r.weight, evidence: r.evidence_count,
            reason: r.reason, kind: "typed",
          });
        }
      }

      if (includeHebb) {
        const bhUrl = new URL("/memory_links", UPSTREAM);
        bhUrl.searchParams.set("select", "a,b,weight,coactivation_count");
        bhUrl.searchParams.set("order",  "weight.desc");
        bhUrl.searchParams.set("limit",  String(Math.min(300, Math.max(100, Math.floor(bridgeTopK * 0.66)))));
        if (bridgeFloor) bhUrl.searchParams.set("weight", `gte.${bridgeFloor}`);
        const bhResp = await fetch(bhUrl, {
          headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
        });
        if (bhResp.ok) {
          const bhRows = await bhResp.json();
          for (const h of bhRows) {
            const lo = h.a < h.b ? h.a : h.b;
            const hi = h.a < h.b ? h.b : h.a;
            const k  = `${lo}|${hi}|hebbian`;
            if (seenPairs.has(k)) continue;
            seenPairs.add(k);
            bridgeCandidates.push({
              a: h.a, b: h.b, type: "hebbian",
              weight: h.weight, evidence: h.coactivation_count ?? 0, kind: "hebbian",
            });
          }
        }
      }
    }

    // --- 3) sammle alle beteiligten Memory-IDs + (optional) focus-BFS --------
    const wantIds = new Set();
    for (const e of edges) { wantIds.add(e.a); wantIds.add(e.b); }
    for (const b of bridgeCandidates) { wantIds.add(b.a); wantIds.add(b.b); }

    if (focusId && wantIds.has(focusId)) {
      // keep only edges reachable within `depth` hops from focusId
      const adj = new Map();
      for (const e of edges) {
        if (!adj.has(e.a)) adj.set(e.a, []);
        if (!adj.has(e.b)) adj.set(e.b, []);
        adj.get(e.a).push(e.b);
        adj.get(e.b).push(e.a);
      }
      const keep = new Set([focusId]);
      let frontier = [focusId];
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const n of frontier) {
          for (const m of adj.get(n) || []) {
            if (!keep.has(m)) { keep.add(m); next.push(m); }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      for (let i = edges.length - 1; i >= 0; i--) {
        if (!keep.has(edges[i].a) || !keep.has(edges[i].b)) edges.splice(i, 1);
      }
      for (let i = bridgeCandidates.length - 1; i >= 0; i--) {
        const b = bridgeCandidates[i];
        if (!keep.has(b.a) || !keep.has(b.b)) bridgeCandidates.splice(i, 1);
      }
      wantIds.clear();
      for (const id of keep) wantIds.add(id);
    }

    // --- 4) node-Metadaten holen --------------------------------------------
    let nodes = [];
    if (wantIds.size > 0) {
      const idList = [...wantIds].slice(0, 1200);
      const memUrl = new URL("/memories", UPSTREAM);
      memUrl.searchParams.set(
        "select",
        "id,content,category,tags,stage,strength,access_count,useful_count,pinned,created_at,valid_until"
      );
      memUrl.searchParams.set("id", `in.(${idList.join(",")})`);
      if (category) memUrl.searchParams.set("category", `eq.${category}`);
      memUrl.searchParams.set("limit", String(idList.length));
      const memResp = await fetch(memUrl, {
        headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
      });
      if (!memResp.ok) throw new Error(`memories HTTP ${memResp.status}`);
      const rows = await memResp.json();
      nodes = rows.map(m => ({
        id: m.id,
        label: (m.content || "").slice(0, 80),
        content: m.content || "",
        category: m.category || "general",
        tags: m.tags || [],
        stage: m.stage || "episodic",
        strength: m.strength ?? 0.5,
        access: m.access_count ?? 0,
        useful: m.useful_count ?? 0,
        pinned: !!m.pinned,
        archived: !!m.valid_until,
        created_at: m.created_at,
      }));

      // If we filtered by category, drop edges that reference missing nodes.
      if (category) {
        const ok = new Set(nodes.map(n => n.id));
        for (let i = edges.length - 1; i >= 0; i--) {
          if (!ok.has(edges[i].a) || !ok.has(edges[i].b)) edges.splice(i, 1);
        }
        for (let i = bridgeCandidates.length - 1; i >= 0; i--) {
          const b = bridgeCandidates[i];
          if (!ok.has(b.a) || !ok.has(b.b)) bridgeCandidates.splice(i, 1);
        }
      } else {
        // Auch ohne Category-Filter müssen Bridges deren Endpunkte tatsächlich
        // im nodes-Set landen — sonst würden Phantom-Kanten auf nichts zeigen.
        const ok = new Set(nodes.map(n => n.id));
        for (let i = bridgeCandidates.length - 1; i >= 0; i--) {
          const b = bridgeCandidates[i];
          if (!ok.has(b.a) || !ok.has(b.b)) bridgeCandidates.splice(i, 1);
        }
      }
    }

    // --- 5) type-Zählwerk für Legende ---------------------------------------
    const typeCounts = {};
    for (const e of edges) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      nodes, edges,
      bridge_candidates: bridgeCandidates,
      stats: {
        node_count: nodes.length,
        edge_count: edges.length,
        bridge_candidate_count: bridgeCandidates.length,
        type_counts: typeCounts,
        limited: edges.length >= limit,
        bridge_floor: wantBridges ? bridgeFloor : null,
      },
      generated_at: new Date().toISOString(),
    }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "relations-graph failed", detail: String(e?.message || e) }));
  }
}

// --- /memory/:id — single memory lookup for side-panel details ------------
async function handleMemoryById(req, res) {
  try {
    const m = req.url.match(/^\/memory\/([0-9a-f-]{36})/i);
    if (!m) { res.writeHead(400); res.end(JSON.stringify({ error: "invalid id" })); return; }
    const id = m[1];
    const [memResp, whyJson, histJson] = await Promise.all([
      fetch(`${UPSTREAM}/memories?id=eq.${id}&select=id,content,category,tags,stage,strength,access_count,useful_count,pinned,created_at,valid_until`, {
        headers: { Authorization: `Bearer ${SERVICE_JWT}`, apikey: SERVICE_JWT, Accept: "application/json" }
      }).then(r => r.json()),
      callRpc("memory_why", { p_memory_id: id }).catch(() => null),
      callRpc("memory_history", { p_memory_id: id, p_limit: 20 }).catch(() => null),
    ]);
    const mem = Array.isArray(memResp) ? memResp[0] : null;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ memory: mem, why: whyJson, history: histJson }));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "memory fetch failed", detail: String(e?.message || e) }));
  }
}

// ---------------------------------------------------------------- teacher-mode
// Liest die vom openClaw-Plugin claude-code-sessions geschriebenen JSON-Files.
// Schreibt resolution zurück, das Plugin pollt und nimmt sie auf.

import os from "node:os";

const TEACHER_PLANS_DIR =
  process.env.MYCELIUM_PLANS_DIR ?? path.join(os.homedir(), ".mycelium", "teacher-plans");
const TEACHER_ESCALATIONS_DIR =
  process.env.MYCELIUM_ESCALATIONS_DIR ?? path.join(os.homedir(), ".mycelium", "teacher-escalations");

async function _readJsonDir(dir, predicate) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return out; throw e; }
  for (const e of entries) {
    if (!e.endsWith(".json") || e.endsWith(".tmp")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, e), "utf8");
      const parsed = JSON.parse(raw);
      if (!predicate || predicate(parsed)) out.push(parsed);
    } catch { /* skip malformed */ }
  }
  return out;
}

async function handleTeacherPlans(_req, res) {
  try {
    const plans = await _readJsonDir(TEACHER_PLANS_DIR);
    plans.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ plans }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "teacher_plans_failed", detail: String(e?.message || e) }));
  }
}

async function handleTeacherPlanById(_req, res, planId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(planId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid plan id" })); return;
  }
  try {
    const raw = await fs.readFile(path.join(TEACHER_PLANS_DIR, `${planId}.json`), "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(raw);
  } catch (e) {
    if (e.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "plan not found" }));
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  }
}

async function handleTeacherEscalations(_req, res) {
  try {
    const escs = await _readJsonDir(TEACHER_ESCALATIONS_DIR, (d) => !d.resolution);
    escs.sort((a, b) => (a.raisedAt ?? 0) - (b.raisedAt ?? 0));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ escalations: escs }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "teacher_escalations_failed", detail: String(e?.message || e) }));
  }
}

async function handleTeacherEscalationResolve(req, res, escId) {
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  if (!/^[a-zA-Z0-9._-]+$/.test(escId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid escalation id" })); return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
  const resolution = body.resolution;
  const amendedItems = body.amendedItems ?? null;
  if (!["continue", "abort", "amend"].includes(resolution)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "resolution must be continue|abort|amend" })); return;
  }
  if (resolution === "amend" && (!Array.isArray(amendedItems) || amendedItems.length === 0)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "resolution=amend requires non-empty amendedItems" })); return;
  }
  const file = path.join(TEACHER_ESCALATIONS_DIR, `${escId}.json`);
  let data;
  try { data = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "escalation not found" })); return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) })); return;
  }
  if (data.resolution) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "already resolved", resolution: data.resolution })); return;
  }
  if (!(data.options ?? []).includes(resolution)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `resolution ${resolution} not in options ${data.options?.join(",")}` })); return;
  }
  data.resolution = resolution;
  data.amendedItems = resolution === "amend" ? amendedItems : null;
  data.resolvedAt = Date.now();
  // atomic write via tmp+rename
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- Swarm Phase 4: operator actions (issue #142 backend slice) ----------
// Three POST endpoints that let an operator resolve §10.3 contradictions,
// override a peer's TrustEdge state, and manually pin a Tier-B swarm
// lesson to Tier-A. The frontend buttons that call these land in a
// follow-up that depends on the schwarm tab from PR #133. The migration
// behind these handlers is supabase/migrations/086_swarm_operator_actions.sql.

async function readJsonPostBody(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return null;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return null;
  }
}

// POST /swarm/contradict-resolve {pair_id, decision: 'a'|'b'|'park'}
// Wraps operator_resolve_contradict() — atomic resolve + tier promotion +
// audit row. The RPC raises on unknown pair_id, double-resolve, or invalid
// decision; we surface those as 4xx with the RPC error string.
async function handleSwarmContradictResolve(req, res) {
  const body = await readJsonPostBody(req, res);
  if (body == null) return;
  if (!body.pair_id || typeof body.pair_id !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "pair_id (UUID string) required" }));
    return;
  }
  if (!["a", "b", "park"].includes(body.decision)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "decision must be 'a' | 'b' | 'park'" }));
    return;
  }
  try {
    const result = await callRpc("operator_resolve_contradict", {
      p_pair_id:  body.pair_id,
      p_decision: body.decision,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "contradict-resolve failed", detail: String(e?.message || e) }));
  }
}

// POST /swarm/peer-trust-override {node_id, action: 'distrust'|'restore', days?}
// Composes record_trust_edge_change (audit + weight) with quarantine_origin
// (state machine) — both from migration 075. No new RPC; operator-override
// is just a specific sequence of the existing operator-safe primitives.
//
// distrust → weight=0.0, quarantine 30 days (or `days` override).
// restore  → weight=0.5 (default new-peer trust from migration 071),
//            and clear quarantined_until via a fresh quarantine_origin
//            call with days=0... no wait, quarantine_origin enforces days>0.
//            Instead we issue an UPDATE through PostgREST to clear the
//            column directly. That's the only path that doesn't require
//            inventing a clear_quarantine RPC for this single use site.
async function handleSwarmPeerTrustOverride(req, res) {
  const body = await readJsonPostBody(req, res);
  if (body == null) return;
  if (!body.node_id || typeof body.node_id !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node_id (string) required" }));
    return;
  }
  if (!["distrust", "restore"].includes(body.action)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "action must be 'distrust' | 'restore'" }));
    return;
  }

  try {
    if (body.action === "distrust") {
      const days = Number.isInteger(body.days) && body.days > 0 ? body.days : 30;
      // Trust drop first (the audit log row records the operator reason).
      await callRpc("record_trust_edge_change", {
        p_node_id:    body.node_id,
        p_new_weight: 0.0,
        p_reason:     "operator-override-distrust",
      });
      await callRpc("quarantine_origin", {
        p_node_id: body.node_id,
        p_days:    days,
        p_reason:  "operator-override-distrust",
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok:                  true,
        node_id:             body.node_id,
        action:              "distrust",
        new_trust_weight:    0.0,
        quarantine_days:     days,
      }));
      return;
    }

    // restore — weight back to default 0.5 + clear quarantined_until.
    await callRpc("record_trust_edge_change", {
      p_node_id:    body.node_id,
      p_new_weight: 0.5,
      p_reason:     "operator-override-restore",
    });
    // Clear quarantine + reset rejection streak via direct UPDATE through
    // PostgREST (no clear-quarantine RPC exists; quarantine_origin enforces
    // days > 0 so we can't reuse it). The service_role JWT we already mint
    // for callRpc is sufficient.
    const r = await fetch(
      new URL(
        `/nodes?node_id=eq.${encodeURIComponent(body.node_id)}`,
        UPSTREAM,
      ),
      {
        method: "PATCH",
        headers: {
          "Content-Type":  "application/json",
          "Accept":        "application/json",
          "Prefer":        "return=representation",
          "Authorization": `Bearer ${SERVICE_JWT}`,
          "apikey":        SERVICE_JWT,
        },
        body: JSON.stringify({
          quarantined_until:      null,
          consecutive_rejections: 0,
          decay_reason:           "operator-override-restore",
        }),
      },
    );
    if (!r.ok) throw new Error(`PATCH /nodes failed: HTTP ${r.status}`);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok:               true,
      node_id:          body.node_id,
      action:           "restore",
      new_trust_weight: 0.5,
      quarantine_cleared: true,
    }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "peer-trust-override failed", detail: String(e?.message || e) }));
  }
}

// POST /swarm/lesson-pin {lesson_id}
// Manual operator-override of the §10.6 promotion path. Idempotent on
// already-Tier-A lessons (RPC returns noop=true). Local-lesson pin
// (lessons.tier='pinned') is intentionally NOT supported here — local
// lessons have no append-only audit table mirroring tier_promotion_log,
// so a lessons.tier UPDATE would lose the operator decision. That slice
// lands separately when a local-pin audit table exists.
async function handleSwarmLessonPin(req, res) {
  const body = await readJsonPostBody(req, res);
  if (body == null) return;
  if (!body.lesson_id || typeof body.lesson_id !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "lesson_id (UUID string) required" }));
    return;
  }
  try {
    const result = await callRpc("operator_pin_swarm_lesson", {
      p_lesson_id: body.lesson_id,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "lesson-pin failed", detail: String(e?.message || e) }));
  }
}

// --- Swarm Phase 3c: GET /.well-known/mycelium-node ----------------------
// Serves the local node's self-signed NodeAdvertisement (SWARM_SPEC §3.3 +
// §4.1). Unauthenticated and idempotent on purpose — discovery starts here.
// Lazy NodeIdentityService init: a stale process_env update from a restart
// would otherwise be ignored.
const nodeIdentityService = new NodeIdentityService(UPSTREAM, SERVICE_JWT);
async function handleNodeAdvertisement(_req, res) {
  const result = await buildNodeAdvertisementResponse({
    loadSelf: () => nodeIdentityService.getSelf(),
    publicUrl: process.env.MYCELIUM_PUBLIC_URL || env.MYCELIUM_PUBLIC_URL,
    displayName:
      process.env.MYCELIUM_DISPLAY_NAME || env.MYCELIUM_DISPLAY_NAME || null,
  });
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}

// --- Swarm sub-phase 4e: GET /swarm/lessons/{id}/proof ------------------
// SWARM_SPEC §4.6 Merkle-inclusion proof envelope. The handler is pure;
// the loaders below adapt PostgREST table reads to its async surface.
//
// Loaders read directly from the substrate tables rather than the
// `get_lesson_evidence` RPC: that RPC is broken on PG16 until migration
// 084 lands (issue #135 / PR #140) — the table read works regardless.
const PROOF_PATH_RE =
  /^\/swarm\/lessons\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/proof$/i;

async function pgSelect(query) {
  const r = await fetch(new URL(`/${query}`, UPSTREAM), {
    method: "GET",
    headers: {
      "Accept":        "application/json",
      "Authorization": `Bearer ${SERVICE_JWT}`,
      "apikey":        SERVICE_JWT,
    },
  });
  if (!r.ok) {
    throw new Error(`postgrest GET /${query} failed: HTTP ${r.status}`);
  }
  return r.json();
}

// --- Swarm sub-phase 4j: POST /swarm/lessons -----------------------------
// Receiver-side admission for incoming v1.1 Lesson envelopes (SWARM_SPEC §10.6
// firebreak). The handler module `lesson-admission.ts` is pure — every side
// effect (DB writes, signature lookups) goes through injected callbacks so
// the contract tests can exercise every branch without HTTP / Postgres. This
// adapter wires those callbacks against PostgREST + the existing swarm RPCs.
//
// Three deps are deliberately NOT supplied:
//
//   1. `getExpectedPrevLessonHash` — receiver-side rule-19 (broken
//      commitment chain) requires per-origin chain tracking on the receiver
//      side, which the substrate doesn't yet provide. swarm_lessons stores
//      neither `prev_lesson_hash` nor `lesson_hash`; only the producer-side
//      `lesson_chain` table (migration 074) carries those, and that table
//      is keyed by self-published lessons. Wiring rule 19 here means a new
//      `received_lesson_chain` table per-origin, which is its own follow-up.
//
//   2. `runContradictionGate` — the gate (migration 080 + PR #121) lives
//      in the MCP server services tree, not in the dashboard host. Mounting
//      it in this listener would cross the MCP/dashboard process boundary;
//      §10.5 REM self-audit catches the same contradicts asynchronously, so
//      the inline gate is a latency optimization, not a correctness one.
//
//   3. `setQuarantine` uses a direct PATCH on `nodes.quarantined_until`
//      rather than the `quarantine_origin` RPC because the §10.2 single-
//      strike interval is one hour and the RPC enforces `p_days > 0` (it
//      can't represent sub-day windows without a schema change). Same
//      pattern the operator-override restore path uses (#157 / lines 1731+).
async function pgPostJson(path, body) {
  const r = await fetch(new URL(`/${path}`, UPSTREAM), {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "Prefer":        "return=representation",
      "Authorization": `Bearer ${SERVICE_JWT}`,
      "apikey":        SERVICE_JWT,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`postgrest POST /${path} failed: HTTP ${r.status} ${text}`);
  }
  return r.json();
}

async function pgPatchJson(path, body) {
  const r = await fetch(new URL(`/${path}`, UPSTREAM), {
    method: "PATCH",
    headers: {
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "Authorization": `Bearer ${SERVICE_JWT}`,
      "apikey":        SERVICE_JWT,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`postgrest PATCH /${path} failed: HTTP ${r.status} ${text}`);
  }
}

function decodeB64Url(s) {
  // Accept both URL-safe and standard base64; restore padding.
  const std = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? std : std + "=".repeat(4 - (std.length % 4));
  return new Uint8Array(Buffer.from(pad, "base64"));
}

async function handleAdmitLesson(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  // Parse body upstream of admitSwarmLesson — the handler expects an
  // already-parsed object so the HTTP host owns JSON.parse failures.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body;
  try {
    body = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  try {
    const result = await admitSwarmLesson({
      body,
      ourSpecMajor: 1,
      now: new Date(),
      loadSelf: async () => {
        const self = await nodeIdentityService.getSelf();
        if (!self) return null;
        return { node_id: self.node_id, pubkey_b64: self.pubkey_b64 };
      },
      getPubkeyForNode: async (nodeId) => {
        const rows = await pgSelect(
          `nodes?select=pubkey_b64url&node_id=eq.${encodeURIComponent(nodeId)}&limit=1`,
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const b64 = rows[0]?.pubkey_b64url;
        if (typeof b64 !== "string" || b64.length === 0) return null;
        return decodeB64Url(b64);
      },
      getQuarantinedUntil: async (nodeId) => {
        const rows = await pgSelect(
          `nodes?select=quarantined_until&node_id=eq.${encodeURIComponent(nodeId)}&limit=1`,
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rows[0]?.quarantined_until ?? null;
      },
      insertSwarmLesson: async (lesson) => {
        const inserted = await pgPostJson("swarm_lessons", {
          id:                            lesson.id,
          content:                       lesson.content,
          embedding:                     lesson.embedding,
          synthesized_from_cluster_size: lesson.synthesized_from_cluster_size,
          origin_node_id:                lesson.origin_node_id,
          signed_at:                     lesson.signed_at,
          created_at:                    lesson.created_at,
          signature:                     lesson.signature,
          tags:                          lesson.tags ?? null,
          spec_version:                  lesson.spec_version,
          lesson_tier:                   "B",
        });
        const row = Array.isArray(inserted) ? inserted[0] : inserted;
        return { lesson_id: row?.id ?? lesson.id };
      },
      setQuarantine: async (nodeId, untilMs, reason) => {
        // Direct PATCH — the quarantine_origin RPC enforces p_days > 0,
        // which can't represent the §10.2 1-hour single-strike window.
        await pgPatchJson(
          `nodes?node_id=eq.${encodeURIComponent(nodeId)}`,
          {
            quarantined_until: new Date(untilMs).toISOString(),
            decay_reason:      reason,
          },
        );
      },
      recordTrustEdgeChange: async (nodeId, delta, reason) => {
        // The handler hands us a delta (§10.1 +0.05 admitted); record_trust_edge_change
        // sets an absolute new_weight. Read-modify-write so the audit row carries the
        // before→after pair the §10.1 audit semantics expect.
        const rows = await pgSelect(
          `nodes?select=trust_weight&node_id=eq.${encodeURIComponent(nodeId)}&limit=1`,
        );
        const before = Array.isArray(rows) && rows.length > 0
          ? Number(rows[0]?.trust_weight ?? 0.5)
          : 0.5;
        const next = Math.max(0, Math.min(1, before + delta));
        await callRpc("record_trust_edge_change", {
          p_node_id:    nodeId,
          p_new_weight: next,
          p_reason:     reason,
        });
      },
      // Intentionally undefined — see header comment.
      // getExpectedPrevLessonHash: undefined,
      // runContradictionGate:      undefined,
    });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (e) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error:  "lesson-admission handler failed",
      detail: String(e?.message || e),
    }));
  }
}

async function handleLessonProof(_req, res, lessonId) {
  try {
    const result = await buildLessonProofResponse({
      lessonId,
      loadSelf: async () => {
        const self = await nodeIdentityService.getSelf();
        if (!self) return null;
        return { node_id: self.node_id, pubkey_b64: self.pubkey_b64 };
      },
      loadLesson: async (id) => {
        const rows = await pgSelect(
          `swarm_lessons?select=origin_node_id,signed_at,spec_version&id=eq.${encodeURIComponent(id)}&limit=1`,
        );
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const r = rows[0];
        return {
          origin_node_id: r.origin_node_id,
          signed_at: r.signed_at,
          spec_version: r.spec_version,
        };
      },
      loadLeaves: async (id) => {
        const rows = await pgSelect(
          `lesson_evidence_origin?select=hashed_experience_id,position&lesson_id=eq.${encodeURIComponent(id)}&order=position.asc`,
        );
        if (!Array.isArray(rows)) return [];
        return rows.map((r) => r.hashed_experience_id);
      },
      wasPublishedByThisNode: async (id) => {
        const rows = await pgSelect(
          `lesson_chain?select=lesson_id&lesson_id=eq.${encodeURIComponent(id)}&limit=1`,
        );
        return Array.isArray(rows) && rows.length > 0;
      },
    });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (e) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: "lesson-proof handler failed",
      detail: String(e?.message || e),
    }));
  }
}

const server = http.createServer((req, res) => {
  // Tiny access log.
  const t = new Date().toISOString();
  res.on("finish", () => console.log(`${t} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${res.statusCode}`));

  // Swarm discovery — must precede the static fall-through so the
  // .well-known path doesn't get rewritten as a file lookup.
  if (req.url === "/.well-known/mycelium-node") return handleNodeAdvertisement(req, res);
  // Swarm Phase 4 operator actions (issue #142 backend slice). Frontend
  // buttons that POST these endpoints land in a follow-up PR that builds
  // on the schwarm tab from PR #133.
  if (req.url === "/swarm/contradict-resolve")  return handleSwarmContradictResolve(req, res);
  if (req.url === "/swarm/peer-trust-override") return handleSwarmPeerTrustOverride(req, res);
  if (req.url === "/swarm/lesson-pin")          return handleSwarmLessonPin(req, res);
  // Swarm sub-phase 4j (issue #138): receiver-side admission. Distinct from
  // the GET /swarm/lessons feed (PR #155 substrate) — methods route this.
  if (req.method === "POST" && req.url === "/swarm/lessons") return handleAdmitLesson(req, res);
  // Swarm sub-phase 4e (issue #105): inclusion-proof endpoint.
  if (req.method === "GET" && req.url) {
    const proofMatch = req.url.match(PROOF_PATH_RE);
    if (proofMatch) return handleLessonProof(req, res, proofMatch[1]);
  }
  if (req.url.startsWith("/api/"))            return proxyApi(req, res);
  if (req.url.startsWith("/belief"))          return proxyBelief(req, res);
  if (req.url.startsWith("/guard"))           return proxyGuard(req, res);
  if (req.url.startsWith("/tinder/")) {
    if (!FEATURE.pairing) return deferred(res, "pairing");
    if (req.url.startsWith("/tinder/cards"))    return handleTinderCards(req, res);
    if (req.url === "/tinder/swipe")            return handleTinderSwipe(req, res);
    if (req.url.startsWith("/tinder/matches"))  return handleTinderMatches(req, res);
  }
  if (req.url === "/affect")                  return handleAffect(req, res);
  if (req.url === "/affect/history" || req.url.startsWith("/affect/history?"))
                                              return handleAffectHistory(req, res);
  if (req.url === "/skills")                  return handleSkills(req, res);
  if (req.url === "/causal")                  return handleCausal(req, res);
  if (req.url === "/motivation/stats")        return handleMotivationStats(req, res);
  if (req.url.startsWith("/motivation"))      return proxyMotivation(req, res);
  if (req.url === "/self-model")              return handleSelfModel(req, res);
  if (req.url === "/genomes")                 return FEATURE.population ? handleGenomes(req, res) : deferred(res, "population");
  if (req.url === "/sleep")                   return handleSleep(req, res);
  if (req.url === "/agents")                  return handleAgents(req, res);
  if (req.url === "/swarm-overview")          return handleSwarmOverview(req, res);
  if (req.url === "/matches")                 return handleMatches(req, res);
  if (req.url === "/provision")               return handleProvision(req, res);
  if (req.url === "/breed")                   return FEATURE.pairing    ? handleBreed(req, res)            : deferred(res, "pairing");
  if (req.url.startsWith("/genome-details"))  return FEATURE.population ? handleGenomeDetails(req, res)   : deferred(res, "population");
  if (req.url === "/genome-lifecycle")        return FEATURE.population ? handleGenomeLifecycle(req, res) : deferred(res, "population");
  if (req.url.startsWith("/fitness-history")) return FEATURE.population ? handleFitnessHistory(req, res)  : deferred(res, "population");
  if (req.url === "/fitness-snapshot")        return FEATURE.population ? handleFitnessSnapshot(req, res) : deferred(res, "population");
  if (req.url === "/inheritance" || req.url.startsWith("/inheritance?")) return FEATURE.population ? handleInheritance(req, res) : deferred(res, "population");
  if (req.url === "/emergence" || req.url.startsWith("/emergence?")) return handleEmergence(req, res);
  if (req.url === "/prime" || req.url.startsWith("/prime?")) return handlePrime(req, res);
  if (req.url === "/narrate" || req.url.startsWith("/narrate?")) return handleNarrate(req, res);
  if (req.url === "/federation/status")       return FEATURE.federation ? handleFederationStatus(req, res) : deferred(res, "federation");
  if (req.url.startsWith("/neurochemistry"))   return handleNeurochemistry(req, res);
  if (req.url.startsWith("/relations-graph"))  return handleRelationsGraph(req, res);
  if (req.url.startsWith("/memory/"))          return handleMemoryById(req, res);
  // Teacher-Mode (claude-code-sessions Plugin):
  // mycelium liest Files unter ~/.mycelium/teacher-{plans,escalations}/.
  // Soft-couples mycelium ↔ openClaw via Filesystem; akzeptabel solange
  // Teacher-Mode openClaw-Plugin ist (siehe DESIGN-goal-driven-shutdown.md).
  if (req.url.startsWith("/teacher/")) {
    if (!FEATURE.teacher) return deferred(res, "teacher");
    if (req.url === "/teacher/plans" || req.url.startsWith("/teacher/plans?")) return handleTeacherPlans(req, res);
    let m = req.url.match(/^\/teacher\/plans\/([^\/?]+)$/);
    if (m) return handleTeacherPlanById(req, res, m[1]);
    if (req.url === "/teacher/escalations" || req.url.startsWith("/teacher/escalations?")) return handleTeacherEscalations(req, res);
    m = req.url.match(/^\/teacher\/escalations\/([^\/]+)\/resolve$/);
    if (m) return handleTeacherEscalationResolve(req, res, m[1]);
  }
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

// =================== Phase 3a: Federation HTTPS + mTLS ====================
//
// Eigener Listener auf FEDERATION_PORT (default 8788). Alle Routen unter
// /federation/* — Browser müssen NICHT damit reden, das ist Server-zu-Server.
// Setzt voraus, dass /opt/homebrew/bin/openssl Ed25519-fähig ist (LibreSSL
// reicht nicht). Self-Cert wird beim ersten Start angelegt.
//
// Auth: requestCert=true + custom verify gegen trust_roots[kind=host].
// Verbindungen ohne anerkanntes Peer-Zert werden NACH dem TLS-Handshake im
// Handler abgewiesen (TLS-Layer akzeptiert alles, weil wir self-signed certs
// per Allowlist managen — nicht via CA).

const FED_PORT  = Number(process.env.FEDERATION_PORT || 8788);
const HOST_LABEL = process.env.MYCELIUM_HOST_ID || "self";

let hostCert;
if (FEATURE.federation) {
  try {
    const tls = await import("./deferred/lib/tls-host.mjs");
    ensureHostCert        = tls.ensureHostCert;
    peerPubkeyFromCert    = tls.peerPubkeyFromCert;
    peerCertFingerprint   = tls.peerCertFingerprint;
    hostCert = ensureHostCert(HOST_LABEL);
    console.log(`federation host cert ready: ${hostCert.crtPath}`);
    console.log(`  pubkey:      ${hostCert.pubkeyHex}`);
    console.log(`  fingerprint: ${hostCert.fingerprintHex.slice(0, 32)}…`);
  } catch (e) {
    console.error(`federation cert init FAILED — federation disabled: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (hostCert && FEATURE.federation) {
  // Register host_identity in DB (best-effort; non-fatal).
  try {
    const r = await fetch(`${UPSTREAM}/rpc/host_identity_set`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_JWT, Authorization: `Bearer ${SERVICE_JWT}` },
      body: JSON.stringify({
        p_label: HOST_LABEL,
        p_pubkey: "\\x" + hostCert.pubkeyHex,
        p_cert_fingerprint: "\\x" + hostCert.fingerprintHex,
        p_cert_pem: hostCert.certPem,
      }),
    });
    if (!r.ok) console.error(`host_identity_set HTTP ${r.status}`);
  } catch (e) {
    console.error(`host_identity_set failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fedOptions = {
    key:                readFileSync(hostCert.keyPath),
    cert:               readFileSync(hostCert.crtPath),
    requestCert:        true,
    rejectUnauthorized: false,    // we authorize manually against trust_roots
    minVersion:         "TLSv1.3",
  };

  async function authPeer(req, res) {
    const cert = req.socket.getPeerCertificate(true);
    if (!cert || !cert.raw) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no client certificate" }));
      return null;
    }
    const peerPubkey = peerPubkeyFromCert(cert);
    const peerFp     = peerCertFingerprint(cert);
    if (!peerPubkey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "could not extract peer pubkey" }));
      return null;
    }
    // Lookup in trust_roots
    const tcRes = await fetch(`${UPSTREAM}/rpc/trust_check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_JWT, Authorization: `Bearer ${SERVICE_JWT}` },
      body: JSON.stringify({ p_pubkey: "\\x" + peerPubkey.toString("hex") }),
    });
    const trust = await tcRes.json();
    // Telemetry: record peer (best-effort)
    try {
      await fetch(`${UPSTREAM}/rpc/peer_seen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SERVICE_JWT, Authorization: `Bearer ${SERVICE_JWT}` },
        body: JSON.stringify({
          p_pubkey: "\\x" + peerPubkey.toString("hex"),
          p_label: cert.subject?.CN ?? null,
          p_cert_fingerprint: "\\x" + peerFp.toString("hex"),
          p_remote_addr: `${req.socket.remoteAddress}:${req.socket.remotePort}`,
        }),
      });
    } catch { /* ignore */ }
    if (trust.revoked) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "peer pubkey is revoked", reason: trust.reason }));
      return null;
    }
    if (!trust.trusted) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "peer not in trust_roots",
        peer_pubkey_hex: peerPubkey.toString("hex"),
        hint: "ask the operator to run trust_add for this pubkey",
      }));
      return null;
    }
    return {
      peerPubkeyHex: peerPubkey.toString("hex"),
      peerFingerprintHex: peerFp.toString("hex"),
      peerCN: cert.subject?.CN ?? null,
      trust,
    };
  }

  // Federation-Service shared between export/import handlers.
  const fedGuard    = new FedGuardService(GUARD, 8000);
  const fedService  = new FederationService(UPSTREAM, SERVICE_JWT, fedGuard, HOST_LABEL);

  async function readJsonBody(req, res, maxBytes = 8 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > maxBytes) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `body exceeds ${maxBytes} bytes` }));
        return null;
      }
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON", detail: String(e?.message || e) }));
      return null;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  const fedServer = https.createServer(fedOptions, async (req, res) => {
    const t = new Date().toISOString();
    res.on("finish", () => console.log(`${t} [fed] ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${res.statusCode}`));

    try {
      // --- whoami ---
      if (req.url === "/federation/whoami" && req.method === "GET") {
        const peer = await authPeer(req, res);
        if (!peer) return;
        return sendJson(res, 200, {
          host:               { label: HOST_LABEL, pubkey_hex: hostCert.pubkeyHex, fingerprint_hex: hostCert.fingerprintHex },
          peer:               peer,
          federation_version: 1,
        });
      }

      // --- export: peer requests a genome bundle ---
      // GET /federation/export/<label>
      const exportMatch = req.url.match(/^\/federation\/export\/([^/?]+)/);
      if (exportMatch && req.method === "GET") {
        const peer = await authPeer(req, res);
        if (!peer) return;
        const label = decodeURIComponent(exportMatch[1]);
        try {
          const r = await fedService.exportBundle(label, {
            destination: peer.peerCN ?? peer.peerPubkeyHex.slice(0, 16),
            exported_by: peer.peerPubkeyHex,
          });
          return sendJson(res, 200, {
            bundle:          r.bundle,
            bundle_hash_hex: r.bundle_hash_hex,
            bundle_size:     r.bundle_size,
          });
        } catch (e) {
          return sendJson(res, 404, { error: "export failed", detail: e?.message || String(e) });
        }
      }

      // --- Revocation-Sync: peer pulls our signed revocation list ---
      // GET /federation/revocations
      if (req.url === "/federation/revocations" && req.method === "GET") {
        const peer = await authPeer(req, res);
        if (!peer) return;
        const r = await fetch(`${UPSTREAM}/rpc/revocations_list_signed`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SERVICE_JWT, Authorization: `Bearer ${SERVICE_JWT}` },
          body: JSON.stringify({ p_only_signed: true }),
        });
        if (!r.ok) return sendJson(res, 502, { error: "revocations fetch failed", status: r.status });
        const list = await r.json();
        return sendJson(res, 200, { revocations: list });
      }

      // --- PoM: peer (importer) asks for Merkle-inclusion proofs ---
      // POST /pom/proof  body: { label, indices: number[] }
      if (req.url === "/pom/proof" && req.method === "POST") {
        const peer = await authPeer(req, res);
        if (!peer) return;
        const body = await readJsonBody(req, res);
        if (!body) return;
        const label = body.label;
        const indices = Array.isArray(body.indices) ? body.indices.filter((i) => Number.isInteger(i) && i >= 0) : [];
        if (!label || indices.length === 0) {
          return sendJson(res, 400, { error: "label and non-empty indices[] required" });
        }
        if (indices.length > 64) {
          return sendJson(res, 400, { error: "too many indices (max 64 per request)" });
        }
        // Fetch all leaves for the genome.
        const leafRes = await fetch(`${UPSTREAM}/rpc/genome_memory_leaves`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SERVICE_JWT, Authorization: `Bearer ${SERVICE_JWT}` },
          body: JSON.stringify({ p_label: label, p_limit: 50000 }),
        });
        if (!leafRes.ok) return sendJson(res, 502, { error: "leaves fetch failed", status: leafRes.status });
        const leafRows = await leafRes.json();
        // Rows come back as [{memory_id, leaf}]; leaf is "\x…" hex string.
        const leaves = leafRows.map((r) => Buffer.from(r.leaf.startsWith("\\x") ? r.leaf.slice(2) : r.leaf, "hex"));
        if (leaves.length === 0) {
          return sendJson(res, 409, { error: "genome has no memory leaves", merkle_n: 0 });
        }
        // Build Merkle tree (sha256 binary) — same algo as crypto.ts::merkleRoot.
        const merkleRoot = (() => {
          let layer = leaves.slice();
          while (layer.length > 1) {
            const next = [];
            for (let i = 0; i < layer.length; i += 2) {
              const L = layer[i]; const R = i + 1 < layer.length ? layer[i + 1] : layer[i];
              next.push(crypto.createHash("sha256").update(Buffer.concat([L, R])).digest());
            }
            layer = next;
          }
          return layer[0];
        })();
        // Build proofs
        const proofs = indices.filter((i) => i < leaves.length).map((idx) => {
          const siblings = [];
          let layer = leaves.slice();
          let i = idx;
          while (layer.length > 1) {
            const sibIdx = i % 2 === 0 ? i + 1 : i - 1;
            siblings.push((sibIdx < layer.length ? layer[sibIdx] : layer[i]).toString("hex"));
            const next = [];
            for (let j = 0; j < layer.length; j += 2) {
              const L = layer[j]; const R = j + 1 < layer.length ? layer[j + 1] : layer[j];
              next.push(crypto.createHash("sha256").update(Buffer.concat([L, R])).digest());
            }
            layer = next;
            i = Math.floor(i / 2);
          }
          return {
            index:         idx,
            memory_id:     leafRows[idx].memory_id,
            leaf_hex:      leaves[idx].toString("hex"),
            siblings_hex:  siblings,
          };
        });
        return sendJson(res, 200, {
          label,
          merkle_root_hex: merkleRoot.toString("hex"),
          merkle_n:        leaves.length,
          proofs,
        });
      }

      // --- import: peer pushes a bundle ---
      // POST /federation/import  body: { bundle: {...} }
      // Optional header: X-Federation-Callback: host:port  (enables Push-PoM)
      if (req.url === "/federation/import" && req.method === "POST") {
        const peer = await authPeer(req, res);
        if (!peer) return;
        const body = await readJsonBody(req, res);
        if (!body) return;
        const bundle = body.bundle ?? body;
        bundle.exported_by = { host: peer.peerCN ?? "peer", pubkey_hex: peer.peerPubkeyHex };

        // Push-PoM via reverse-callback: peer advertises where we can reach
        // its /pom/proof endpoint. We bind the callback cert pubkey to the
        // push cert pubkey so a redirect to a different trusted host fails.
        const callbackHeader = req.headers["x-federation-callback"];
        const strictPom = process.env.MYCELIUM_FEDERATION_REQUIRE_POM === "1";
        let pomVerify;
        if (callbackHeader) {
          const [cbHost, cbPortStr] = String(callbackHeader).split(":");
          const cbPort = parseInt(cbPortStr, 10);
          if (cbHost && cbPort > 0 && cbPort < 65536) {
            pomVerify = async (ctx) => fedService.challengePom({
              host: cbHost,
              port: cbPort,
              label: ctx.label,
              claimed_root_hex: ctx.merkle_root_hex,
              n: ctx.merkle_n,
              k: 5,
              expected_pubkey_hex: peer.peerPubkeyHex,
            });
          }
        } else if (strictPom && (bundle.root?.genome?.memory_merkle_n ?? 0) > 0) {
          return sendJson(res, 400, {
            error: "strict push-PoM required: set X-Federation-Callback header",
            hint: "configure MYCELIUM_FEDERATION_CALLBACK on the pusher",
          });
        }

        const verdict = await fedService.importBundle(bundle, {
          imported_by: peer.peerPubkeyHex,
          bypass_trust_root: false,
          skip_guard: false,
          pom_verify: pomVerify,
        });
        const status = verdict.decision === "accepted" ? 200
                     : verdict.decision === "quarantined" ? 202
                     : 422;
        return sendJson(res, status, verdict);
      }

      sendJson(res, 404, { error: "unknown federation endpoint" });
    } catch (e) {
      console.error(`[fed] handler error: ${e?.message || e}`);
      sendJson(res, 500, { error: "internal", detail: String(e?.message || e) });
    }
  });

  fedServer.listen(FED_PORT, HOST, () => {
    console.log(`federation listening on https://${HOST}:${FED_PORT} (mTLS)`);
  });

  // =============== Phase 3f: Auto-Sync + Cleanup Loop ===================
  //
  // Liest alle peers WHERE auto_sync_enabled=true und syncht ihre Revocations.
  // Interval konfigurierbar über FED_SYNC_INTERVAL_MS (default 5min), Cleanup
  // alle FED_CLEANUP_INTERVAL_MS (default 24h) mit FED_AUDIT_RETENTION_DAYS.
  // Auto-Sync kann via FED_SYNC_INTERVAL_MS=0 deaktiviert werden.

  const SYNC_INTERVAL_MS     = Number(process.env.FED_SYNC_INTERVAL_MS    ?? 5 * 60 * 1000);
  const CLEANUP_INTERVAL_MS  = Number(process.env.FED_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  const AUDIT_RETENTION_DAYS = Number(process.env.FED_AUDIT_RETENTION_DAYS ?? 90);

  async function runAutoSync() {
    try {
      const peers = await fedService.peersList(true);
      if (peers.length === 0) return;
      for (const p of peers) {
        if (!p.outbound_host || !p.outbound_port) continue;
        try {
          const r = await fedService.syncRevocations({ host: p.outbound_host, port: p.outbound_port });
          await fedService.peerRecordSync(
            p.pubkey_hex,
            true,
            `fetched=${r.fetched} accepted=${r.accepted} skipped=${r.skipped_already_known} rejected=${r.rejected_bad_sig + r.rejected_no_authority + r.rejected_malformed}`
          );
          console.log(`[auto-sync] ${p.outbound_host}:${p.outbound_port} (${p.label ?? "?"}): ${r.accepted} new, ${r.skipped_already_known} known`);
        } catch (e) {
          const note = e instanceof Error ? e.message.slice(0, 200) : String(e);
          await fedService.peerRecordSync(p.pubkey_hex, false, note);
          console.error(`[auto-sync] ${p.outbound_host}:${p.outbound_port} FAILED: ${note}`);
        }
      }
    } catch (e) {
      console.error(`[auto-sync] loop error: ${e?.message || e}`);
    }
  }

  async function runCleanup() {
    try {
      const r = await fedService.federationAuditCleanup(AUDIT_RETENTION_DAYS);
      if (r.imports_deleted > 0 || r.exports_deleted > 0) {
        console.log(`[cleanup] pruned ${r.imports_deleted} imports + ${r.exports_deleted} exports older than ${AUDIT_RETENTION_DAYS}d`);
      }
    } catch (e) {
      console.error(`[cleanup] error: ${e?.message || e}`);
    }
  }

  if (SYNC_INTERVAL_MS > 0) {
    setInterval(runAutoSync, SYNC_INTERVAL_MS).unref?.();
    // Initial sync shortly after boot, but not immediately — give the system a moment.
    setTimeout(runAutoSync, 15_000);
    console.log(`[auto-sync] enabled, every ${Math.round(SYNC_INTERVAL_MS / 1000)}s`);
  } else {
    console.log(`[auto-sync] disabled (FED_SYNC_INTERVAL_MS=0)`);
  }
  if (CLEANUP_INTERVAL_MS > 0) {
    setInterval(runCleanup, CLEANUP_INTERVAL_MS).unref?.();
    console.log(`[cleanup] enabled, every ${Math.round(CLEANUP_INTERVAL_MS / 1000)}s, retention ${AUDIT_RETENTION_DAYS}d`);
  }
}
