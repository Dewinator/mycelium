#!/usr/bin/env node
// Spike 1 (issue #177) — validate the embedded-postgres approach end-to-end.
//
// What this script does:
//   1. boots a Postgres 18 cluster in ./tmp-data via the leinelissen/embedded-postgres wrapper
//   2. measures cold-start time + on-disk footprint
//   3. probes whether `CREATE EXTENSION vector` works out of the box (the
//      central feasibility question for Path A — pgvector is a HARD dependency
//      of every migration past 001)
//   4. if --migrate is passed, walks supabase/migrations/*.sql and reports
//      where the first failure happens
//
// Output is a single JSON report so a follow-up tick / human reviewer can
// diff results across runs.

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(__dirname, "tmp-data");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const PORT = Number(process.env.SPIKE_PG_PORT ?? 54399);

const args = new Set(process.argv.slice(2));
const RUN_MIGRATIONS = args.has("--migrate");
const KEEP_DATA = args.has("--keep");

async function dirSizeBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      const s = await stat(full).catch(() => null);
      if (s) total += s.size;
    }
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMs(ms) {
  return `${ms.toFixed(0)} ms`;
}

async function main() {
  const report = {
    spike: "issue-177-embedded-pg",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    package: "embedded-postgres@18.3.0-beta.17",
    steps: {},
  };

  // Fresh data dir each run — we measure cold-start, not warm restart.
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "spike",
    port: PORT,
    persistent: false,
    onLog: () => {}, // suppress chatty initdb output
    onError: (err) => {
      // capture but don't throw — we want the spike to keep walking even on partial failures
      report.steps.pg_stderr = report.steps.pg_stderr ?? [];
      report.steps.pg_stderr.push(String(err).slice(0, 500));
    },
  });

  // -- step 1: initialise (initdb) -----------------------------------------
  const t0 = performance.now();
  try {
    await pg.initialise();
    report.steps.initdb = { ok: true, ms: performance.now() - t0 };
  } catch (err) {
    report.steps.initdb = { ok: false, error: String(err) };
    return finalize(report);
  }

  // -- step 2: start postmaster --------------------------------------------
  const t1 = performance.now();
  try {
    await pg.start();
    report.steps.start = { ok: true, ms: performance.now() - t1 };
  } catch (err) {
    report.steps.start = { ok: false, error: String(err) };
    return finalize(report);
  }

  // -- step 3: connect + version check -------------------------------------
  const client = pg.getPgClient();
  try {
    await client.connect();
    const v = await client.query("SHOW server_version");
    report.steps.version = v.rows[0].server_version;
  } catch (err) {
    report.steps.connect = { ok: false, error: String(err) };
    await pg.stop().catch(() => {});
    return finalize(report);
  }

  // -- step 4: pgvector probe — THE central question -----------------------
  // List what extensions the bundled Postgres knows about, then attempt the
  // one we actually need.
  try {
    const avail = await client.query(
      "SELECT name, default_version FROM pg_available_extensions ORDER BY name"
    );
    report.steps.available_extensions = avail.rows.map((r) => r.name);
    report.steps.has_vector_in_catalog = avail.rows.some((r) => r.name === "vector");
  } catch (err) {
    report.steps.available_extensions = { error: String(err) };
  }

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    report.steps.create_extension_vector = { ok: true };
  } catch (err) {
    report.steps.create_extension_vector = {
      ok: false,
      error: String(err.message ?? err).slice(0, 400),
    };
  }

  // -- step 5: optional migration walk -------------------------------------
  if (RUN_MIGRATIONS) {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const walked = [];
    let firstFailure = null;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const t = performance.now();
      try {
        await client.query(sql);
        walked.push({ file, ok: true, ms: Math.round(performance.now() - t) });
      } catch (err) {
        const msg = String(err.message ?? err).slice(0, 300);
        walked.push({ file, ok: false, error: msg });
        firstFailure = { file, error: msg };
        break; // walk halts at first failure — a spike, not a fixer
      }
    }
    report.steps.migrations = { count_attempted: walked.length, walked, first_failure: firstFailure };
  }

  // -- step 6: footprint ---------------------------------------------------
  report.steps.data_dir_bytes = await dirSizeBytes(DATA_DIR);
  report.steps.data_dir_human = fmtMB(report.steps.data_dir_bytes);

  await client.end().catch(() => {});
  await pg.stop().catch((err) => {
    report.steps.stop_error = String(err);
  });

  if (!KEEP_DATA) {
    await rm(DATA_DIR, { recursive: true, force: true });
  }

  return finalize(report);
}

function finalize(report) {
  report.finished_at = new Date().toISOString();
  // pretty top-line summary so a human reading the log can see the verdict instantly
  const verdict = [];
  if (report.steps.initdb?.ok) verdict.push(`initdb ${fmtMs(report.steps.initdb.ms)}`);
  if (report.steps.start?.ok) verdict.push(`start ${fmtMs(report.steps.start.ms)}`);
  if (report.steps.version) verdict.push(`pg ${report.steps.version}`);
  if (report.steps.create_extension_vector?.ok === true) verdict.push("vector OK");
  else if (report.steps.create_extension_vector) verdict.push("vector FAILED");
  if (report.steps.data_dir_human) verdict.push(`data ${report.steps.data_dir_human}`);
  console.error(`[spike-1] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("[spike-1] uncaught:", err);
  process.exit(1);
});
