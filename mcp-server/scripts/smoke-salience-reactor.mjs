#!/usr/bin/env node
// Smoke test for SalienceReactor: build a synthetic BusEvent for each
// dispatch branch, call .handle() against the live DB, verify salience
// moves on the targeted experience row. Not part of `npm test` because
// it needs a running Supabase — run manually after Phase 2 changes.
//
// Usage:
//   cd mcp-server && node scripts/smoke-salience-reactor.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SalienceReactor } from "../dist/agents/salience-reactor.js";
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

async function pickExperience() {
  const { data, error } = await db.from("experiences").select("id,salience").limit(1);
  if (error) throw new Error(`pickExperience: ${error.message}`);
  return data[0];
}

async function readSalience(id) {
  const { data, error } = await db.from("experiences").select("salience").eq("id", id).single();
  if (error) throw new Error(`readSalience: ${error.message}`);
  return data.salience;
}

const reactor = new SalienceReactor(SUPABASE_URL, SUPABASE_KEY);

const scenarios = [
  {
    name:  "mark_useful (experience source)",
    event: {
      id: "evt-mu", memory_id: null, event_type: "mark_useful",
      source: "mcp:mark_experience_useful", trace_id: null,
      created_at: new Date().toISOString(),
    },
    expected_delta_sign: +1,
  },
  {
    name:  "agent_completed",
    event: {
      id: "evt-ac", memory_id: null, event_type: "agent_completed",
      source: "mcp:record_experience", trace_id: null,
      created_at: new Date().toISOString(),
    },
    expected_delta_sign: +1,
  },
  {
    name:  "agent_error",
    event: {
      id: "evt-ae", memory_id: null, event_type: "agent_error",
      source: "mcp:record_experience", trace_id: null,
      created_at: new Date().toISOString(),
    },
    expected_delta_sign: -1,
  },
  {
    name:  "mark_useful (memory source — should be skipped)",
    event: {
      id: "evt-mum", memory_id: "00000000-0000-0000-0000-000000000001", event_type: "mark_useful",
      source: "mcp:mark_useful", trace_id: null,
      created_at: new Date().toISOString(),
    },
    expected_delta_sign: 0,
  },
  {
    name:  "recalled (no row target — should be skipped)",
    event: {
      id: "evt-rc", memory_id: null, event_type: "recalled",
      source: "mcp:recall", trace_id: null,
      created_at: new Date().toISOString(),
    },
    expected_delta_sign: 0,
  },
];

let pass = 0, fail = 0;

for (const sc of scenarios) {
  const exp = await pickExperience();
  const ev = { ...sc.event, context: { experience_id: exp.id } };
  // For the skip scenarios (memory source / recalled), context.experience_id
  // shouldn't matter — but we leave it set to verify the dispatch is
  // discriminating on event_type+source rather than just on context.

  const before = await readSalience(exp.id);
  await reactor.handle(ev, /* bus */ null);
  const after = await readSalience(exp.id);
  const sign  = Math.sign(after - before);

  const ok = sign === sc.expected_delta_sign;
  console.log(`${ok ? "✓" : "✗"} ${sc.name}: ${before.toFixed(4)} → ${after.toFixed(4)} (expected sign ${sc.expected_delta_sign}, got ${sign})`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
