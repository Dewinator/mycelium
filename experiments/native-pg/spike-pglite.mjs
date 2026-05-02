#!/usr/bin/env node
// Spike 1b — pglite alternative path (issue #177).
//
// PGlite is a WASM Postgres distribution from electric-sql that ships pgvector
// as a built-in extension. If our migrations run on it, this path collapses
// the entire "no Docker" story from "subprocess + per-platform binaries +
// custom pgvector packaging" into "one npm dep, runs anywhere Node runs."
//
// What we measure here:
//   - cold-start time (WASM init + pgvector load)
//   - Postgres major version (compatibility check vs our migrations)
//   - whether `CREATE EXTENSION vector` works
//   - if --migrate is passed, walk supabase/migrations/*.sql and find the
//     first that fails (or report all-green)
//
// Result is a JSON report on stdout (same shape as spike.mjs).

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { tablefunc } from "@electric-sql/pglite/contrib/tablefunc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(__dirname, "tmp-pglite");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

const args = new Set(process.argv.slice(2));
const RUN_MIGRATIONS = args.has("--migrate");
const KEEP_DATA = args.has("--keep");

function fmtMs(ms) {
  return `${ms.toFixed(0)} ms`;
}

async function main() {
  const report = {
    spike: "issue-177-pglite",
    started_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    package: "@electric-sql/pglite",
    steps: {},
  };

  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });

  // -- step 1: cold init (WASM load + pgvector extension wiring) -----------
  const t0 = performance.now();
  let db;
  try {
    db = await PGlite.create({
      dataDir: DATA_DIR,
      extensions: {
        vector,
        pg_trgm,
        pgcrypto,
        uuid_ossp,
        btree_gin,
        btree_gist,
        citext,
        hstore,
        tablefunc,
      },
    });
    report.steps.init = { ok: true, ms: performance.now() - t0 };
  } catch (err) {
    report.steps.init = { ok: false, error: String(err) };
    return finalize(report);
  }

  // -- step 2: version check -----------------------------------------------
  try {
    const v = await db.query("SHOW server_version");
    report.steps.version = v.rows[0].server_version;
  } catch (err) {
    report.steps.version_error = String(err);
  }

  // -- step 3: pgvector probe ----------------------------------------------
  try {
    const avail = await db.query(
      "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','pg_trgm','plpgsql','uuid-ossp') ORDER BY name"
    );
    report.steps.relevant_extensions = avail.rows;
  } catch (err) {
    report.steps.relevant_extensions = { error: String(err) };
  }

  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
    const v = await db.query(
      "SELECT extversion FROM pg_extension WHERE extname='vector'"
    );
    report.steps.create_extension_vector = {
      ok: true,
      installed_version: v.rows[0]?.extversion,
    };
  } catch (err) {
    report.steps.create_extension_vector = {
      ok: false,
      error: String(err.message ?? err).slice(0, 400),
    };
  }

  // -- step 4: optional migration walk -------------------------------------
  if (RUN_MIGRATIONS) {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const walked = [];
    let firstFailure = null;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const t = performance.now();
      try {
        await db.exec(sql);
        walked.push({ file, ok: true, ms: Math.round(performance.now() - t) });
      } catch (err) {
        const msg = String(err.message ?? err).slice(0, 300);
        walked.push({ file, ok: false, error: msg });
        firstFailure = { file, error: msg };
        break;
      }
    }
    report.steps.migrations = {
      total_files: files.length,
      attempted: walked.length,
      walked,
      first_failure: firstFailure,
      all_green: firstFailure === null,
    };
  }

  await db.close();
  if (!KEEP_DATA) {
    await rm(DATA_DIR, { recursive: true, force: true });
  }

  return finalize(report);
}

function finalize(report) {
  report.finished_at = new Date().toISOString();
  const verdict = [];
  if (report.steps.init?.ok) verdict.push(`init ${fmtMs(report.steps.init.ms)}`);
  if (report.steps.version) verdict.push(`pg ${report.steps.version}`);
  if (report.steps.create_extension_vector?.ok) {
    verdict.push(`vector ${report.steps.create_extension_vector.installed_version}`);
  } else if (report.steps.create_extension_vector) {
    verdict.push("vector FAILED");
  }
  if (report.steps.migrations) {
    const m = report.steps.migrations;
    verdict.push(
      m.all_green
        ? `migrations all green (${m.total_files})`
        : `migrations ${m.attempted - 1}/${m.total_files} OK then ${m.first_failure?.file}`
    );
  }
  console.error(`[spike-1b] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("[spike-1b] uncaught:", err);
  process.exit(1);
});
