/**
 * Contract test for the wiring of GET /swarm/lessons/{id}/proof into
 * scripts/dashboard-server.mjs (Swarm sub-phase 4e, issue #105).
 *
 * The handler module `swarm/endpoints/lesson-proof.ts` shipped in PR #128
 * with full unit + integration coverage of its own logic. What the
 * integration test in `lesson-proof-endpoint.test.ts` does NOT prove is
 * that any HTTP host actually mounts the handler — and indeed for several
 * weeks no host did. This file pins the wiring at the source-text level so
 * a future refactor of dashboard-server.mjs cannot silently regress it
 * without flipping a test red.
 *
 * Same shape-pin discipline as the migration contract tests (070..082):
 * scripts/dashboard-server.mjs is not part of the tsc test loop, so we
 * read it as text and assert structural facts rather than booting it.
 * Comments are stripped before keyword matches so an explanatory comment
 * cannot satisfy a structural assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, repo root is three levels up.
const DASHBOARD_PATH = resolve(
  __dirname,
  "../../..",
  "scripts/dashboard-server.mjs",
);
const RAW = readFileSync(DASHBOARD_PATH, "utf8");
const NO_COMMENTS = RAW.replace(/\/\/[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

// ---------------------------------------------------------------------------
// (1) The handler module is imported.
// ---------------------------------------------------------------------------

test("dashboard-server imports buildLessonProofResponse from the compiled handler", () => {
  // Match the dynamic import — the dashboard uses await import() because
  // the FED dist path is computed at runtime from ROOT.
  const importRe =
    /buildLessonProofResponse[^}]*\}\s*=\s*await\s+import\([^)]*lesson-proof\.js[^)]*\)/;
  assert.match(
    NO_COMMENTS,
    importRe,
    "dashboard-server.mjs must import buildLessonProofResponse from " +
      "mcp-server/dist/swarm/endpoints/lesson-proof.js",
  );
});

// ---------------------------------------------------------------------------
// (2) The route regex pins the SWARM_SPEC §4.6 path shape.
// Anchored UUID match keeps a stray /swarm/lessons/foo/proof from reaching
// the handler with a malformed id (the handler would 400 anyway, but
// the regex turns the rejection into a clean 404 falling through to the
// static handler instead — same discipline as PROOF_PATH_RE in the test).
// ---------------------------------------------------------------------------

test("dashboard-server defines a UUID-anchored proof path regex", () => {
  // Whitespace-tolerant — the source uses multi-line formatting.
  const compact = NO_COMMENTS.replace(/\s+/g, "");
  assert.match(
    compact,
    /constPROOF_PATH_RE\s*=\s*\/\^\\\/swarm\\\/lessons\\\/\(/,
    "PROOF_PATH_RE must anchor on /swarm/lessons/ and capture a UUID",
  );
  assert.ok(
    /\\\/proof\$/.test(compact),
    "PROOF_PATH_RE must terminate at /proof",
  );
});

// ---------------------------------------------------------------------------
// (3) The router registers the proof route BEFORE the static fall-through
// so /swarm/lessons/{id}/proof never gets served as a file path.
// ---------------------------------------------------------------------------

test("dashboard-server registers handleLessonProof before the static handler", () => {
  // Find the request dispatcher — it's inside http.createServer((req,res)=>{...}).
  const proofMatchIdx = NO_COMMENTS.indexOf("PROOF_PATH_RE");
  assert.ok(
    proofMatchIdx > 0,
    "PROOF_PATH_RE must be referenced in the dispatcher",
  );
  // The route must invoke handleLessonProof.
  assert.match(
    NO_COMMENTS,
    /handleLessonProof\s*\(/,
    "Dispatcher must call handleLessonProof when PROOF_PATH_RE matches",
  );
  // And the dispatch must precede the /api/ proxy fall-through, which is
  // the first generic prefix match in the router.
  const dispatcherStart = NO_COMMENTS.indexOf(
    "http.createServer((req, res)",
  );
  assert.ok(dispatcherStart > 0, "createServer dispatcher must exist");
  const proofRouteIdx = NO_COMMENTS.indexOf(
    "PROOF_PATH_RE",
    dispatcherStart,
  );
  const apiPrefixIdx = NO_COMMENTS.indexOf('"/api/"', dispatcherStart);
  assert.ok(
    proofRouteIdx > 0 && apiPrefixIdx > 0 && proofRouteIdx < apiPrefixIdx,
    "Proof route registration must come before the /api/ proxy " +
      "fall-through so a malformed UUID doesn't get treated as an API " +
      "path",
  );
});

// ---------------------------------------------------------------------------
// (4) Loaders are wired against the substrate tables, NOT the broken
// get_lesson_evidence RPC. Issue #135 / PR #140 fixes the RPC; until that
// migration lands, the dashboard-server MUST read the table directly to
// avoid a hard dependency on a function that doesn't exist on PG16.
// ---------------------------------------------------------------------------

test("loadLeaves reads lesson_evidence_origin directly (not the broken RPC)", () => {
  assert.match(
    NO_COMMENTS,
    /lesson_evidence_origin\?select=hashed_experience_id/,
    "loadLeaves must SELECT from lesson_evidence_origin to bypass the " +
      "PG16-broken get_lesson_evidence function (issue #135)",
  );
  assert.ok(
    !/\/rpc\/get_lesson_evidence/.test(NO_COMMENTS),
    "dashboard-server must NOT call /rpc/get_lesson_evidence — that " +
      "function fails to be created on PG16 until migration 084 lands",
  );
});

test("loadLesson and wasPublishedByThisNode read the expected substrate tables", () => {
  assert.match(
    NO_COMMENTS,
    /swarm_lessons\?select=origin_node_id,signed_at,spec_version/,
    "loadLesson must SELECT origin_node_id,signed_at,spec_version " +
      "from swarm_lessons",
  );
  assert.match(
    NO_COMMENTS,
    /lesson_chain\?select=lesson_id/,
    "wasPublishedByThisNode must check lesson_chain for the lesson_id " +
      "to disambiguate 404 vs 410 per SWARM_SPEC §4.6",
  );
});
