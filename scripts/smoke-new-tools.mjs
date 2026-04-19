#!/usr/bin/env node
// Smoke-Test fuer die neu registrierten MCP-Tools (Motivation + Identity).
// Benoetigt SUPABASE_URL + SUPABASE_KEY im Env (oder aus .mcp.json).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpCfg = JSON.parse(await fs.readFile(path.resolve(__dirname, "../.mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
process.env.SUPABASE_URL ||= env.SUPABASE_URL;
process.env.SUPABASE_KEY ||= env.SUPABASE_KEY;
process.env.OLLAMA_URL   ||= env.OLLAMA_URL;
process.env.EMBEDDING_MODEL ||= env.EMBEDDING_MODEL;

const DIST = path.resolve(__dirname, "../mcp-server/dist");

const { MotivationService }  = await import(path.join(DIST, "services/motivation.js"));
const { IdentityService }    = await import(path.join(DIST, "services/identity.js"));
const motTools     = await import(path.join(DIST, "tools/motivation.js"));
const idTools      = await import(path.join(DIST, "tools/identity.js"));

const mot = new MotivationService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const id  = new IdentityService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function print(label, out) {
  const text = out?.content?.[0]?.text ?? JSON.stringify(out);
  console.log(`\n=== ${label} ===\n${text.slice(0, 1500)}`);
}

print("motivation_status", await motTools.motivationStatus(mot, {}));
print("list_generated_tasks(proposed)",
  await motTools.listGeneratedTasks(mot, { status: "proposed", limit: 5 }));
print("list_stimuli(band=urgent)",
  await motTools.listStimuli(mot, { band: "urgent", since_hours: 168, limit: 5 }));

print("list_agents", await idTools.listAgents(id, {}));
print("snapshot_fitness(main)", await idTools.snapshotFitness(id, { label: "main", window_days: 30 }));
print("update_self_model", await idTools.updateSelfModel(id, { window_days: 30, persist: true }));
print("get_self_model", await idTools.getSelfModel(id, {}));

// breeding should REFUSE without consent
print("breed_agents (no consent → should refuse)", await idTools.breedAgents(id, {
  parent_a: "main", parent_b: "main", child_label: "testchild", mutation_rate: 0.05
}));

print("list_emergence", await idTools.listEmergence(id, { limit: 5, only_open: false }));
