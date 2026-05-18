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
// Issue #80: confidence + scope admission gate for the two promotion paths.
// Pure helpers — no DB / no I/O. Loaded from the TS build so behaviour is
// pinned by mcp-server/src/__tests__/admission-gate.test.ts.
const {
  gateLessonAdmission,
  gateTraitAdmission,
  LESSON_MIN_CONFIDENCE,
  LESSON_MIN_SOURCES,
  TRAIT_MIN_EVIDENCE,
} = await import(path.join(DIST, "services/admission-gate.js"));

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
//   decay_salience        — drift the universal salience signal toward
//                            its 0.5 baseline (Migration 053). Without
//                            this, every bump from the day stacks
//                            forever and salience saturates near 1.0.
// ---------------------------------------------------------------------------
async function runSws() {
  const out = { forgotten: 0, consolidated: 0, deduped: 0, relations_created: 0, salience_decayed: null, errors: [] };
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
  try {
    out.salience_decayed = await restPost("/rpc/decay_salience", { p_tau_days: 30.0 });
  } catch (e) { out.errors.push({ step: "decay_salience", msg: String(e?.message ?? e) }); }
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
// Lesson-admission thresholds (issue #80). REM_MIN_CONFIDENCE is kept as a
// legacy alias for REM_LESSON_MIN_CONFIDENCE — the floor used to be 0.5; the
// gated default is 0.7 (matches the issue spec). Operators that previously
// tuned the old name keep working.
const REM_LESSON_MIN_CONFIDENCE = Number(
  process.env.REM_LESSON_MIN_CONFIDENCE
  ?? process.env.REM_MIN_CONFIDENCE
  ?? LESSON_MIN_CONFIDENCE,
);
const REM_LESSON_MIN_SOURCES = Number(
  process.env.REM_LESSON_MIN_SOURCES ?? LESSON_MIN_SOURCES,
);
const REM_LESSON_ALLOW_MIXED_PROJECT =
  process.env.REM_LESSON_ALLOW_MIXED_PROJECT === "1";
const REM_TRAIT_MIN_EVIDENCE = Number(
  process.env.REM_TRAIT_MIN_EVIDENCE ?? TRAIT_MIN_EVIDENCE,
);
const REM_CLUSTER_SIMILARITY = Number(process.env.REM_CLUSTER_SIMILARITY || 0.80);
const REM_CLUSTER_MIN_SIZE   = Number(process.env.REM_CLUSTER_MIN_SIZE   || 2);
const REM_CLUSTER_WINDOW_DAYS = Number(process.env.REM_CLUSTER_WINDOW_DAYS || 30);

async function runRem() {
  const out = {
    clusters_found: 0,
    lessons_synthesized: 0,
    lessons_reinforced: 0,
    // Per-reason rejection counters from gateLessonAdmission. The legacy
    // `lessons_skipped_low_conf` is preserved (issue #80) so the existing
    // dashboard tile keeps working; the two new counters distinguish the
    // sources/scope rejections so operators can see WHY synthesis didn't
    // produce a lesson. Sum of all three = clusters_found - lessons_*
    // promoted/reinforced.
    lessons_skipped_low_conf: 0,
    lessons_skipped_too_few_sources: 0,
    lessons_skipped_mixed_project: 0,
    lessons_deduped: 0,
    traits_promoted: 0,
    // Trait-gate rejection counters (issue #80). auto_summary catches the
    // "Ich habe gelernt …" first-person episode recap that previously
    // polluted the self-model with vectorworks product data.
    traits_skipped_auto_summary: 0,
    traits_skipped_low_evidence: 0,
    // Lesson-gate config snapshot — useful when comparing two cycles after
    // a threshold tweak via env vars.
    gate: {
      lesson_min_confidence: REM_LESSON_MIN_CONFIDENCE,
      lesson_min_sources:    REM_LESSON_MIN_SOURCES,
      lesson_allow_mixed_project: REM_LESSON_ALLOW_MIXED_PROJECT,
      trait_min_evidence:    REM_TRAIT_MIN_EVIDENCE,
    },
    // Reasoning telemetry (Ollama 0.20+ think:true). lessons_with_thinking
    // is the count of synthesise calls where the model emitted any chars
    // into message.thinking — gives a yes/no signal that the reasoning
    // pathway actually fired. lessons_thinking_chars_total summed for the
    // dashboard avg.
    lessons_with_thinking: 0,
    lessons_thinking_chars_total: 0,
    errors: [],
  };

  let clusters = [];
  out.cluster_params = {
    similarity: REM_CLUSTER_SIMILARITY,
    min_size:   REM_CLUSTER_MIN_SIZE,
    window_days: REM_CLUSTER_WINDOW_DAYS,
  };
  try {
    clusters = await expSvc.findClusters(
      REM_CLUSTER_SIMILARITY,
      REM_CLUSTER_MIN_SIZE,
      REM_CLUSTER_WINDOW_DAYS,
    );
    out.clusters_found = clusters.length;
    out.cluster_sizes = clusters.slice(0, 10).map((c) => c.member_count ?? (c.member_ids?.length ?? 0));
  } catch (e) { out.errors.push({ step: "find_clusters", msg: String(e?.message ?? e) }); }

  // Distinguish "no material" from "material but threshold too tight".
  // When zero clusters were produced, count unreflected experiences in the
  // window so the empty REM cycle is interpretable from the log alone.
  if (out.clusters_found === 0 && out.errors.every((e) => e.step !== "find_clusters")) {
    try {
      const cutoffISO = new Date(Date.now() - REM_CLUSTER_WINDOW_DAYS * 86400_000).toISOString();
      const r = await fetch(
        `${SUPABASE_URL}/experiences?select=id&reflected=eq.false&embedding=not.is.null&created_at=gte.${cutoffISO}`,
        { method: "HEAD", headers: { ...REST_HEADERS, Prefer: "count=exact", Range: "0-0" } },
      );
      const cr = r.headers.get("content-range");
      const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : null;
      out.unreflected_in_window = Number.isFinite(total) ? total : null;
    } catch (e) {
      out.errors.push({ step: "count_unreflected", msg: String(e?.message ?? e) });
    }
  }

  // Cluster → Qwen-Synthese → Lesson (entweder neu oder bestehende reinforced)
  for (const cluster of clusters) {
    try {
      const synth = await synthesizeCluster(cluster, {
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_KEY,
      });
      // Reasoning telemetry: synthesizeCluster annotates the result with
      // _thinking_chars when Ollama returned a non-empty thinking field.
      if (typeof synth?._thinking_chars === "number" && synth._thinking_chars > 0) {
        out.lessons_with_thinking += 1;
        out.lessons_thinking_chars_total += synth._thinking_chars;
      }
      if (!synth.lesson) {
        // Synthesizer returned no lesson body — model failed to emit JSON or
        // it parsed but had an empty lesson string. Treated as low-conf so
        // the rejection is visible in the existing telemetry tile.
        out.lessons_skipped_low_conf += 1;
        continue;
      }
      // Reinforcement of an already-existing lesson short-circuits the gate:
      // a lesson that is already on disk has already passed the gate (or
      // pre-dates it). Reinforcement is just adding evidence, not creating
      // new content, so blocking it would only suppress useful signal.
      if (!synth.reinforce) {
        const decision = gateLessonAdmission(
          {
            confidence:        synth.confidence,
            member_count:      synth.member_count ?? 0,
            project_consistent: synth.project_consistent !== false,
          },
          {
            minConfidence:      REM_LESSON_MIN_CONFIDENCE,
            minSources:         REM_LESSON_MIN_SOURCES,
            allowMixedProject:  REM_LESSON_ALLOW_MIXED_PROJECT,
          },
        );
        if (!decision.admit) {
          if (decision.reason === "low_confidence")        out.lessons_skipped_low_conf += 1;
          else if (decision.reason === "too_few_sources")  out.lessons_skipped_too_few_sources += 1;
          else if (decision.reason === "mixed_project_scope") out.lessons_skipped_mixed_project += 1;
          continue;
        }
      }
      // After record/reinforce, push the lesson's salience up via the
      // universal salience layer (Migration 053). This is what makes a
      // freshly-synthesised insight rise into "heard recently / mattered
      // recently" without waiting for it to be cited downstream — REM-sleep
      // IS the citation event in cognitive terms.
      let lessonId = null;
      if (synth.reinforce && cluster.matched_lesson_id) {
        await expSvc.reinforceLesson(cluster.matched_lesson_id, cluster.member_ids);
        lessonId = cluster.matched_lesson_id;
        out.lessons_reinforced += 1;
      } else {
        lessonId = await expSvc.recordLesson(synth.lesson, cluster.member_ids, { confidence: synth.confidence });
        out.lessons_synthesized += 1;
      }
      if (lessonId) {
        try { await restPost("/rpc/bump_salience", { p_kind: "lesson", p_id: lessonId, p_delta: 0.10 }); }
        catch (e) { out.errors.push({ step: "bump_salience_lesson", msg: String(e?.message ?? e) }); }
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
    // Lower the SQL-side minEvidence to the gate's floor so we still see
    // newly-eligible lessons; the JS gate then applies the auto-summary
    // filter and the project-scope check (issue #80). The SQL function's
    // own min_confidence still matches the lesson-gate confidence floor —
    // a lesson admitted at REM_LESSON_MIN_CONFIDENCE is by construction
    // above the trait-side floor, so re-using it keeps the two gates
    // mutually consistent.
    const candidates = await expSvc.promotionCandidates(
      REM_TRAIT_MIN_EVIDENCE,
      REM_LESSON_MIN_CONFIDENCE,
    );
    for (const c of candidates.slice(0, 10)) {
      const lessonText = c.lesson ?? c.lesson_text ?? "";
      const decision = gateTraitAdmission(
        {
          lesson_text:    lessonText,
          evidence_count: c.evidence_count ?? 0,
          project_id:     c.project_id ?? null,
        },
        { minEvidence: REM_TRAIT_MIN_EVIDENCE },
      );
      if (!decision.admit) {
        if (decision.reason === "auto_summary")      out.traits_skipped_auto_summary += 1;
        else if (decision.reason === "low_evidence") out.traits_skipped_low_evidence += 1;
        // missing_text falls through silently — the SQL side already
        // refuses to promote empty lessons.
        continue;
      }
      const traitText = lessonText.slice(0, 160);
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
// Phase 2.5 — Emergence Scan (Plan-A: deterministic detectors)
//   run_emergence_scan(window_days) — SQL-side fan-out across the four
//   data-driven indicators. ConscienceAgent events are mirrored separately
//   by the trigger from migration 056. LLM-based judgment (Plan B) would
//   sit here in the future.
// ---------------------------------------------------------------------------
const EMERGENCE_WINDOW_DAYS = Number(process.env.EMERGENCE_WINDOW_DAYS || 7);
const EMERGENCE_ENABLED = process.env.EMERGENCE_ENABLED !== "0";

async function runEmergenceScan() {
  const out = { ran: false, errors: [] };
  if (!EMERGENCE_ENABLED) {
    out.skipped_reason = "EMERGENCE_ENABLED=0";
    return out;
  }
  try {
    const summary = await restPost("/rpc/run_emergence_scan", { p_window_days: EMERGENCE_WINDOW_DAYS });
    Object.assign(out, summary || {});
    out.ran = true;
  } catch (e) {
    out.errors.push({ step: "run_emergence_scan", msg: String(e?.message ?? e) });
  }
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
// Phase 5 — Registry GC (delete stale client-session rows)
//   sweep_stale_client_sessions(p_max_age_hours)
// ---------------------------------------------------------------------------
async function runRegistryGc() {
  const out = { ran: false, deleted: 0, errors: [] };
  const hours = parseInt(process.env.SLEEP_CLIENT_SESSION_TTL_HOURS ?? "24", 10);
  try {
    const deleted = await restPost("/rpc/sweep_stale_client_sessions", { p_max_age_hours: hours });
    out.deleted = typeof deleted === "number" ? deleted : (deleted?.[0] ?? 0);
    out.ran = true;
  } catch (e) {
    out.errors.push({ step: "sweep_stale_client_sessions", msg: String(e?.message ?? e) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase MC — Memory Consolidation (REM over raw memories → atomic facts)
//
// Biological analogy: during REM, the hippocampus replays episodic traces to
// the neocortex which extracts semantic, generalised representations. Here we
// process clusters of unconsolidated episodic memories per project, call a
// local LLM (qwen3:8b) to extract atomic facts, and store them as
// subtype='fact' memories. Source episodes are then marked consolidated_at.
//
// Config env vars:
//   SLEEP_MC_ENABLED          (default 1)
//   SLEEP_MC_MODEL            (default qwen3:8b)
//   SLEEP_MC_WINDOW_DAYS      (default 7)
//   SLEEP_MC_MAX_EPISODES     (default 30)  — max episodes per LLM call
//   SLEEP_MC_MAX_FACTS        (default 15)  — max facts extracted per call
// ---------------------------------------------------------------------------
const MC_ENABLED      = process.env.SLEEP_MC_ENABLED    !== "0";
const MC_MODEL        = process.env.SLEEP_MC_MODEL      || "qwen3:8b";
const MC_WINDOW_DAYS  = parseInt(process.env.SLEEP_MC_WINDOW_DAYS ?? "7",   10);
const MC_MAX_EPISODES = parseInt(process.env.SLEEP_MC_MAX_EPISODES ?? "30", 10);
const MC_MAX_FACTS    = parseInt(process.env.SLEEP_MC_MAX_FACTS    ?? "15", 10);
const OLLAMA_CHAT_URL = `${process.env.OLLAMA_URL || "http://localhost:11434"}/api/chat`;

async function ollamaChat(model, system, user) {
  const r = await fetch(OLLAMA_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0, num_predict: 1024 },
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${model} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.message?.content ?? "";
  // strip <think>…</think> reasoning blocks from qwen3
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

async function runMemoryConsolidation() {
  const out = {
    enabled: MC_ENABLED,
    projects_processed: 0,
    groups_processed: 0,
    facts_created: 0,
    episodes_marked: 0,
    errors: [],
  };
  if (!MC_ENABLED) { out.skipped_reason = "SLEEP_MC_ENABLED=0"; return out; }

  const cutoff = new Date(Date.now() - MC_WINDOW_DAYS * 86400_000).toISOString();

  // Fetch unconsolidated episodes within the window.
  const { data: episodes, error } = await memSvc.db
    .from("memories")
    .select("id, content, category, tags, metadata, source, project_id, created_at, embedding")
    .eq("subtype", "episode")
    .is("consolidated_at", null)
    .gte("created_at", cutoff)
    .limit(500);  // safety cap per cycle
  if (error) { out.errors.push({ step: "fetch_episodes", msg: error.message }); return out; }
  if (!episodes || episodes.length === 0) { out.skipped_reason = "no unconsolidated episodes in window"; return out; }

  // Group by project_id (null = global) and metadata.session (for structured
  // ingests like LoCoMo), or fall back to calendar-day buckets.
  const groups = new Map(); // key → { project_id, episodes[] }
  for (const ep of episodes) {
    const proj   = ep.project_id ?? "__global__";
    const session = ep.metadata?.session ?? ep.metadata?.dia_id?.split(":")?.[0] ?? null;
    const day    = ep.created_at.slice(0, 10); // YYYY-MM-DD
    const key    = `${proj}::${session ?? day}`;
    if (!groups.has(key)) groups.set(key, { project_id: ep.project_id, episodes: [] });
    groups.get(key).episodes.push(ep);
  }
  out.groups_found = groups.size;

  for (const [key, { project_id, episodes: grp }] of groups) {
    if (out.errors.length >= 5) break; // stop after repeated failures
    // Limit batch size to avoid overlong prompts
    const batch = grp.slice(0, MC_MAX_EPISODES);

    const turnBlock = batch.map((ep) => `• ${ep.content}`).join("\n");
    const system = "You extract concise, atomic facts from a set of memory entries. Output ONLY the requested format.";
    const user = [
      "MEMORY ENTRIES:",
      turnBlock,
      "",
      `Extract up to ${MC_MAX_FACTS} atomic facts. Each fact must be self-contained and specific.`,
      "Format — one per line: FACT: <subject> | <predicate> | <value>",
      "Skip vague or content-free entries. Include dates and names when present.",
      "Do NOT include a SUMMARY. Only FACT lines.",
    ].join("\n");

    let raw;
    try {
      raw = await ollamaChat(MC_MODEL, system, user);
    } catch (e) {
      out.errors.push({ step: "llm_call", group: key, msg: String(e?.message ?? e) });
      continue;
    }

    // Parse FACT lines
    const facts = raw.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("FACT:"))
      .map((l) => {
        const body  = l.slice("FACT:".length).trim();
        const parts = body.split("|").map((p) => p.trim());
        if (parts.length < 2) return null;
        const [subject, predicate, ...rest] = parts;
        const value = rest.join(" | ");
        return value ? `${subject} ${predicate}: ${value}` : `${subject} ${predicate}`;
      })
      .filter(Boolean)
      .slice(0, MC_MAX_FACTS);

    if (facts.length === 0) { out.groups_processed++; continue; }

    // Store facts as new memories in the same project
    for (const factText of facts) {
      try {
        const embedding = await embeddings.embed(factText);
        const { error: insErr } = await memSvc.db.from("memories").insert({
          content:    factText,
          category:   "general",
          subtype:    "fact",
          tags:       ["mc-synthesized", "memory-rem"],
          embedding,
          metadata:   { source_group: key, synthesized_by: MC_MODEL, window_days: MC_WINDOW_DAYS },
          source:     `memory-rem:${key}`,
          project_id: project_id ?? null,
          pinned:     false,
        });
        if (insErr) out.errors.push({ step: "insert_fact", group: key, msg: insErr.message });
        else out.facts_created++;
      } catch (e) {
        out.errors.push({ step: "embed_fact", group: key, msg: String(e?.message ?? e) });
      }
    }

    // Mark source episodes as consolidated
    const ids = batch.map((ep) => ep.id);
    const { error: updErr } = await memSvc.db
      .from("memories")
      .update({ consolidated_at: new Date().toISOString() })
      .in("id", ids);
    if (updErr) out.errors.push({ step: "mark_consolidated", group: key, msg: updErr.message });
    else out.episodes_marked += ids.length;

    out.groups_processed++;
    if (project_id !== out._last_project) {
      out.projects_processed++;
      out._last_project = project_id;
    }
  }
  delete out._last_project;
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

  log("phase Memory Consolidation (REM over memories) …");
  const mc = await runMemoryConsolidation();
  log("memory consolidation done", { facts: mc.facts_created, episodes: mc.episodes_marked, errors: mc.errors.length });
  await patchCycle(cycleId, { memory_consolidation_result: mc });

  log("phase Emergence Scan …");
  const emerg = await runEmergenceScan();
  log("emergence done", emerg);
  await patchCycle(cycleId, { emergence_result: emerg });

  log("phase Metacognition …");
  const meta = await runMetacognition();
  log("metacog done", { persisted: meta.persisted, err: meta.errors.length });
  await patchCycle(cycleId, { metacog_result: meta });

  log("phase Weekly Fitness …");
  const fit = await runWeeklyFitness();
  log("fitness", { ran: fit.ran });
  await patchCycle(cycleId, { fitness_result: fit });

  log("phase Registry GC …");
  const gc = await runRegistryGc();
  log("registry gc done", { deleted: gc.deleted, errors: gc.errors.length });
  await patchCycle(cycleId, { registry_gc_result: gc });

  const allErrors = [
    ...(sws.errors || []),
    ...(rem.errors || []),
    ...(mc.errors || []),
    ...(emerg.errors || []),
    ...(meta.errors || []),
    ...(fit.errors || []),
    ...(gc.errors || []),
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
