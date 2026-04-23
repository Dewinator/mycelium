#!/usr/bin/env node
/**
 * nightly-sleep.mjs — biomimetischer Konsolidierungs-Runner.
 *
 * Biologisches Vorbild:
 *   SWS (Slow-Wave Sleep):  Memory-Consolidation + Synaptic Downscaling (Tononi)
 *   REM:                    Pattern-Extraktion, emotionale Verarbeitung, Lesson-Formation
 *   Metacognition (DMN):    Selbstbild-Update aus den nachts vor-verdauten Patterns
 *   Weekly:                 Fitness-Snapshot fuer Trend (Sonntags)
 *
 * Wird von LaunchAgent ai.openclaw.sleep um 03:00 getriggert. Manuell:
 *     node scripts/nightly-sleep.mjs [--manual]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const DIST      = path.join(ROOT, "mcp-server", "dist");

// --- env aus .mcp.json laden (SUPABASE_URL, KEY, OLLAMA_URL) --------------
const mcpCfg = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
process.env.SUPABASE_URL     ||= env.SUPABASE_URL;
process.env.SUPABASE_KEY     ||= env.SUPABASE_KEY;
process.env.OLLAMA_URL       ||= env.OLLAMA_URL;
process.env.EMBEDDING_MODEL  ||= env.EMBEDDING_MODEL;

// --- Services + Tools laden -----------------------------------------------
const { createEmbeddingProvider } = await import(path.join(DIST, "services/embeddings.js"));
const { MemoryService }      = await import(path.join(DIST, "services/supabase.js"));
const { ExperienceService }  = await import(path.join(DIST, "services/experiences.js"));
const { IdentityService }    = await import(path.join(DIST, "services/identity.js"));
const identityTools          = await import(path.join(DIST, "tools/identity.js"));
const { consolidateByPatterns } = await import(path.join(__dirname, "consolidate-by-patterns.mjs"));
const { synthesizeCluster, unloadQwen } = await import(path.join(__dirname, "synthesize-cluster.mjs"));

// Low-level REST fuer sleep_cycles insert/update — reines fetch, keine extra dep
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const REST_HEADERS = {
  "Content-Type":  "application/json",
  "Accept":        "application/json",
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "apikey":        SUPABASE_KEY,
};
async function restPost(path, body, prefer) {
  const headers = { ...REST_HEADERS };
  if (prefer) headers["Prefer"] = prefer;
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → HTTP ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  return r.json().catch(() => null);
}
async function restPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method: "PATCH", headers: { ...REST_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → HTTP ${r.status}: ${await r.text()}`);
  return null;
}

const embeddings = createEmbeddingProvider();
const memSvc  = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const expSvc  = new ExperienceService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const idSvc   = new IdentityService(SUPABASE_URL, SUPABASE_KEY);

const TRIGGER = process.argv.includes("--manual") ? "manual" : "launchd";
const AGENT   = process.env.SLEEP_AGENT_LABEL || "main";

function now() { return new Date().toISOString(); }
function log(msg, extra) {
  console.error(`[${now()}] ${msg}` + (extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""));
}

/** Create sleep_cycles row with status=running; returns id. */
async function startCycle() {
  const rows = await restPost("/sleep_cycles", {
    status: "running",
    agent_label: AGENT,
    trigger_source: TRIGGER,
  }, "return=representation");
  if (!Array.isArray(rows) || !rows[0]?.id) {
    throw new Error(`sleep_cycles insert returned no id: ${JSON.stringify(rows)}`);
  }
  return rows[0].id;
}

async function patchCycle(id, patch) {
  try { await restPatch(`/sleep_cycles?id=eq.${id}`, patch); }
  catch (e) { log("patch cycle failed (non-fatal)", { error: String(e?.message ?? e) }); }
}

async function finishCycle(id, status, startedAt, extra = {}) {
  const durMs = Date.now() - startedAt;
  await patchCycle(id, { status, finished_at: now(), duration_ms: durMs, ...extra });
}

// ---------------------------------------------------------------------------
// Phase 1 — SWS (Slow-Wave Sleep)
//   forget_weak_memories  — synaptic downscaling (Tononi SHY)
//   consolidate_memories  — episodic → semantic
//   dedup_memories        — merge near-duplicates
//   relations_by_patterns — Tag-Ko-Vorkommen → `related`-Edges (Engram)
// ---------------------------------------------------------------------------
async function runSws() {
  const out = { forgotten: 0, consolidated: 0, deduped: 0, relations_created: 0, errors: [] };
  try { out.forgotten = await memSvc.forgetWeak(0.05, 7); }
  catch (e) { out.errors.push({ step: "forget_weak", msg: String(e?.message ?? e) }); }
  try { out.consolidated = await memSvc.consolidate(3, 1); }
  catch (e) { out.errors.push({ step: "consolidate", msg: String(e?.message ?? e) }); }
  try { out.deduped = await memSvc.dedup(0.93); }
  catch (e) { out.errors.push({ step: "dedup_memories", msg: String(e?.message ?? e) }); }
  try {
    const rel = await consolidateByPatterns({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
    });
    out.relations_created = rel.edges_created;
    out.relations_pairs   = rel.pairs_processed;
    if (rel.errors.length) out.errors.push({ step: "relations_by_patterns", count: rel.errors.length, sample: rel.errors.slice(0, 2) });
  } catch (e) { out.errors.push({ step: "relations_by_patterns", msg: String(e?.message ?? e) }); }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2 — REM
//   findClusters         — Muster unter un-reflektierten Episoden finden
//   synthesize_cluster   — pro Cluster lokales Qwen3-8B via Ollama, JSON-output
//                           → recordLesson (neu) oder reinforceLesson (match)
//   dedup_lessons        — verwandte Lessons konsolidieren
//   promotion_candidates → promote_lesson_to_trait fuer reife Lessons
//   unloadQwen           — Ollama keep_alive=0: Modell aus RAM fuer andere Tasks
// ---------------------------------------------------------------------------
const REM_MIN_CONFIDENCE = Number(process.env.REM_MIN_CONFIDENCE || 0.5);

async function runRem() {
  const out = {
    clusters_found: 0,
    lessons_synthesized: 0,
    lessons_reinforced: 0,
    lessons_skipped_low_conf: 0,
    lessons_deduped: 0,
    traits_promoted: 0,
    errors: [],
  };

  let clusters = [];
  try {
    clusters = await expSvc.findClusters(0.85, 2, 30);
    out.clusters_found = clusters.length;
    out.cluster_sizes = clusters.slice(0, 10).map((c) => c.member_count ?? (c.member_ids?.length ?? 0));
  } catch (e) { out.errors.push({ step: "find_clusters", msg: String(e?.message ?? e) }); }

  // Cluster → Qwen-Synthese → Lesson (entweder neu oder bestehende reinforced)
  for (const cluster of clusters) {
    try {
      const synth = await synthesizeCluster(cluster, {
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_KEY,
      });
      if (!synth.lesson || synth.confidence < REM_MIN_CONFIDENCE) {
        out.lessons_skipped_low_conf += 1;
        continue;
      }
      if (synth.reinforce && cluster.matched_lesson_id) {
        await expSvc.reinforceLesson(cluster.matched_lesson_id, cluster.member_ids);
        out.lessons_reinforced += 1;
      } else {
        await expSvc.recordLesson(synth.lesson, cluster.member_ids, { confidence: synth.confidence });
        out.lessons_synthesized += 1;
      }
    } catch (e) {
      out.errors.push({ step: "synthesize_cluster", seed: cluster.seed_id, msg: String(e?.message ?? e) });
    }
  }

  // RAM freigeben — Qwen aus Ollama entladen, bevor weitere Phasen laufen
  try { await unloadQwen(); }
  catch (e) { out.errors.push({ step: "unload_qwen", msg: String(e?.message ?? e) }); }

  try { out.lessons_deduped = await expSvc.dedupLessons(0.92); }
  catch (e) { out.errors.push({ step: "dedup_lessons", msg: String(e?.message ?? e) }); }

  try {
    const candidates = await expSvc.promotionCandidates(4, 0.7);
    for (const c of candidates.slice(0, 10)) {
      const traitText = (c.lesson ?? c.lesson_text ?? "").slice(0, 160);
      if (!traitText) continue;
      try {
        await expSvc.promoteToTrait(c.id ?? c.lesson_id, traitText, 0);
        out.traits_promoted += 1;
      } catch (e) {
        out.errors.push({ step: "promote", lesson_id: c.id ?? c.lesson_id, msg: String(e?.message ?? e) });
      }
    }
  } catch (e) { out.errors.push({ step: "promotion_candidates", msg: String(e?.message ?? e) }); }

  return out;
}

// ---------------------------------------------------------------------------
// Phase 3 — Metacognition (Default Mode Network analog)
//   update_self_model
// ---------------------------------------------------------------------------
async function runMetacognition() {
  const out = { persisted: false, errors: [] };
  try {
    const res = await identityTools.updateSelfModel(idSvc, { window_days: 30, persist: true });
    const text = res?.content?.[0]?.text ?? "";
    out.persisted = text.includes("Persisted snapshot:");
    out.preview = text.slice(0, 400);
  } catch (e) { out.errors.push({ step: "update_self_model", msg: String(e?.message ?? e) }); }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 4 — Weekly Fitness (nur Sonntags, oder force=true via env)
// ---------------------------------------------------------------------------
async function runWeeklyFitness() {
  const out = { ran: false, errors: [] };
  const dayIdx = new Date().getDay(); // 0 = Sunday
  const force = process.env.SLEEP_FORCE_FITNESS === "1";
  if (dayIdx !== 0 && !force) {
    out.ran = false;
    out.skipped_reason = `weekday=${dayIdx} (only runs Sundays or with SLEEP_FORCE_FITNESS=1)`;
    return out;
  }
  try {
    const res = await identityTools.snapshotFitness(idSvc, { label: AGENT, window_days: 30 });
    out.ran = true;
    out.preview = res?.content?.[0]?.text?.slice(0, 400) ?? "";
  } catch (e) { out.errors.push({ step: "snapshot_fitness", msg: String(e?.message ?? e) }); }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const startedEpoch = Date.now();
let cycleId = null;
try {
  cycleId = await startCycle();
  log("sleep cycle started", { id: cycleId, trigger: TRIGGER, agent: AGENT });

  log("phase SWS …");
  const sws = await runSws();
  log("sws done", sws);
  await patchCycle(cycleId, { sws_result: sws });

  log("phase REM …");
  const rem = await runRem();
  log("rem done", rem);
  await patchCycle(cycleId, { rem_result: rem });

  log("phase Metacognition …");
  const meta = await runMetacognition();
  log("metacog done", { persisted: meta.persisted, err: meta.errors.length });
  await patchCycle(cycleId, { metacog_result: meta });

  log("phase Weekly Fitness …");
  const fit = await runWeeklyFitness();
  log("fitness", { ran: fit.ran });
  await patchCycle(cycleId, { fitness_result: fit });

  const allErrors = [
    ...(sws.errors || []),
    ...(rem.errors || []),
    ...(meta.errors || []),
    ...(fit.errors || []),
  ];
  const status = allErrors.length === 0 ? "ok" : "partial";
  await finishCycle(cycleId, status, startedEpoch, {
    errors: allErrors,
  });
  log(`cycle ${status}`, { duration_ms: Date.now() - startedEpoch, errors: allErrors.length });
  process.exit(0);
} catch (e) {
  log("cycle crashed", { error: String(e?.message ?? e) });
  if (cycleId) {
    try { await finishCycle(cycleId, "failed", startedEpoch, { errors: [{ step: "top", msg: String(e?.message ?? e) }] }); }
    catch {}
  }
  process.exit(1);
}
