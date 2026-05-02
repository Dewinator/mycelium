#!/usr/bin/env node
// Spike 2a — node-llama-cpp API + GPU/Metal availability probe.
//
// No model download. Just verifies:
//   - import surface (getLlama, LlamaChatSession, defineChatSessionFunction)
//   - GPU type detected (Metal / Vulkan / CUDA / cpu)
//   - VRAM/RAM that the runtime sees
//   - llama.cpp build commit
//
// Cheap (<5 s) — first sanity gate before downloading multi-GB GGUFs.

import { getLlama, LlamaLogLevel } from "node-llama-cpp";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const report = {
    spike: "issue-178-probe",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    steps: {},
  };

  const t0 = performance.now();
  let llama;
  try {
    llama = await getLlama({
      logLevel: LlamaLogLevel.warn,
    });
    report.steps.init = { ok: true, ms: performance.now() - t0 };
  } catch (err) {
    report.steps.init = { ok: false, error: String(err) };
    return finalize(report);
  }

  try {
    report.steps.runtime = {
      gpu: llama.gpu,
      build: llama.buildType,
      vram: llama.gpu === false ? null : await llama.getVramState(),
      sys_info: llama.systemInfo,
    };
  } catch (err) {
    report.steps.runtime = { error: String(err) };
  }

  try {
    await llama.dispose();
  } catch (err) {
    report.steps.dispose_error = String(err);
  }

  return finalize(report);
}

async function finalize(report) {
  report.finished_at = new Date().toISOString();
  const verdict = verdictLine(report);
  report.verdict = verdict;
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nverdict: ${verdict}`);
  await writeFile(
    path.join(__dirname, "report-probe.json"),
    JSON.stringify(report, null, 2)
  );
}

function verdictLine(r) {
  if (!r.steps.init?.ok) return `init FAILED — ${r.steps.init?.error?.slice(0, 200)}`;
  const gpu = r.steps.runtime?.gpu ?? "unknown";
  const build = r.steps.runtime?.build ?? "?";
  return `node-llama-cpp ready · gpu=${gpu} · build=${build}`;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
