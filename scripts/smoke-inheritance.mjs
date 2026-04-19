#!/usr/bin/env node
// E2E: breed a test child with full inheritance, show counts, then delete it.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "mcp-server", "dist");
const mcpCfg = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
for (const [k, v] of Object.entries(env)) process.env[k] ||= v;

const { IdentityService } = await import(path.join(DIST, "services/identity.js"));
const idTools             = await import(path.join(DIST, "tools/identity.js"));
const id = new IdentityService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function show(label, out) {
  const text = out?.content?.[0]?.text ?? JSON.stringify(out);
  console.log(`\n=== ${label} ===\n${text}`);
}

// refuses without consent
show("breed_agents (no consent)", await idTools.breedAgents(id, {
  parent_a: "main", parent_b: "main", child_label: "inherit_smoke", mutation_rate: 0.05,
}));

// with explicit consent + full inheritance (using 'main' as both parents is a degenerate but valid test)
show("breed_agents (full inheritance, allow=true)", await idTools.breedAgents(id, {
  parent_a: "main", parent_b: "main",
  child_label: "inherit_smoke", mutation_rate: 0.05,
  allow_breeding: true, inheritance_mode: "full",
  notes: "smoke-test: inherit-everything-from-main",
}));

show("genome_inheritance(inherit_smoke)", await idTools.genomeInheritance(id, { label: "inherit_smoke" }));

// cleanup: delete the test genome directly via PostgREST
const resp = await fetch(
  `${process.env.SUPABASE_URL}/agent_genomes?label=eq.inherit_smoke`,
  { method: "DELETE", headers: {
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      apikey: process.env.SUPABASE_KEY,
  }}
);
console.log(`\ncleanup: DELETE /agent_genomes?label=eq.inherit_smoke → HTTP ${resp.status}`);
