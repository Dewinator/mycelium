#!/usr/bin/env node
/**
 * agent-tick.mjs — autonomous loop tick for the mycelium meta-agent (v2).
 *
 * Architecture v2 (2026-04-24):
 *
 *   - No per-tick planner. The plan lives as a queue of `agent-eligible`
 *     GitHub issues, seeded once by `bootstrap.mjs` and re-seeded when the
 *     queue is empty.
 *   - Each tick:
 *       1. Constitution check (CONSTITUTION.md intact)
 *       2. Pause-switch check
 *       3. List open issues with label `agent-eligible`
 *       4. If empty → spawn `bootstrap.mjs` and exit (re-seeding)
 *       5. Pick the oldest issue; label it `agent-working` so parallel ticks
 *          don't double-up
 *       6. Spawn a FRESH `claude --dangerously-skip-permissions -p "..."`
 *          session in the repo, tell it to implement the issue on a branch
 *          `agent/issue-<n>-<ts>` and open a PR with label `agent-opened`
 *          that affirms Constitution compliance
 *       7. Drop the `agent-working` label on the issue (success or failure)
 *       8. Write a tick log
 *
 * Hard rules (inherited + refined):
 *   - Fresh session per call (no `--session-id` carryover, no persistent main)
 *   - Constitution check fails closed — no tick runs against a weakened text
 *   - Pause-switch `~/.openclaw/agent-pause` short-circuits everything
 *   - No SQL migrations / dep removals / CI edits autonomously — the Claude
 *     session prompt enforces this and instructs it to open an issue instead
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
const TICKS_DIR  = path.join(HOME, ".openclaw", "agent-ticks");
const REPO       = process.env.AGENT_REPO ?? "Dewinator/mycelium";
const REPO_PATH  = process.env.AGENT_REPO_PATH ?? path.join(HOME, "vectormemory-openclaw");
const DRY_RUN    = !process.argv.includes("--live");
const TICK_ID    = `tick-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const WORKING_LABEL  = "agent-working";
const ELIGIBLE_LABEL = "agent-eligible";
const OPENED_LABEL   = "agent-opened";

async function ensureDir(d) { try { await fs.mkdir(d, { recursive: true }); } catch {} }

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_PATH,
      env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
  });
}

async function logTick(record) {
  await ensureDir(TICKS_DIR);
  const file = path.join(TICKS_DIR, `${TICK_ID}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}

async function checkPause() {
  try { await fs.access(PAUSE_FILE); return true; } catch { return false; }
}

async function listEligibleIssues() {
  const r = await runCmd("gh", [
    "issue", "list",
    "--repo", REPO,
    "--state", "open",
    "--label", ELIGIBLE_LABEL,
    "--json", "number,title,labels,createdAt,body,url",
    "--limit", "50",
  ]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr.slice(0, 300)}`);
  const all = JSON.parse(r.stdout || "[]");
  // Skip anything already being worked on by another tick.
  return all.filter((i) => !(i.labels ?? []).some((l) => l.name === WORKING_LABEL));
}

function pickIssue(issues) {
  if (issues.length === 0) return null;
  return [...issues].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
}

async function labelIssue(number, label) {
  return runCmd("gh", ["issue", "edit", String(number), "--repo", REPO, "--add-label", label]);
}

async function unlabelIssue(number, label) {
  return runCmd("gh", ["issue", "edit", String(number), "--repo", REPO, "--remove-label", label]);
}

async function spawnBootstrap() {
  const scriptPath = path.join(REPO_PATH, "scripts", "bootstrap.mjs");
  return runCmd("node", [scriptPath], { cwd: REPO_PATH });
}

const SESSION_PROMPT = (issue, constitutionText) => `You are a fresh Claude Code session spawned by the mycelium autonomy loop.

Repo: ${REPO}   (cwd: ${REPO_PATH})

Your job: implement GitHub issue #${issue.number} ("${issue.title}") end-to-end, open a pull request, and stop.

## Non-negotiable Constitution (the six pillars)

${constitutionText}

## Hard process rules

- Work on a new branch: agent/issue-${issue.number}-${TICK_ID.replace(/^tick-/, "")}
- Do NOT push to main. Ever.
- Do NOT run SQL migrations, remove dependencies, or touch CI/CD files autonomously. If the issue requires this, open a follow-up issue and stop.
- Do NOT modify CONSTITUTION.md.
- Use vector-memory MCP excessively: prime_context and project_brief("mycelium") at the start; record_experience at the end.
- Commit in small logical steps. Commit messages on English, conventional prefix (feat/fix/docs/refactor/test/chore).
- Open the PR with: gh pr create --label "${OPENED_LABEL}" --title "..." --body "..."
- The PR body MUST include a "Constitution affirmation" section that lists which pillars this change touches and explicitly affirms none are weakened.

## Issue

Number: #${issue.number}
Title:  ${issue.title}
URL:    ${issue.url}

Body:
${issue.body ?? "(no body)"}

## When you are done

Print exactly one of:
  TICK_RESULT ok pr=<pr-number>
  TICK_RESULT skipped reason=<short>
  TICK_RESULT failed reason=<short>

Then exit.`;

async function spawnClaudeSession(issue, constitutionText) {
  const prompt = SESSION_PROMPT(issue, constitutionText);
  const r = await runCmd("claude", ["--dangerously-skip-permissions", "-p", prompt], { cwd: REPO_PATH });
  const ok = r.stdout.match(/TICK_RESULT\s+ok\s+pr=(\d+)/);
  const skipped = r.stdout.match(/TICK_RESULT\s+skipped\s+reason=(.+)/);
  const failed = r.stdout.match(/TICK_RESULT\s+failed\s+reason=(.+)/);
  return {
    exitCode: r.code,
    pr: ok ? Number(ok[1]) : null,
    skipped: skipped ? skipped[1].trim() : null,
    failed: failed ? failed[1].trim() : null,
    tail: r.stdout.slice(-800),
  };
}

async function main() {
  const tickRecord = {
    tickId: TICK_ID,
    startedAt: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : "live",
    steps: [],
  };

  let workingIssueNumber = null;
  try {
    if (await checkPause()) {
      tickRecord.skipped = "pause-switch active";
      await logTick(tickRecord);
      console.log(`[${TICK_ID}] paused — ${PAUSE_FILE} exists, skipping.`);
      return;
    }

    await assertConstitutionIntact();
    const constitutionText = await loadConstitution();
    tickRecord.steps.push({ step: "constitution_check", ok: true });

    const issues = await listEligibleIssues();
    tickRecord.steps.push({ step: "list_issues", count: issues.length });

    if (issues.length === 0) {
      tickRecord.steps.push({ step: "queue_empty_trigger_bootstrap", at: new Date().toISOString() });
      console.log(`[${TICK_ID}] queue empty; triggering bootstrap.mjs.`);
      if (DRY_RUN) {
        tickRecord.note = "DRY-RUN — would have spawned bootstrap.mjs";
      } else {
        const b = await spawnBootstrap();
        tickRecord.steps.push({ step: "bootstrap", exitCode: b.code, tail: b.stdout.slice(-400) });
      }
      tickRecord.endedAt = new Date().toISOString();
      await logTick(tickRecord);
      return;
    }

    const issue = pickIssue(issues);
    tickRecord.steps.push({ step: "pick_issue", number: issue.number, title: issue.title });
    console.log(`[${TICK_ID}] picked #${issue.number}: ${issue.title}`);

    if (DRY_RUN) {
      tickRecord.note = `DRY-RUN — would have spawned Claude for issue #${issue.number}`;
      tickRecord.endedAt = new Date().toISOString();
      await logTick(tickRecord);
      console.log(`[${TICK_ID}] dry-run complete.`);
      return;
    }

    workingIssueNumber = issue.number;
    await labelIssue(issue.number, WORKING_LABEL);
    tickRecord.steps.push({ step: "label_working", number: issue.number });

    const session = await spawnClaudeSession(issue, constitutionText);
    tickRecord.steps.push({ step: "claude_session", ...session });
    console.log(`[${TICK_ID}] claude session done: ${JSON.stringify({ pr: session.pr, skipped: session.skipped, failed: session.failed })}`);

    tickRecord.endedAt = new Date().toISOString();
    await logTick(tickRecord);
    console.log(`[${TICK_ID}] done.`);
  } catch (e) {
    tickRecord.error = String(e?.message ?? e);
    tickRecord.endedAt = new Date().toISOString();
    await logTick(tickRecord);
    console.error(`[${TICK_ID}] ERROR: ${tickRecord.error}`);
    process.exitCode = 1;
  } finally {
    if (workingIssueNumber !== null) {
      try { await unlabelIssue(workingIssueNumber, WORKING_LABEL); } catch {}
    }
  }
}

main();
