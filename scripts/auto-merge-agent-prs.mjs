#!/usr/bin/env node
/**
 * auto-merge-agent-prs.mjs — merge PRs opened by the autonomy loop.
 *
 * Scans open PRs with label `agent-opened`. For each one, checks:
 *   1. Constitution.md diff does not remove or weaken pillar text
 *   2. PR body affirms the Constitution (mentions it by name + at least one pillar)
 *   3. CI (if configured) is green — if no checks are configured, treats it as pass
 *
 * If all checks pass: `gh pr merge <N> --squash --delete-branch`.
 * If any check fails: comments on the PR with the reason and leaves it open.
 *
 * Designed to be idempotent + safe to re-run (the cron will invoke it on a
 * schedule). Never merges anything not labeled `agent-opened` — human-opened
 * PRs always go through human review.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  loadConstitution,
  diffTouchesConstitution,
  textAffirmsConstitution,
} from "./lib/constitution-check.mjs";

const REPO = process.env.AGENT_REPO ?? "Dewinator/mycelium";
const REPO_PATH = process.env.AGENT_REPO_PATH ?? path.join(os.homedir(), "vectormemory-openclaw");
const OPENED_LABEL = "agent-opened";

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? REPO_PATH, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
  });
}

async function listAgentPRs() {
  const r = await runCmd("gh", [
    "pr", "list",
    "--repo", REPO,
    "--state", "open",
    "--label", OPENED_LABEL,
    "--json", "number,title,body,headRefName,labels,url,mergeable,mergeStateStatus",
    "--limit", "50",
  ]);
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout || "[]");
}

async function fetchPRDiff(number) {
  const r = await runCmd("gh", ["pr", "diff", String(number), "--repo", REPO]);
  return r.code === 0 ? r.stdout : "";
}

async function fetchPRChecks(number) {
  const r = await runCmd("gh", ["pr", "checks", String(number), "--repo", REPO, "--json", "name,state,conclusion"]);
  if (r.code !== 0) return { configured: false, failing: [] };
  try {
    const checks = JSON.parse(r.stdout || "[]");
    if (checks.length === 0) return { configured: false, failing: [] };
    const failing = checks.filter((c) => c.state !== "COMPLETED" || (c.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)));
    return { configured: true, failing };
  } catch {
    return { configured: false, failing: [] };
  }
}

async function commentOnPR(number, message) {
  return runCmd("gh", ["pr", "comment", String(number), "--repo", REPO, "--body", message]);
}

async function mergePR(number) {
  return runCmd("gh", ["pr", "merge", String(number), "--repo", REPO, "--squash", "--delete-branch"]);
}

async function evaluatePR(pr, constitutionText) {
  const reasons = [];
  const diff = await fetchPRDiff(pr.number);
  const cd = diffTouchesConstitution(diff);
  if (cd.violations.length > 0) {
    reasons.push(`Constitution text weakened — violations: ${cd.violations.join("; ")}`);
  }
  if (!textAffirmsConstitution(pr.body ?? "")) {
    reasons.push(`PR body is missing a Constitution affirmation (must name the Constitution and at least one pillar).`);
  }
  const checks = await fetchPRChecks(pr.number);
  if (checks.configured && checks.failing.length > 0) {
    reasons.push(`CI checks not passing: ${checks.failing.map((c) => c.name).join(", ")}`);
  }
  if (pr.mergeStateStatus && !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)) {
    reasons.push(`mergeStateStatus=${pr.mergeStateStatus}`);
  }
  return reasons;
}

async function main() {
  await loadConstitution();
  const prs = await listAgentPRs();
  console.log(`[auto-merge] found ${prs.length} agent-opened PR(s)`);
  const summary = { merged: [], blocked: [] };
  for (const pr of prs) {
    const reasons = await evaluatePR(pr, null);
    if (reasons.length === 0) {
      const m = await mergePR(pr.number);
      if (m.code === 0) {
        console.log(`[auto-merge] merged #${pr.number}: ${pr.title}`);
        summary.merged.push(pr.number);
      } else {
        console.log(`[auto-merge] merge command failed for #${pr.number}: ${m.stderr.slice(0, 200)}`);
        summary.blocked.push({ number: pr.number, reasons: [`gh merge command failed: ${m.stderr.slice(0, 200)}`] });
      }
    } else {
      const body = `The autonomy-loop auto-merger will not merge this PR for the following reason(s):\n\n${reasons.map((r) => `- ${r}`).join("\n")}\n\nResolve the blockers (or remove the \`${OPENED_LABEL}\` label for human review) to proceed.`;
      await commentOnPR(pr.number, body);
      console.log(`[auto-merge] blocked #${pr.number}: ${reasons.join("; ")}`);
      summary.blocked.push({ number: pr.number, reasons });
    }
  }
  console.log(`[auto-merge] summary: ${JSON.stringify(summary)}`);
}

main().catch((e) => {
  console.error(`[auto-merge] fatal: ${e?.message ?? e}`);
  process.exit(1);
});
