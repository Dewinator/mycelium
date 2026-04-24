#!/usr/bin/env node
/**
 * bootstrap.mjs — seed the mycelium issue queue from scratch.
 *
 * Runs when the repo has no open `agent-eligible` issues and the autonomous
 * loop needs new direction. Does three things, in order:
 *
 *   1. Asks codex (via openclaw main agent) for a high-level project-direction
 *      plan, constrained by CONSTITUTION.md.
 *   2. For each item in the returned plan, spawns a fresh Claude Code session
 *      and asks it to turn that item into 1-3 concrete GitHub issues with
 *      label `agent-eligible`. The session uses `gh issue create` directly.
 *   3. Writes a bootstrap report under ~/.openclaw/bootstrap-runs/.
 *
 * Hard rules (inherited from agent-tick.mjs):
 *   - `--agent main --session-id <unique>` per call → no persistent context.
 *   - Constitution-check BEFORE calling out: if CONSTITUTION.md is missing or
 *     weakened, refuse to bootstrap.
 *   - Pause switch `~/.openclaw/agent-pause` skips everything.
 *   - Timeouts enforced by caller — no silent long hangs.
 */
import fs   from "node:fs/promises";
import path from "node:path";
import os   from "node:os";
import { spawn } from "node:child_process";

import {
  assertConstitutionIntact,
  loadConstitution,
  PILLARS,
} from "./lib/constitution-check.mjs";

const HOME       = os.homedir();
const PAUSE_FILE = path.join(HOME, ".openclaw", "agent-pause");
const RUNS_DIR   = path.join(HOME, ".openclaw", "bootstrap-runs");
const REPO       = process.env.AGENT_REPO ?? "Dewinator/mycelium";
const REPO_PATH  = process.env.AGENT_REPO_PATH ?? path.join(HOME, "vectormemory-openclaw");
const AGENT_ID   = process.env.AGENT_ID ?? "main";
const AGENT_TIMEOUT = process.env.AGENT_TIMEOUT ?? "180";
const RUN_ID     = `bootstrap-${new Date().toISOString().replace(/[:.]/g, "-")}`;

async function checkPause() {
  try { await fs.access(PAUSE_FILE); return true; } catch { return false; }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

function extractJsonBlock(text) {
  if (!text) throw new Error("empty reply");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace  = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

const DIRECTION_PROMPT = (constitutionText) => `You are the mycelium project planner. Read the following Constitution and respect it as non-negotiable:

---
${constitutionText}
---

You have access to the mycelium repo (${REPO}, local path ${REPO_PATH}) and the vector-memory MCP.

Use prime_context and project_brief (scoped to project="mycelium") to recall where the project stands. Look at recent commits and the current open-issue list.

Produce a high-level project-direction plan with 5-8 items. Each item must move the project forward toward the Constitution pillars — never away from them. Items must be concrete enough that a downstream Claude Code session can decompose each one into 1-3 actionable GitHub issues.

Return STRICT JSON (no prose, no markdown fences outside the JSON):

{
  "constitution_compliant": true,
  "rationale": "<why this plan is good for mycelium right now>",
  "items": [
    { "id": "D01", "title": "<short>", "pillars": ["Swarm intelligence"], "goal": "<one paragraph>" }
  ]
}

If any item would weaken a pillar, DO NOT include it. If you cannot find 5 safe items, return fewer — quality over quantity.`;

async function getDirectionPlan(constitutionText) {
  const prompt = DIRECTION_PROMPT(constitutionText);
  const r = await runCmd("openclaw", [
    "agent",
    "--agent",      AGENT_ID,
    "--session-id", `${RUN_ID}-direction`,
    "--message",    prompt,
    "--json",
    "--timeout",    AGENT_TIMEOUT,
  ]);
  if (r.code !== 0) throw new Error(`openclaw exit ${r.code}: ${r.stderr.slice(0, 400)}`);
  let envelope;
  try { envelope = JSON.parse(r.stdout); }
  catch { throw new Error(`openclaw stdout not JSON: ${r.stdout.slice(0, 300)}`); }
  const replyText =
    envelope?.result?.payloads?.[0]?.text ??
    envelope?.reply ?? envelope?.message ?? envelope?.text ??
    JSON.stringify(envelope);
  return extractJsonBlock(typeof replyText === "string" ? replyText : JSON.stringify(replyText));
}

const DECOMPOSE_PROMPT = (item, constitutionText) => `You are a Claude Code session invoked by the mycelium bootstrap.

Repo: ${REPO} (cwd: ${REPO_PATH})
You have: gh CLI, full repo read, and must stay within CONSTITUTION.md.

Your one job: turn this direction item into 1-3 concrete GitHub issues.

Direction item:
  id:     ${item.id}
  title:  ${item.title}
  pillars: ${(item.pillars ?? []).join(", ")}
  goal:   ${item.goal}

For each issue you create, you MUST:
  - Add label "agent-eligible" (create it if missing).
  - Reference the direction id "${item.id}" in the body.
  - Include an "Affected pillars" section listing the pillars from above.
  - Include a "Constitution affirmation" sentence: which pillars this issue serves, and that it does not weaken any.

Do NOT open PRs or write code. Only create issues. Use:
  gh issue create --title "<title>" --label "agent-eligible" --body "<body>"

After creating all issues, print a single line to stdout:
  BOOTSTRAP_ITEM_DONE ${item.id} issues=<comma-separated-issue-numbers>

If a pillar would be weakened, create NO issues for this item and print:
  BOOTSTRAP_ITEM_SKIPPED ${item.id} reason=<short reason>

The Constitution (non-negotiable):
---
${constitutionText}
---`;

async function decomposeItem(item, constitutionText) {
  const prompt = DECOMPOSE_PROMPT(item, constitutionText);
  const r = await runCmd("claude", [
    "--dangerously-skip-permissions",
    "-p", prompt,
  ], { cwd: REPO_PATH });
  const ok = r.code === 0;
  const marker =
    r.stdout.match(/BOOTSTRAP_ITEM_DONE\s+\S+\s+issues=([\d,]+)/) ||
    r.stdout.match(/BOOTSTRAP_ITEM_SKIPPED\s+\S+\s+reason=(.+)/);
  return {
    ok,
    code: r.code,
    issues: marker && marker[0].startsWith("BOOTSTRAP_ITEM_DONE") ? marker[1].split(",") : [],
    skipped: marker && marker[0].startsWith("BOOTSTRAP_ITEM_SKIPPED") ? marker[1] : null,
    tail: r.stdout.slice(-500),
  };
}

async function main() {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const runRecord = { runId: RUN_ID, startedAt: new Date().toISOString(), steps: [] };

  try {
    if (await checkPause()) {
      runRecord.skipped = "pause-switch active";
      await fs.writeFile(path.join(RUNS_DIR, `${RUN_ID}.json`), JSON.stringify(runRecord, null, 2));
      console.log(`[${RUN_ID}] paused.`);
      return;
    }

    await assertConstitutionIntact();
    const constitutionText = await loadConstitution();
    runRecord.steps.push({ step: "constitution_check", ok: true, pillars: [...PILLARS] });

    console.log(`[${RUN_ID}] asking codex for direction plan...`);
    const plan = await getDirectionPlan(constitutionText);
    runRecord.steps.push({ step: "direction_plan", items: plan.items?.length, rationale: plan.rationale });
    if (!plan.constitution_compliant) throw new Error("planner returned constitution_compliant=false; aborting bootstrap");
    if (!Array.isArray(plan.items) || plan.items.length === 0) throw new Error("planner returned no items");

    console.log(`[${RUN_ID}] planner returned ${plan.items.length} direction items; decomposing each via Claude Code...`);
    for (const item of plan.items) {
      console.log(`[${RUN_ID}] → ${item.id}: ${item.title}`);
      const res = await decomposeItem(item, constitutionText);
      runRecord.steps.push({ step: "decompose", itemId: item.id, ok: res.ok, issues: res.issues, skipped: res.skipped });
      console.log(`[${RUN_ID}]   ↳ ${res.skipped ? `skipped (${res.skipped})` : `issues=${res.issues.join(",") || "—"}`}`);
    }

    runRecord.endedAt = new Date().toISOString();
    await fs.writeFile(path.join(RUNS_DIR, `${RUN_ID}.json`), JSON.stringify(runRecord, null, 2));
    console.log(`[${RUN_ID}] bootstrap done.`);
  } catch (e) {
    runRecord.error = String(e?.message ?? e);
    runRecord.endedAt = new Date().toISOString();
    await fs.writeFile(path.join(RUNS_DIR, `${RUN_ID}.json`), JSON.stringify(runRecord, null, 2));
    console.error(`[${RUN_ID}] ERROR: ${runRecord.error}`);
    process.exit(1);
  }
}

main();
