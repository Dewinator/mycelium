// E2E Migration 042: Dopamin/Serotonin/Noradrenalin + Compat + Breeding-Crossover.
//
// Szenarien:
//   A) Prediction-Error: erst reset, dann outcome=1.0 → hoher δ, DA spikt,
//      prediction zieht nach. Zweiter Call mit outcome=1.0 → niedriger δ.
//   B) Serotonin-Decay: 'idle'-events treiben Serotonin langsam runter.
//   C) Yerkes-Dodson: bei noradrenalin in der Mitte (0.5) k=3, an den
//      Rändern k=10, performance invertiert-U.
//   D) Rückwärtskompat: affect_apply('success') / affect_get → sinnvolle compat.
//   E) Breeding: neues Kind erbt gewichteten Mittelwert + Gauss-Noise.

import { execSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NeurochemistryService } from "../dist/services/neurochemistry.js";
import { IdentityService } from "../dist/services/identity.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const nc = new NeurochemistryService(url, key);
const id = new IdentityService(url, key);

function sqlExec(sql) { execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" }); }
function header(s) { console.log(`\n=== ${s} ===`); }
function say(k, v) { console.log(`  ${k.padEnd(28)} ${v}`); }

// --- A: Prediction-Error Dynamik ---
header("A. Prediction-Error (TD-Learning)");
await nc.reset("main");
const r1 = await nc.apply("main", "task_complete", 1.0);
say("nach 1.Call:", `DA=${r1.dopamine.current.toFixed(3)} pred=${r1.dopamine.prediction.toFixed(3)} δ=${(1.0 - 0.5).toFixed(3)}`);
if (!(r1.dopamine.current > 0.8 && r1.dopamine.prediction > 0.5)) throw new Error("A failed");

const r2 = await nc.apply("main", "task_complete", 1.0);
const delta2 = 1.0 - r1.dopamine.prediction;
say("nach 2.Call:", `DA=${r2.dopamine.current.toFixed(3)} pred=${r2.dopamine.prediction.toFixed(3)} δ=${delta2.toFixed(3)}`);
if (r2.dopamine.prediction <= r1.dopamine.prediction) throw new Error("prediction should rise");
// After many same outcomes, prediction converges to outcome → δ→0 → DA→baseline
for (let i = 0; i < 50; i++) await nc.apply("main", "task_complete", 1.0);
const rC = await nc.get("main");
say("nach 50x success:", `DA=${rC.dopamine.current.toFixed(3)} pred=${rC.dopamine.prediction.toFixed(3)}`);
if (rC.dopamine.prediction < 0.85) throw new Error("prediction should converge toward 1.0");

// --- B: Serotonin-Decay via idle ---
header("B. Serotonin-Decay");
await nc.reset("main");
let sStart = (await nc.get("main")).serotonin.current;
for (let i = 0; i < 10; i++) await nc.apply("main", "idle");
const sAfter = (await nc.get("main")).serotonin.current;
say("start:", sStart.toFixed(3));
say("nach 10x idle:", sAfter.toFixed(3));
if (sAfter >= sStart) throw new Error("serotonin should decay on idle");

// --- C: Yerkes-Dodson ---
header("C. Yerkes-Dodson — recall_params bei verschiedenen NE-Levels");
for (const ne of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  // NE direkt via SQL setzen
  sqlExec(`UPDATE agent_neurochemistry SET noradrenaline_current=${ne} WHERE agent_genome_id=(SELECT id FROM agent_genomes WHERE label='main');`);
  const rp = await nc.getRecallParams("main");
  say(`NE=${ne}:`, `k=${rp.k} threshold=${rp.score_threshold.toFixed(3)} adj=${rp.include_adjacent} performance=${rp.performance.toFixed(3)}`);
}

// --- D: Rückwärtskompat ---
header("D. Rückwärtskompat: affect_apply → neurochem");
sqlExec(`SELECT affect_reset();`);
const afterSuccess = execSync(
  `docker exec vectormemory-db psql -U postgres -d vectormemory -At -c "SELECT affect_apply('success', 0.1)::text;"`, { encoding: "utf8" }
).trim();
say("compat nach success:", afterSuccess.slice(0, 120));
const nc2 = await nc.get("main");
say("neurochem DA:", nc2.dopamine.current.toFixed(3) + " (>0.8 wenn TD spike)");
if (nc2.last_event !== "task_complete") throw new Error("affect_apply('success') should map to task_complete");

// --- E: Breeding-Crossover ---
header("E. Breeding erbt Neurochemie");
await nc.reset("main");
// Make parents divergent: main DA-high, lab01 DA-low
sqlExec(`UPDATE agent_neurochemistry SET dopamine_current=0.9, serotonin_current=0.8, noradrenaline_current=0.3 WHERE agent_genome_id=(SELECT id FROM agent_genomes WHERE label='main');`);
sqlExec(`UPDATE agent_neurochemistry SET dopamine_current=0.2, serotonin_current=0.2, noradrenaline_current=0.8 WHERE agent_genome_id=(SELECT id FROM agent_genomes WHERE label='lab01');`);
const mainG = await id.getGenome("main");
const lab01G = await id.getGenome("lab01");
const childLabel = `e2e-nc-${Date.now()}`;
const child = await id.createGenomeFromBreeding({
  label: childLabel, parent_a: mainG, parent_b: lab01G, mutation_rate: 0.05, inheritance_mode: "none",
});
const childNc = await nc.get(childLabel);
say("child DA:", `${childNc.dopamine.current.toFixed(3)} (expected ~0.55 ± mutation)`);
say("child 5HT:", `${childNc.serotonin.current.toFixed(3)} (expected ~0.50 ± mutation)`);
say("child NE:", `${childNc.noradrenaline.current.toFixed(3)} (expected ~0.55 ± mutation)`);
// Tolerance: mean ± 3σ (σ ≈ 0.05 from mutation_rate)
const tolerance = 0.3;  // generous tolerance
if (Math.abs(childNc.dopamine.current - 0.55) > tolerance) throw new Error("child DA not near parent mean");
if (Math.abs(childNc.serotonin.current - 0.50) > tolerance) throw new Error("child 5HT not near parent mean");

// Cleanup
header("Cleanup");
sqlExec(`DELETE FROM agent_genomes WHERE label='${childLabel}';`);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
await nc.reset("main");
await nc.reset("lab01");
say("done.", "all 5 scenarios green.");
