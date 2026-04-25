/**
 * synthesize-cluster.mjs — REM-Synthesizer via lokalem LLM (default Qwen3-8B).
 *
 * Wandelt einen Experience-Cluster (von findClusters) in eine benannte Lesson um.
 * Wird nightly von nightly-sleep.mjs in runRem() aufgerufen, direkt nach findClusters().
 *
 * Laufzeit-Verhalten:
 *   - keep_alive: das Modell bleibt zwischen Clustern warm (REM_KEEP_ALIVE)
 *   - unloadQwen() am Ende: POST keep_alive=0 → Ollama entlädt das Modell
 *     sofort, RAM wird wieder frei.
 *
 * Konfiguration via Umgebungsvariablen:
 *   REM_MODEL       — Ollama-Modell-Tag (default: qwen3:8b)
 *   OLLAMA_URL      — Ollama-Endpoint (default: http://localhost:11434)
 *   REM_KEEP_ALIVE  — wie lange das Modell warm bleibt (default: 2m)
 *   REM_NUM_CTX     — Context-Window in Tokens (default: 16384)
 *
 * Prompt-Shape: strict JSON via Ollama `format: "json"`, erwartete Shape:
 *   { "lesson": string, "pattern_name": string, "confidence": 0..1, "reinforce": boolean }
 */

const MODEL       = process.env.REM_MODEL || "qwen3:8b";
const OLLAMA_URL  = process.env.OLLAMA_URL || "http://localhost:11434";
const KEEP_ALIVE  = process.env.REM_KEEP_ALIVE || "2m";
const NUM_CTX     = Number(process.env.REM_NUM_CTX || 16384);

// /think aktiviert den Reasoning-Pfad in Qwen3 (und in allen R1-Distills).
// Das Modell schreibt erst <think>…</think> mit interner Schlussfolgerung,
// dann das eigentliche JSON. Wir strippen den Think-Block vor JSON.parse.
// Beobachtung Audit 2026-04-24 ("Qualität-mittelmäßig, beschreibend statt
// handlungsleitend"): die Lessons brauchen Abstraktion, nicht Summary —
// Reasoning ist genau das Werkzeug dafür.
const SYSTEM_PROMPT = `/think

Du bist der REM-Synthesizer eines persistenten Gedächtnisses.

Eingabe: 3–10 Episoden (Experiences), die sich semantisch ähneln (Vektor-Cluster).
Aufgabe: Erkenne das verbindende Muster und formuliere EINE abstrakte Lesson,
die in kommenden Entscheidungen als Regel dient.

Schreibe HANDLUNGSLEITEND, nicht beschreibend.
  ❌ "Ich habe X gemacht und es hat geklappt."
  ✅ "Wenn X-Bedingung vorliegt, dann Y-Aktion — weil Z."

Erste Person, 1–2 Sätze, Regel-Form.

Wenn eine bereits existierende Lesson am Cluster hängt ("matched_lesson") und
deine Synthese semantisch dasselbe ausdrückt → setze reinforce=true und nimm
den bestehenden Lesson-Text unverändert.

Denke zuerst sichtbar in <think>...</think>, dann antworte mit GENAU EINEM
JSON-Objekt — kein Fließtext drum herum:
{
  "lesson":        "<1–2 Sätze, erste Person, Regel-Form>",
  "pattern_name":  "<kurzer kebab-case slug>",
  "confidence":    <0.0..1.0>,
  "reinforce":     <true wenn existierende Lesson wiederverwendet werden soll>
}

Wenn kein echtes Muster erkennbar ist: confidence < 0.3 setzen.`;

async function loadMembers(ids, { supabaseUrl, supabaseKey }) {
  const fields = "id,summary,outcome,valence,what_worked,what_failed,difficulty,task_type,created_at";
  const url    = `${supabaseUrl}/experiences?id=in.(${ids.join(",")})&select=${fields}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey":        supabaseKey,
      "Accept":        "application/json",
    },
  });
  if (!r.ok) throw new Error(`loadMembers HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function buildUserPrompt(cluster, members) {
  const lines = [
    `Cluster mit ${members.length} Episoden (avg_valence=${(cluster.avg_valence ?? 0).toFixed(2)}, outcomes=${(cluster.outcomes ?? []).join("/")}).`,
    "",
  ];
  members.forEach((m, i) => {
    lines.push(`[${i + 1}] outcome=${m.outcome ?? "?"} valence=${(m.valence ?? 0).toFixed(2)} difficulty=${(m.difficulty ?? 0).toFixed(2)} task=${m.task_type ?? "-"}`);
    lines.push(`    ${m.summary ?? "(no summary)"}`);
    if (m.what_worked) lines.push(`    ✔ ${m.what_worked}`);
    if (m.what_failed) lines.push(`    ✗ ${m.what_failed}`);
    lines.push("");
  });
  if (cluster.matched_lesson_id && cluster.matched_lesson_text) {
    lines.push(`matched_lesson (sim=${(cluster.matched_similarity ?? 0).toFixed(2)}): "${cluster.matched_lesson_text}"`);
  }
  return lines.join("\n");
}

/**
 * Strip Qwen3 / R1-Distill <think>…</think> reasoning blocks from a response,
 * then locate the JSON object that follows. Robust to:
 *   - multiple <think> blocks
 *   - prose before/after the JSON
 *   - models that occasionally emit ``` json fences
 */
function extractJSON(raw) {
  if (!raw) throw new Error("empty model response");
  // 1) Drop think blocks (greedy multi-line).
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // 2) Strip code fences if present.
  s = s.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  // 3) Locate the outermost {…}: first { to last }.
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j < 0 || j <= i) throw new Error(`no JSON object found in: ${raw.slice(0, 200)}`);
  const body = s.slice(i, j + 1);
  return JSON.parse(body);
}

async function callQwen({ systemPrompt, userPrompt, keepAlive = KEEP_ALIVE }) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:       MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      stream:      false,
      keep_alive:  keepAlive,
      // Ollama 0.20+ separates reasoning into `message.thinking` and the
      // final answer into `message.content`. Setting think:true activates
      // Qwen3's reasoning pathway cleanly — no <think> tag parsing
      // needed (extractJSON below stays as a defensive fallback for
      // older Ollama versions or models that embed think blocks
      // anyway). Bewusst KEIN format:"json" — würde mit Reasoning
      // kollidieren.
      think:       true,
      options:     { temperature: 0.3, num_ctx: NUM_CTX },
    }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const raw = j?.message?.content ?? "";
  const thinking = j?.message?.thinking ?? "";
  try {
    const parsed = extractJSON(raw);
    // Surface a thinking-length signal so nightly-sleep can log whether the
    // reasoning pathway actually fired. Empty thinking ≠ failure (older
    // Ollama / non-reasoning models simply don't return the field).
    if (thinking && parsed && typeof parsed === "object") {
      parsed._thinking_chars = thinking.length;
    }
    return parsed;
  }
  catch (e) { throw new Error(`Qwen response parse failed: ${e.message ?? e}\nraw: ${raw.slice(0, 300)}`); }
}

/** Explicitly unload the model from Ollama (free RAM for other workloads). */
export async function unloadQwen() {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
    });
  } catch { /* best-effort; nightly must not fail on unload */ }
}

/** Synthesize ONE cluster into a lesson payload. No DB writes here — caller decides record vs. reinforce. */
export async function synthesizeCluster(cluster, { supabaseUrl, supabaseKey }) {
  const members = await loadMembers(cluster.member_ids, { supabaseUrl, supabaseKey });
  if (members.length === 0) return { skipped: "no_members_found", confidence: 0 };
  const userPrompt = buildUserPrompt(cluster, members);
  const out = await callQwen({ systemPrompt: SYSTEM_PROMPT, userPrompt });
  const lesson       = typeof out?.lesson === "string" ? out.lesson.trim() : "";
  const pattern_name = typeof out?.pattern_name === "string" ? out.pattern_name.trim() : "";
  const confidence   = Math.max(0, Math.min(1, Number(out?.confidence) || 0));
  const reinforce    = Boolean(out?.reinforce) && Boolean(cluster.matched_lesson_id);
  return { lesson, pattern_name, confidence, reinforce, member_count: members.length };
}

// Standalone test: `node scripts/synthesize-cluster.mjs --dry`
// Lädt .mcp.json, zieht bis zu 3 Cluster, synthetisiert ohne DB-Write.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs   = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "..");
  const mcp  = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
  const env  = mcp.mcpServers["vector-memory"].env;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;
  const { createEmbeddingProvider } = await import(path.join(root, "mcp-server/dist/services/embeddings.js"));
  const { ExperienceService }       = await import(path.join(root, "mcp-server/dist/services/experiences.js"));
  const expSvc = new ExperienceService(SUPABASE_URL, SUPABASE_KEY, createEmbeddingProvider());
  const clusters = await expSvc.findClusters(0.85, 2, 30);
  console.error(`[dry] ${clusters.length} clusters`);
  for (const c of clusters.slice(0, 3)) {
    try {
      const synth = await synthesizeCluster(c, { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
      console.error(`[dry] seed=${c.seed_id} members=${c.member_count}`);
      console.error(`  → ${JSON.stringify(synth, null, 2)}`);
    } catch (e) {
      console.error(`[dry] seed=${c.seed_id} ERROR ${e?.message ?? e}`);
    }
  }
  await unloadQwen();
  console.error("[dry] model unloaded.");
}
