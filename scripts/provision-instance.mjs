#!/usr/bin/env node
/**
 * provision-instance.mjs — reproduzierbares Setup einer weiteren OpenClaw-Instanz.
 *
 * WICHTIG: Dieses Skript *ergaenzt* OpenClaw. Es ersetzt nicht dessen Config.
 * Es erzeugt einen isolierten Workspace, generiert LaunchAgents mit
 * Port-Offsets und schreibt eine fertige MCP-Konfig ins neue Workspace —
 * fertig zum Einbinden in OpenClaw.
 *
 * Aufruf:
 *   node scripts/provision-instance.mjs \
 *     --label=dev2                       \   # unique instance-label
 *     --parent=main                      \   # genome to seed from (default: main)
 *     --port-offset=100                  \   # adds to default ports (18789 → 18889 etc.)
 *     --workspace=${HOME}/.openclaw-dev2  \ # target dir (default: ~/.openclaw-<label>)
 *     --dry-run                          \   # print plan, change nothing
 *
 * Erzeugt:
 *   1. Genome-Row  'dev2' in agent_genomes (Gen 1, ohne Eltern — oder Kind wenn --parent angegeben)
 *   2. Workspace-Dir mit SOUL.md / AGENTS.md / TOOLS.md aus Template
 *   3. .mcp.json im Workspace mit offset Ports + Agent-Label
 *   4. LaunchAgent plists fuer belief / motivation / sleep (mit Instance-Suffix)
 *   5. Registry-Eintrag in der agents-Tabelle (beim ersten MCP-Start)
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");

// --- arg parsing ----------------------------------------------------------
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
  if (!m) continue;
  args[m[1]] = m[2] ?? true;
}
if (args.help || args.h) {
  console.log(`provision-instance.mjs

Flags:
  --label=<s>           unique instance label (required)
  --parent=<s>          parent genome label (default: main)
  --port-offset=<n>     default 100; child ports = base + offset
  --workspace=<path>    default: ~/.openclaw-<label>
  --gateway-port=<n>    default: 18789+offset
  --belief-port=<n>     default: 18790+offset
  --motivation-port=<n> default: 18792+offset
  --dashboard-port=<n>  default: 8787+offset
  --cockpit-port=<n>    default: 8767+offset
  --base-model=<s>      default: inherited from parent (documentary only)
  --teacher-model=<s>   default: inherited from parent (documentary only)
  --dry-run             print plan, write nothing
  --force               overwrite existing workspace dir
`);
  process.exit(0);
}

const LABEL = args.label;
if (!LABEL || typeof LABEL !== "string" || !LABEL.match(/^[a-z0-9][a-z0-9-]{1,30}$/)) {
  console.error("--label is required, must be lowercase/digits/hyphens, 2–31 chars.");
  process.exit(2);
}
const PARENT = args.parent || "main";
const OFFSET = parseInt(args["port-offset"] || "100", 10);
const WORKSPACE = args.workspace || path.join(os.homedir(), `.openclaw-${LABEL}`);
const HOME = os.homedir();
const DRY = !!args["dry-run"];
const FORCE = !!args.force;

const PORTS = {
  gateway:    parseInt(args["gateway-port"]    || String(18789 + OFFSET), 10),
  belief:     parseInt(args["belief-port"]     || String(18790 + OFFSET), 10),
  motivation: parseInt(args["motivation-port"] || String(18792 + OFFSET), 10),
  dashboard:  parseInt(args["dashboard-port"]  || String(8787 + OFFSET),  10),
  cockpit:    parseInt(args["cockpit-port"]    || String(8767 + OFFSET),  10),
};

// --- load Supabase creds from root .mcp.json ------------------------------
const rootMcp = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
const ENV     = rootMcp.mcpServers["vector-memory"].env;

// --- REST helpers ---------------------------------------------------------
const REST = ENV.SUPABASE_URL.replace(/\/$/, "");
const HDRS = {
  "Content-Type":  "application/json",
  "Accept":        "application/json",
  "Authorization": `Bearer ${ENV.SUPABASE_KEY}`,
  "apikey":        ENV.SUPABASE_KEY,
};

async function rpc(name, body) {
  const r = await fetch(`${REST}/rpc/${name}`, {
    method: "POST", headers: HDRS, body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`rpc ${name} → HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
async function getRows(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${REST}${path}${qs ? "?" + qs : ""}`, { headers: HDRS });
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

// --- plan + execute -------------------------------------------------------
async function main() {
  console.log(`=== provision-instance: ${LABEL} ===`);
  console.log(`workspace:    ${WORKSPACE}`);
  console.log(`parent:       ${PARENT}`);
  console.log(`port offset:  +${OFFSET}`);
  console.log(`ports:        ${JSON.stringify(PORTS)}`);
  console.log(`dry-run:      ${DRY}`);

  // 1. check parent genome exists
  const parents = await getRows("/agent_genomes", { label: `eq.${PARENT}`, select: "id,label,base_model,teacher_model,values,interests,curiosity_baseline,frustration_threshold,exploration_rate,risk_tolerance,generation,workspace_path" });
  if (!parents.length) throw new Error(`parent genome '${PARENT}' does not exist`);
  const parent = parents[0];
  console.log(`✓ parent found: ${parent.label} (gen ${parent.generation})`);

  // 2. check label free
  const existing = await getRows("/agent_genomes", { label: `eq.${LABEL}`, select: "id" });
  if (existing.length && !FORCE) {
    throw new Error(`genome '${LABEL}' already exists (use --force to overwrite intention)`);
  }

  // 3. plan workspace files
  const wsExists = await fs.stat(WORKSPACE).then(() => true).catch(() => false);
  if (wsExists && !FORCE) {
    throw new Error(`workspace '${WORKSPACE}' already exists (use --force to overwrite)`);
  }

  const plan = {
    genome: {
      label: LABEL,
      generation: 1, // new seed genome — breed_agents separately if you want descendance
      values: parent.values,
      interests: parent.interests,
      curiosity_baseline: parent.curiosity_baseline,
      frustration_threshold: parent.frustration_threshold,
      exploration_rate: parent.exploration_rate,
      risk_tolerance: parent.risk_tolerance,
      base_model: args["base-model"] || parent.base_model,
      teacher_model: args["teacher-model"] || parent.teacher_model,
      workspace_path: WORKSPACE,
      notes: `Provisioned ${new Date().toISOString()} from ${parent.label}. Documentary model fields — authority stays with OpenClaw config.`,
    },
    workspace_files: [
      "SOUL.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md", "MEMORY.md",
    ],
    mcp_config_path: path.join(WORKSPACE, ".mcp.json"),
    launch_agents: [
      {
        label: `ai.openclaw.motivation.${LABEL}`,
        path: `${HOME}/Library/LaunchAgents/ai.openclaw.motivation.${LABEL}.plist`,
        port_env: "MOTIVATION_PORT",
        port: PORTS.motivation,
        program: `${HOME}/.openclaw/motivation/.venv/bin/python3`,
        args: [`${HOME}/.openclaw/motivation/server.py`],
      },
      {
        label: `ai.openclaw.sleep.${LABEL}`,
        path: `${HOME}/Library/LaunchAgents/ai.openclaw.sleep.${LABEL}.plist`,
        port_env: null,
        program: "/usr/bin/env",
        args: ["node", path.join(ROOT, "scripts/nightly-sleep.mjs")],
        schedule: { Hour: 3, Minute: (OFFSET % 59) }, // staggered
      },
      // Belief-sidecar: single shared instance, nicht pro agent dupliziert.
      // Belief wird erst pro-agent nötig, wenn wir Multi-Tenancy auf dem PyMDP wollen.
    ],
  };

  console.log("\n=== plan ===");
  console.log(JSON.stringify(plan, null, 2));

  if (DRY) {
    console.log("\n(dry-run — nothing written)");
    return;
  }

  // 4. actually write it -------------------------------------------------
  console.log("\n=== executing ===");

  await fs.mkdir(WORKSPACE, { recursive: true });
  console.log(`mkdir ${WORKSPACE}`);

  // copy template workspace files from parent
  const TEMPLATE = parent.workspace_path || `${HOME}/.openclaw/workspace`;
  for (const f of plan.workspace_files) {
    const src = path.join(TEMPLATE, f);
    const dst = path.join(WORKSPACE, f);
    try {
      const raw = await fs.readFile(src, "utf8");
      let out = raw;
      if (f === "SOUL.md") {
        out = `<!-- Provisioned ${new Date().toISOString()} from ${parent.label}. Edit freely. -->\n\n${raw}`;
      }
      await fs.writeFile(dst, out);
      console.log(`  ${f}  →  ${dst}`);
    } catch (e) {
      console.log(`  ${f}  (skip: ${e.message})`);
    }
  }

  // write .mcp.json for this instance
  const mcp = {
    mcpServers: {
      "vector-memory": {
        command: "node",
        args: [path.join(ROOT, "mcp-server/dist/index.js")],
        env: {
          SUPABASE_URL: ENV.SUPABASE_URL,
          SUPABASE_KEY: ENV.SUPABASE_KEY,
          OLLAMA_URL:   ENV.OLLAMA_URL,
          EMBEDDING_MODEL: ENV.EMBEDDING_MODEL,
          EMBEDDING_DIMENSIONS: ENV.EMBEDDING_DIMENSIONS,
          // instance-specific:
          OPENCLAW_AGENT_LABEL:    LABEL,
          OPENCLAW_GENOME_LABEL:   LABEL,
          OPENCLAW_WORKSPACE_PATH: WORKSPACE,
          OPENCLAW_GATEWAY_PORT:    String(PORTS.gateway),
          OPENCLAW_BELIEF_PORT:     String(PORTS.belief),
          OPENCLAW_MOTIVATION_PORT: String(PORTS.motivation),
          OPENCLAW_DASHBOARD_PORT:  String(PORTS.dashboard),
          OPENCLAW_COCKPIT_PORT:    String(PORTS.cockpit),
        },
      },
    },
  };
  await fs.writeFile(plan.mcp_config_path, JSON.stringify(mcp, null, 2));
  console.log(`  .mcp.json  →  ${plan.mcp_config_path}`);

  // insert genome row
  const row = {
    label: LABEL,
    generation: 1,
    parent_ids: [],
    values: parent.values,
    interests: parent.interests,
    curiosity_baseline: parent.curiosity_baseline,
    frustration_threshold: parent.frustration_threshold,
    exploration_rate: parent.exploration_rate,
    risk_tolerance: parent.risk_tolerance,
    base_model: args["base-model"] || parent.base_model,
    teacher_model: args["teacher-model"] || parent.teacher_model,
    workspace_path: WORKSPACE,
    inheritance_mode: "none",
    notes: plan.genome.notes,
  };
  if (existing.length) {
    // update in place
    const r = await fetch(`${REST}/agent_genomes?label=eq.${LABEL}`, {
      method: "PATCH", headers: { ...HDRS, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`genome PATCH → ${r.status}: ${await r.text()}`);
    console.log(`  genome '${LABEL}' updated`);
  } else {
    const r = await fetch(`${REST}/agent_genomes`, {
      method: "POST", headers: { ...HDRS, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`genome POST → ${r.status}: ${await r.text()}`);
    console.log(`  genome '${LABEL}' created`);
  }

  // write motivation LaunchAgent (port-offset)
  const motivationPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.motivation.${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HOME}/.openclaw/motivation/.venv/bin/python3</string>
    <string>${HOME}/.openclaw/motivation/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>${HOME}/.openclaw/motivation</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${HOME}/.openclaw/motivation/.venv/bin:/usr/bin:/bin:/usr/local/bin</string>
    <key>MOTIVATION_PORT</key><string>${PORTS.motivation}</string>
    <key>MOTIVATION_INTERVAL_MINUTES</key><string>60</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${HOME}/.openclaw/motivation/logs/stdout.${LABEL}.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.openclaw/motivation/logs/stderr.${LABEL}.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  await fs.writeFile(plan.launch_agents[0].path, motivationPlist);
  console.log(`  LaunchAgent  →  ${plan.launch_agents[0].path}`);

  // sleep LaunchAgent (staggered schedule)
  const sleepPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openclaw.sleep.${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>${path.join(ROOT, "scripts/nightly-sleep.mjs")}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>SLEEP_AGENT_LABEL</key><string>${LABEL}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>${OFFSET % 59}</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${HOME}/.openclaw/sleep/logs/stdout.${LABEL}.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.openclaw/sleep/logs/stderr.${LABEL}.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  await fs.writeFile(plan.launch_agents[1].path, sleepPlist);
  console.log(`  LaunchAgent  →  ${plan.launch_agents[1].path}`);

  console.log(`
=== done ===
Next steps (manual, because OpenClaw is authority):
  1. Edit ${WORKSPACE}/SOUL.md to make this instance its own self.
  2. Point OpenClaw at ${WORKSPACE} (via OpenClaw's own config).
  3. Load the new LaunchAgents:
       launchctl bootstrap gui/$(id -u) ${HOME}/Library/LaunchAgents/ai.openclaw.motivation.${LABEL}.plist
       launchctl bootstrap gui/$(id -u) ${HOME}/Library/LaunchAgents/ai.openclaw.sleep.${LABEL}.plist
  4. First time the MCP server starts for this instance, it will register
     itself in the 'agents' table automatically.
`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
