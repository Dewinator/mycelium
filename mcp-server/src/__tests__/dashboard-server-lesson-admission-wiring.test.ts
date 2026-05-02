/**
 * Contract test for the wiring of POST /swarm/lessons into
 * scripts/dashboard-server.mjs (Swarm sub-phase 4j, issue #138 follow-up).
 *
 * The handler module `swarm/endpoints/lesson-admission.ts` shipped in PR #154
 * with 19 contract tests of its own. What `lesson-admission.test.ts` does NOT
 * prove is that any HTTP host actually mounts the handler — and indeed for
 * several days no host did. This file pins the wiring at the source-text
 * level so a future refactor of dashboard-server.mjs cannot silently regress
 * it without flipping a test red.
 *
 * Same shape-pin discipline as `dashboard-server-lesson-proof-wiring.test.ts`:
 * scripts/dashboard-server.mjs is not part of the tsc test loop, so we read
 * it as text and assert structural facts rather than booting it. Comments
 * are stripped before keyword matches so an explanatory comment cannot
 * satisfy a structural assertion.
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

test("dashboard-server imports admitSwarmLesson from the compiled handler", () => {
  // Match the dynamic import — same pattern as buildLessonProofResponse.
  const importRe =
    /admitSwarmLesson[^}]*\}\s*=\s*await\s+import\([^)]*lesson-admission\.js[^)]*\)/;
  assert.match(
    NO_COMMENTS,
    importRe,
    "dashboard-server.mjs must import admitSwarmLesson from " +
      "mcp-server/dist/swarm/endpoints/lesson-admission.js",
  );
});

// ---------------------------------------------------------------------------
// (2) The dispatcher routes POST /swarm/lessons (and only POST) to the
// admission handler. GET /swarm/lessons is the outbound feed (#139) — the
// method gate keeps the two endpoints from cross-routing.
// ---------------------------------------------------------------------------

test("dashboard-server routes POST /swarm/lessons to handleAdmitLesson", () => {
  const compact = NO_COMMENTS.replace(/\s+/g, "");
  assert.match(
    compact,
    /req\.method==="POST"&&req\.url==="\/swarm\/lessons"/,
    "Dispatcher must guard the route on POST + exact /swarm/lessons match " +
      "so GET /swarm/lessons (the #139 outbound feed) does not collide with " +
      "the admission handler",
  );
  assert.match(
    NO_COMMENTS,
    /handleAdmitLesson\s*\(/,
    "Dispatcher must call handleAdmitLesson when POST /swarm/lessons matches",
  );
});

// ---------------------------------------------------------------------------
// (3) The admission route registers BEFORE the static fall-through and
// before the /api/ proxy prefix, otherwise a stray POST would be misrouted.
// ---------------------------------------------------------------------------

test("dashboard-server registers POST /swarm/lessons before /api/ proxy", () => {
  const dispatcherStart = NO_COMMENTS.indexOf(
    "http.createServer((req, res)",
  );
  assert.ok(dispatcherStart > 0, "createServer dispatcher must exist");
  const admissionRouteIdx = NO_COMMENTS.indexOf(
    "/swarm/lessons",
    dispatcherStart,
  );
  const apiPrefixIdx = NO_COMMENTS.indexOf('"/api/"', dispatcherStart);
  assert.ok(
    admissionRouteIdx > 0 && apiPrefixIdx > 0 && admissionRouteIdx < apiPrefixIdx,
    "Admission route registration must come before the /api/ proxy " +
      "fall-through so a stray POST does not get rewritten as a PostgREST call",
  );
});

// ---------------------------------------------------------------------------
// (4) Adapter wires the §10.6 / §10.1 substrate paths. We pin the table /
// RPC names so a future refactor cannot silently re-target them at the
// wrong primitives — the admission contract leans on each one.
// ---------------------------------------------------------------------------

test("handleAdmitLesson loads pubkey + quarantine state from the nodes table", () => {
  assert.match(
    NO_COMMENTS,
    /nodes\?select=pubkey_b64url/,
    "getPubkeyForNode must SELECT nodes.pubkey_b64url so the wire-validator " +
      "can verify Ed25519 signatures against the producer's published key",
  );
  assert.match(
    NO_COMMENTS,
    /nodes\?select=quarantined_until/,
    "getQuarantinedUntil must SELECT nodes.quarantined_until — the §10.2 " +
      "single-strike pre-check key",
  );
});

test("handleAdmitLesson INSERTs into swarm_lessons with lesson_tier='B'", () => {
  assert.match(
    NO_COMMENTS,
    /pgPostJson\(\s*"swarm_lessons"/,
    "insertSwarmLesson must POST to swarm_lessons (admission persists at " +
      "Tier-B per the §10.6 firebreak default)",
  );
  // The handler hard-pins lesson_tier to 'B'; the wiring forwards that
  // verbatim. A future change to lesson_tier here would silently bypass
  // the §10.6 broadcast firewall.
  assert.match(
    NO_COMMENTS,
    /lesson_tier:\s*"B"/,
    "INSERT body must pin lesson_tier='B' (firebreak default for any " +
      "externally-admitted lesson per §10.6)",
  );
});

test("recordTrustEdgeChange adapter calls record_trust_edge_change RPC", () => {
  assert.match(
    NO_COMMENTS,
    /callRpc\(\s*"record_trust_edge_change"/,
    "recordTrustEdgeChange must go through the migration-075 RPC so the " +
      "trust_edge_log audit row is appended (§10.1)",
  );
});

test("setQuarantine adapter PATCHes nodes.quarantined_until directly", () => {
  // The single-strike window is one hour and quarantine_origin enforces
  // p_days > 0; using PATCH is the only way to express the sub-day
  // interval without a schema change. Mirror of the operator-restore PATCH
  // path in #157.
  const compact = NO_COMMENTS.replace(/\s+/g, "");
  assert.match(
    compact,
    /pgPatchJson\(`nodes\?node_id=eq\./,
    "setQuarantine must PATCH /nodes?node_id=eq.<id> so the §10.2 1-hour " +
      "single-strike window is expressible (quarantine_origin RPC enforces " +
      "p_days > 0 and can't represent sub-day windows)",
  );
  assert.ok(
    !/quarantine_origin/.test(
      NO_COMMENTS.slice(NO_COMMENTS.indexOf("setQuarantine")),
    ) || NO_COMMENTS.indexOf("setQuarantine") < 0,
    "setQuarantine adapter must NOT call the quarantine_origin RPC — " +
      "p_days > 0 contract refuses sub-day windows",
  );
});
