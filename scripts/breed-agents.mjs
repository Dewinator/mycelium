#!/usr/bin/env node
/**
 * breed-agents.mjs — CLI-Wrapper um IdentityService.createGenomeFromBreeding.
 *
 * Wird vom Dashboard-POST /breed gespawnt und aus der Shell für manuelle
 * Paarung verwendet. Ethik-Gate bleibt: --allow muss gesetzt sein.
 *
 * Aufruf:
 *   node scripts/breed-agents.mjs \
 *     --parent-a=main --parent-b=lab01 \
 *     --child=hybrid1 --mutation-rate=0.05 \
 *     --inheritance=full --allow
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "mcp-server", "dist");

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
  if (!m) continue;
  args[m[1]] = m[2] ?? true;
}

function fail(msg, code = 2) { console.error(`✗ ${msg}`); process.exit(code); }

const PARENT_A = args["parent-a"];
const PARENT_B = args["parent-b"];
const CHILD    = args.child;
const MUTATION = parseFloat(args["mutation-rate"] ?? "0.05");
const INHERIT  = args.inheritance ?? "full";
const ALLOW    = !!args.allow;
const NOTES    = args.notes || null;

if (!PARENT_A || !PARENT_B || !CHILD) fail("--parent-a, --parent-b, --child required");
if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(CHILD)) fail("--child must be lowercase/digits/hyphens, 2–31 chars");
if (!["none", "top", "full"].includes(INHERIT)) fail("--inheritance must be none|top|full");

const mcpCfg = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
for (const [k, v] of Object.entries(env)) process.env[k] ||= v;

const { IdentityService } = await import(path.join(DIST, "services/identity.js"));
const idTools             = await import(path.join(DIST, "tools/identity.js"));

const id = new IdentityService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

console.log(`=== breed-agents ===`);
console.log(`parents:     ${PARENT_A} × ${PARENT_B}`);
console.log(`child label: ${CHILD}`);
console.log(`mutation:    ${MUTATION}`);
console.log(`inheritance: ${INHERIT}`);
console.log(`consent:     ${ALLOW ? "✓ allow=true" : "✗ NOT SET"}`);

const result = await idTools.breedAgents(id, {
  parent_a: PARENT_A,
  parent_b: PARENT_B,
  child_label: CHILD,
  mutation_rate: MUTATION,
  inheritance_mode: INHERIT,
  allow_breeding: ALLOW,
  notes: NOTES ?? undefined,
});

const text = result?.content?.[0]?.text ?? JSON.stringify(result);
console.log("\n=== result ===");
console.log(text);
if (result.isError) process.exit(1);
