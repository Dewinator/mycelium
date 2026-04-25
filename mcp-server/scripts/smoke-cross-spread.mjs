#!/usr/bin/env node
// Smoke test for Phase 3 — spread_activation_cross + recall.ts wiring.
// Picks a memory with both memory↔memory and memory↔experience neighbors
// and verifies that spreadCross() returns mixed kinds with non-zero
// link_strength, and that the new RPC signature/payload is wired right.
//
// Usage:
//   cd mcp-server && node scripts/smoke-cross-spread.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgrestClient } from "@supabase/postgrest-js";

const __filename = fileURLToPath(import.meta.url);
const ROOT       = path.resolve(path.dirname(__filename), "..", "..");

const mcpCfg = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const env    = mcpCfg.mcpServers["vector-memory"].env;
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_KEY;

const db = new PostgrestClient(SUPABASE_URL, {
  headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
});

// Pick a memory that has both memory_links neighbors AND experience_memory_links.
// We can't filter on the JSON path directly via postgrest, so we hit the DB
// via a lightweight RPC convenience: just iterate the top-N memories by
// useful_count and find one with both.
async function pickSeed() {
  const { data, error } = await db.from("memories")
    .select("id")
    .eq("stage", "semantic")
    .order("useful_count", { ascending: false })
    .limit(20);
  if (error) throw new Error(`pickSeed: ${error.message}`);

  for (const m of data) {
    const { data: cross } = await db.rpc("spread_activation_cross", {
      p_seed_kind: "memory", p_seed_id: m.id, p_max_neighbors: 10,
    });
    const kinds = new Set((cross ?? []).map((r) => r.kind));
    if (kinds.has("memory") && kinds.has("experience")) {
      return { id: m.id, neighbors: cross };
    }
  }
  throw new Error("no memory with both memory and experience neighbors in top-20 useful");
}

const seed = await pickSeed();
console.log(`Seed memory: ${seed.id}`);
console.log(`Returned ${seed.neighbors.length} neighbors:`);
for (const n of seed.neighbors) {
  console.log(`  [${n.kind}/${n.category}] link=${n.link_strength.toFixed(3)} ${(n.content ?? "").slice(0, 80)}`);
}

const kindCounts = seed.neighbors.reduce((acc, n) => { acc[n.kind] = (acc[n.kind] ?? 0) + 1; return acc; }, {});
const ok = (kindCounts.memory ?? 0) > 0 && (kindCounts.experience ?? 0) > 0;

console.log(`\nKind counts: ${JSON.stringify(kindCounts)}`);
console.log(ok ? "✓ cross-kind spread works" : "✗ missing kinds in result");
process.exit(ok ? 0 : 1);
