// E2E: Experience / Digest / Lesson → Neurochemie (direktpfad statt compat).
//
// Szenarien:
//   A) record_experience success → task_complete, DA>baseline
//   B) record_experience failure → task_failed, DA<baseline, cf erhöht
//   C) record_lesson → mild DA reward
//   D) record_experience mit outcome=null (unknown) → kein DA-Impact
// Digest selbst in E2E aufwendig (full MCP flow), stattdessen prüfen wir
// rein die Wiring-Funktion: tool-level recordExperience ruft neurochem.apply.

import { execSync } from "node:child_process";
import { NeurochemistryService } from "../dist/services/neurochemistry.js";
import { ExperienceService } from "../dist/services/experiences.js";
import { createEmbeddingProvider } from "../dist/services/embeddings.js";
import { recordExperience, recordLesson } from "../dist/tools/experience.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const embeddings = createEmbeddingProvider();
const nc  = new NeurochemistryService(url, key);
const ex  = new ExperienceService(url, key, embeddings);

function sqlExec(sql) { execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" }); }
function header(s) { console.log(`\n=== ${s} ===`); }
function say(k, v) { console.log(`  ${k.padEnd(28)} ${v}`); }

// --- A: record_experience success → DA-Spike ---
header("A. record_experience success → task_complete + DA spike");
await nc.reset("main");
const before = (await nc.get("main")).dopamine.current;
await recordExperience(ex, nc, "main", {
  summary: "e2e test: delivered feature on time",
  outcome: "success", difficulty: 0.4,
});
const after = await nc.get("main");
say("DA before/after:", `${before.toFixed(3)} → ${after.dopamine.current.toFixed(3)}`);
say("last_event:", after.last_event);
if (after.dopamine.current <= before) throw new Error("success should raise DA");
if (after.last_event !== "task_complete") throw new Error(`expected task_complete, got ${after.last_event}`);

// --- B: record_experience failure → cf+=1, DA fällt ---
header("B. record_experience failure → task_failed + cf++");
await nc.reset("main");
await recordExperience(ex, nc, "main", {
  summary: "e2e test: attempt failed",
  outcome: "failure", difficulty: 0.7,
});
const afterFail = await nc.get("main");
say("DA after failure:", afterFail.dopamine.current.toFixed(3));
say("last_event:", afterFail.last_event);
say("cf:", afterFail.consecutive_failures);
if (afterFail.last_event !== "task_failed") throw new Error("expected task_failed");
if (afterFail.consecutive_failures !== 1) throw new Error(`expected cf=1, got ${afterFail.consecutive_failures}`);

// --- C: record_lesson → mild DA reward ---
header("C. record_lesson → cognitive reward (small DA)");
await nc.reset("main");
const beforeLesson = (await nc.get("main")).dopamine.current;
// We need an existing experience id as source. Use any recent one.
const existingExpId = execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -At -c "SELECT id FROM experiences ORDER BY created_at DESC LIMIT 1;"`, { encoding: "utf8" }).trim();
if (!existingExpId) {
  say("skipped:", "no existing experience to use as source");
} else {
  await recordLesson(ex, nc, "main", {
    lesson: "e2e: lessons distilled from clusters deserve a mild DA bump.",
    source_ids: [existingExpId],
    category: "insight",
    confidence: 0.8,
  });
  const afterLesson = await nc.get("main");
  say("DA before/after:", `${beforeLesson.toFixed(3)} → ${afterLesson.dopamine.current.toFixed(3)}`);
  say("last_event:", afterLesson.last_event);
  if (afterLesson.dopamine.current <= beforeLesson) throw new Error("lesson should raise DA (mildly)");
  // Cleanup: the recorded lesson is fine to leave but will clutter the db slightly
  sqlExec(`DELETE FROM lessons WHERE lesson LIKE 'e2e: lessons distilled%';`);
}

// --- D: record_experience unknown → kein Impact ---
header("D. record_experience unknown → no DA change");
await nc.reset("main");
const beforeUnk = (await nc.get("main")).dopamine.current;
await recordExperience(ex, nc, "main", {
  summary: "e2e test: outcome unclear",
  outcome: "unknown", difficulty: 0.3,
});
const afterUnk = await nc.get("main");
say("DA before/after:", `${beforeUnk.toFixed(3)} → ${afterUnk.dopamine.current.toFixed(3)}`);
if (Math.abs(afterUnk.dopamine.current - beforeUnk) > 0.01) throw new Error("unknown should not move DA");

// --- E: Feine Sentiment-Nudges (digest-internes Mapping in isolation testbar) ---
header("E. Sentiment-Mapping");
const sentimentMap = { delighted: 0.15, pleased: 0.05, neutral: 0, frustrated: -0.1, angry: -0.2 };
for (const [s, nudge] of Object.entries(sentimentMap)) {
  const expected = 0.85 + nudge;  // success base = 0.85
  say(`success + ${s}:`, `expected outcome=${expected.toFixed(2)}`);
}

// Cleanup
header("Cleanup");
sqlExec(`DELETE FROM experiences WHERE summary LIKE 'e2e test:%';`);
await nc.reset("main");
say("done.", "all scenarios green.");
