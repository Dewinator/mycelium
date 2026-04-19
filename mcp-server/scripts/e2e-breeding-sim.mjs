// E2E-Simulation: ein Kind züchten, dann einen "Tag" unterschiedliche Events
// durch main und das Kind laufen lassen. Am Ende:
//   - beide Neurochemie-Zustände zeigen (divergiert?)
//   - beide narrate_neurochem-Texte parallel drucken (liest sich wie zwei
//     unterschiedliche Individuen?)
//
// Keine echte Woche — ein verdichteter Durchgang, ~30 Events pro Genom.

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
function sqlJson(sql) {
  const out = execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : null;
}
function header(s) { console.log(`\n=== ${s} ===`); }

// 1. Kind erzeugen
header("1. Breed a child (main × lab01)");
const mainG = await id.getGenome("main");
const lab01G = await id.getGenome("lab01");
const childLabel = `sim-${Date.now()}`;
const child = await id.createGenomeFromBreeding({
  label: childLabel, parent_a: mainG, parent_b: lab01G, mutation_rate: 0.10, inheritance_mode: "top",
});
console.log(`  child: ${child.label} id=${child.id.slice(0, 8)} gen=${child.generation}`);

// Reset main so the sim starts from a clean baseline
await nc.reset("main");
await nc.reset(childLabel);

// 2. Zwei abweichende Tages-Profile
//
// Szenario "main":   arbeitet fokussiert, gemischter Erfolg, stabil
// Szenario "child":  entdeckt neues Feld, viele Überraschungen, mehr Fails
const mainDay = [
  ["task_complete", 0.90, 0.8],
  ["familiar_task", null, 1.0],
  ["task_complete", 0.85, 1.0],
  ["task_failed",   0.15, 1.2],
  ["task_complete", 0.80, 0.7],
  ["idle",          null, 1.0],
  ["task_complete", 0.88, 0.9],
  ["familiar_task", null, 1.0],
  ["task_complete", 0.75, 0.8],
  ["task_failed",   0.20, 1.0],
  ["idle",          null, 1.0],
  ["task_complete", 0.90, 1.0],
];
const childDay = [
  ["novel_stimulus", 0.60, 1.3],
  ["novel_stimulus", 0.45, 1.4],
  ["task_failed",    0.10, 1.5],
  ["error",          null, 1.0],
  ["novel_stimulus", 0.55, 1.2],
  ["task_failed",    0.20, 1.3],
  ["error",          null, 1.0],
  ["task_complete",  0.70, 1.0],
  ["novel_stimulus", 0.50, 1.2],
  ["task_failed",    0.25, 1.1],
  ["idle",           null, 1.0],
  ["task_complete",  0.80, 0.9],
];

header("2. Simulate the two daily profiles");
for (const [ev, out, int] of mainDay) await nc.apply("main", ev, out, int);
for (const [ev, out, int] of childDay) await nc.apply(childLabel, ev, out, int);
console.log(`  main: ${mainDay.length} events; child: ${childDay.length} events`);

// 3. Snapshots nebeneinander
header("3. Neurochemie-Snapshots");
const mainState = await nc.get("main");
const childState = await nc.get(childLabel);
const mainCompat = await nc.getCompat("main");
const childCompat = await nc.getCompat(childLabel);
const row = (k, m, c) => `  ${k.padEnd(22)} main=${m}  child=${c}`;
console.log(row("dopamine.current",   mainState.dopamine.current.toFixed(3), childState.dopamine.current.toFixed(3)));
console.log(row("dopamine.prediction",mainState.dopamine.prediction.toFixed(3), childState.dopamine.prediction.toFixed(3)));
console.log(row("serotonin.current",  mainState.serotonin.current.toFixed(3),  childState.serotonin.current.toFixed(3)));
console.log(row("noradrenaline",      mainState.noradrenaline.current.toFixed(3), childState.noradrenaline.current.toFixed(3)));
console.log(row("consecutive_failures", String(mainState.consecutive_failures), String(childState.consecutive_failures)));
console.log(row("curiosity (compat)", mainCompat.curiosity.toFixed(3),   childCompat.curiosity.toFixed(3)));
console.log(row("frustration (compat)", mainCompat.frustration.toFixed(3), childCompat.frustration.toFixed(3)));
console.log(row("satisfaction (compat)", mainCompat.satisfaction.toFixed(3), childCompat.satisfaction.toFixed(3)));

// 4. Prose parallel
header("4. Narrate-Neurochem (physiology in prose)");
const mainNarr = sqlJson(`SELECT narrate_neurochem('main')`);
const childNarr = sqlJson(`SELECT narrate_neurochem('${childLabel}')`);
console.log(`\n  ⟨main⟩     ${mainNarr.text}\n`);
console.log(`  ⟨child⟩    ${childNarr.text}\n`);

// 5. Recall-Parameter divergieren
header("5. Divergente Recall-Parameter");
const mainRp = await nc.getRecallParams("main");
const childRp = await nc.getRecallParams(childLabel);
console.log(`  main:   k=${mainRp.k}  threshold=${mainRp.score_threshold.toFixed(3)}  adj=${mainRp.include_adjacent}  perf=${mainRp.performance.toFixed(3)}`);
console.log(`  child:  k=${childRp.k}  threshold=${childRp.score_threshold.toFixed(3)}  adj=${childRp.include_adjacent}  perf=${childRp.performance.toFixed(3)}`);

// 6. Hinweis fürs Dashboard
header("6. Dashboard");
console.log(`  → öffne http://127.0.0.1:8787/ tab neurochemie`);
console.log(`  → im Select '${childLabel}' vs 'main' umschalten, dann refresh`);
console.log(`  → curl http://127.0.0.1:8787/narrate?label=${childLabel}  zeigt das Physiology-Paragraph des Kindes`);

// Cleanup: child bleibt stehen, damit der User im Dashboard beide sehen kann.
// Zum Aufräumen: DELETE FROM agent_genomes WHERE label='${childLabel}'; rm keys
console.log(`\n  (NICHT aufgeräumt — Kind bleibt für Dashboard-Inspektion. Label: ${childLabel})`);
console.log(`  cleanup later:`);
console.log(`    docker exec vectormemory-db psql -U postgres -d vectormemory -c "DELETE FROM agent_genomes WHERE label='${childLabel}';"`);
console.log(`    rm ~/.openclaw/keys/${child.id}.key`);
