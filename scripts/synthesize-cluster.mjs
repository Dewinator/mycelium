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

const SYSTEM_PROMPT = `Du bist der REM-Synthesizer eines persistenten Gedächtnisses.

Eingabe: 3–10 Episoden (Experiences), die sich semantisch ähneln (Vektor-Cluster).
Aufgabe: Erkenne das verbindende Muster und formuliere EINE abstrakte Lesson,
die in kommenden Entscheidungen als Regel dient. Erste Person, 1–2 Sätze.

Wenn eine bereits existierende Lesson am Cluster hängt ("matched_lesson") und
deine Synthese semantisch dasselbe ausdrückt → setze reinforce=true und nimm
den bestehenden Lesson-Text unverändert.

Antworte AUSSCHLIESSLICH als valides JSON:
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
      format:      "json",
      options:     { temperature: 0.3, num_ctx: NUM_CTX },
    }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const raw = j?.message?.content ?? "";
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`Qwen response not JSON: ${raw.slice(0, 200)}`); }
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
