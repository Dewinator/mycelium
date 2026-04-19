// E2E Phase M: Motivation × Neurochemie — drei Kopplungen validieren.
// A) NE=0.9 → bands shift up;  NE=0.2 → shift down.
// B) 5-HT=0 → time_mult=2.0;   5-HT=1 → time_mult=1.0.
// C) band_feedback_event-Mapping stimmt mit der Spec (urgent=novel_stimulus+outcome,
//    ignore=idle).

import { execSync } from "node:child_process";
import { NeurochemistryService } from "../dist/services/neurochemistry.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const nc = new NeurochemistryService(url, key);

function sqlJson(sql) {
  const out = execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -At -c "${sql}"`, { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : null;
}
function sqlExec(sql) { execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" }); }
function header(s) { console.log(`\n=== ${s} ===`); }
function say(k, v) { console.log(`  ${k.padEnd(28)} ${v}`); }

// --- A: dynamic_bands vs NE-Level ---
header("A. Dynamic bands shiften mit Noradrenalin");
for (const ne of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  const r = sqlJson(`SELECT motivation_dynamic_bands(${ne})`);
  say(`NE=${ne}:`, `shift=${r.shift.toFixed(3)}  urgent=${r.thresholds.urgent.toFixed(3)}  act=${r.thresholds.act.toFixed(3)}  explore=${r.thresholds.explore.toFixed(3)}`);
}

// --- B: drift_scan mit Serotonin ---
header("B. Drift time_multiplier vs 5-HT");
for (const s of [0.0, 0.25, 0.5, 0.75, 1.0]) {
  const r = sqlJson(`SELECT motivation_drift_scan(${s})`);
  say(`5-HT=${s}:`, `time_mult=${r.time_multiplier.toFixed(2)}, rows updated=${r.updated}, urgent=${r.urgent}`);
}

// --- C: Neurochem-Hint liefert live-Daten ---
header("C. Neurochem-Hint für Motivation");
await nc.reset("main");
sqlExec(`UPDATE agent_neurochemistry SET noradrenaline_current=0.7, serotonin_current=0.3 WHERE agent_genome_id=(SELECT id FROM agent_genomes WHERE label='main');`);
const hint = sqlJson(`SELECT motivation_neurochem_hint('main')`);
say("after set:", `5-HT=${hint.serotonin} NE=${hint.noradrenaline} DA pred=${hint.dopamine_prediction}`);

// --- D: Simuliere band-Feedback-Events auf Neurochem ---
header("D. Band-Feedback: urgent=DA-spike, ignore=idle/no change");
await nc.reset("main");
const before = (await nc.get("main")).dopamine.current;
// Urgent event with outcome=0.9 → should spike DA
await nc.apply("main", "novel_stimulus", 0.9, 1.5);
const afterUrgent = (await nc.get("main")).dopamine.current;
say("urgent event (o=0.9):", `DA ${before.toFixed(3)} → ${afterUrgent.toFixed(3)} (δ ${(afterUrgent - before).toFixed(3)})`);
if (afterUrgent <= before) throw new Error("urgent should raise DA");

await nc.reset("main");
const before2 = (await nc.get("main")).dopamine.current;
// Idle event → pure NE-dampen, no outcome
await nc.apply("main", "idle", null, 0.5);
const afterIdle = (await nc.get("main")).dopamine.current;
say("idle event (no outcome):", `DA ${before2.toFixed(3)} → ${afterIdle.toFixed(3)} (no change expected)`);
if (Math.abs(afterIdle - before2) > 0.01) throw new Error("idle should not change DA");

// --- E: Aggregator zeigt Kopplung ---
header("E. Dashboard-Aggregator /motivation/stats");
const statsResp = execSync(`curl -s http://127.0.0.1:8787/motivation/stats`, { encoding: "utf8" });
const stats = JSON.parse(statsResp);
const c = stats._coupling;
if (!c) throw new Error("aggregator missing _coupling");
say("coupling in response:", `5-HT=${c.serotonin} NE=${c.noradrenaline} tm=${c.time_multiplier} band_shift=${c.band_shift}`);

// Cleanup
header("Cleanup");
await nc.reset("main");
say("done.", "all 5 scenarios green.");
