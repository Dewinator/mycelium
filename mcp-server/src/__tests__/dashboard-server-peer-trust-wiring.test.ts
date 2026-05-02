/**
 * Contract test for the wiring of POST /swarm/peer-trust-override into
 * scripts/dashboard-server.mjs and the operator action buttons in
 * dashboard/index.html (Swarm phase 4, issue #142 frontend slice).
 *
 * The substrate (migrations 075 record_trust_edge_change + quarantine_origin)
 * and the dashboard POST handler shipped in PR #157 with their own coverage.
 * This test pins the pieces the HTTP host has to assemble so a future
 * refactor can't silently break the operator round-trip:
 *
 *   1. The dispatcher routes POST /swarm/peer-trust-override to the handler.
 *   2. The handler enforces the {distrust, restore} action whitelist and
 *      composes the existing audit-trail RPCs (record_trust_edge_change for
 *      both branches; quarantine_origin for distrust; PATCH /nodes for the
 *      quarantine-clear on restore — no clear_quarantine RPC exists).
 *   3. The dashboard renders 2 action buttons per peer row with data-action
 *      values matching the whitelist, and the click handler POSTs to
 *      /swarm/peer-trust-override before re-fetching loadSwarm().
 *
 * Same shape-pin discipline as dashboard-server-lesson-proof-wiring.test.ts:
 * neither file is part of the tsc test loop, so we read both as text and
 * assert structural facts (comments stripped before matching so an
 * explanatory comment cannot satisfy a structural assertion).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DASHBOARD_SERVER = resolve(ROOT, "scripts/dashboard-server.mjs");
const DASHBOARD_HTML = resolve(ROOT, "dashboard/index.html");

const SERVER_RAW = readFileSync(DASHBOARD_SERVER, "utf8");
const SERVER_NO_COMMENTS = SERVER_RAW
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const HTML_RAW = readFileSync(DASHBOARD_HTML, "utf8");
const HTML_NO_COMMENTS = HTML_RAW
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// (1) The dispatcher routes POST /swarm/peer-trust-override to the handler.
// ---------------------------------------------------------------------------

test("dashboard-server registers the /swarm/peer-trust-override route", () => {
  assert.match(
    SERVER_NO_COMMENTS,
    /req\.url\s*===\s*"\/swarm\/peer-trust-override"\s*\)\s*return\s+handleSwarmPeerTrustOverride/,
    "dispatcher must route /swarm/peer-trust-override to " +
      "handleSwarmPeerTrustOverride",
  );
});

// ---------------------------------------------------------------------------
// (2) Handler shape: action whitelist + audit-trail RPCs for both branches.
// ---------------------------------------------------------------------------

function handlerBody(): string {
  const start = SERVER_NO_COMMENTS.indexOf(
    "function handleSwarmPeerTrustOverride",
  );
  assert.ok(start > 0, "handleSwarmPeerTrustOverride must exist");
  const end = SERVER_NO_COMMENTS.indexOf("function handleSwarm", start + 1);
  return SERVER_NO_COMMENTS.slice(start, end > 0 ? end : start + 6000);
}

test("handleSwarmPeerTrustOverride enforces the {distrust, restore} action whitelist", () => {
  // The handler validates at the HTTP boundary — invalid actions get
  // rejected before any RPC round-trip reaches the database.
  assert.match(
    handlerBody(),
    /\["distrust",\s*"restore"\]|'distrust',\s*'restore'|"distrust"\s*,\s*"restore"/,
    "handleSwarmPeerTrustOverride must validate action against the " +
      "{distrust, restore} whitelist before forwarding to the RPCs",
  );
});

test("handleSwarmPeerTrustOverride writes to record_trust_edge_change with operator reasons", () => {
  // record_trust_edge_change is the §10.1 audit-trail entry point. Both
  // branches must go through it so trust_edge_log captures the operator
  // override (and not just the underlying weight change).
  const body = handlerBody();
  assert.match(
    body,
    /callRpc\(\s*"record_trust_edge_change"/,
    "handleSwarmPeerTrustOverride must invoke record_trust_edge_change " +
      "to keep trust_edge_log as the single source of truth for trust " +
      "movements",
  );
  assert.match(
    body,
    /"operator-override-distrust"/,
    "distrust branch must annotate the trust_edge_log with the " +
      "operator-override-distrust reason",
  );
  assert.match(
    body,
    /"operator-override-restore"/,
    "restore branch must annotate the trust_edge_log with the " +
      "operator-override-restore reason",
  );
});

test("handleSwarmPeerTrustOverride distrust branch composes quarantine_origin", () => {
  // §10.2 quarantine state machine. operator-override-distrust pushes the
  // peer into quarantine immediately; without quarantine_origin the trust
  // drop alone wouldn't suspend lesson admission.
  assert.match(
    handlerBody(),
    /callRpc\(\s*"quarantine_origin"/,
    "distrust branch must invoke quarantine_origin so the §10.2 state " +
      "machine actually suspends lesson admission for the peer",
  );
});

test("handleSwarmPeerTrustOverride restore branch clears quarantined_until via PATCH /nodes", () => {
  // No clear_quarantine RPC exists; quarantine_origin enforces days > 0
  // so it can't be reused. The restore branch goes through PostgREST with
  // the same service-role JWT to UPDATE quarantined_until=NULL.
  const body = handlerBody();
  assert.match(
    body,
    /\/nodes\?node_id=eq\./,
    "restore branch must PATCH /nodes?node_id=eq.<id> on PostgREST to " +
      "clear the quarantined_until column directly",
  );
  assert.match(
    body,
    /quarantined_until:\s*null/,
    "restore branch must explicitly set quarantined_until: null in the " +
      "PATCH body — the §10.2 state machine treats NULL as 'not " +
      "quarantined'",
  );
});

// ---------------------------------------------------------------------------
// (3) Frontend renders both operator buttons and wires the click path.
// ---------------------------------------------------------------------------

test("dashboard renders peer-trust action buttons with the {distrust, restore} actions", () => {
  // Both actions must appear as data-action attributes inside the
  // peer-actions block. A missing one would silently leave the operator
  // unable to choose that branch.
  for (const action of ["distrust", "restore"]) {
    const re = new RegExp(`data-action="${action}"`);
    assert.match(
      HTML_NO_COMMENTS,
      re,
      `peer-actions must render a button with data-action="${action}" — ` +
        `missing the ${action} branch would leave the operator unable to ` +
        `choose it`,
    );
  }
});

test("peer table row carries the node_id for the click handler to forward", () => {
  // The click handler reads row.dataset.nodeId. Without data-node-id on
  // the <tr> the handler has nothing to send to /swarm/peer-trust-override
  // and the POST would 400 with 'node_id required'.
  assert.match(
    HTML_NO_COMMENTS,
    /<tr data-node-id=/,
    "peer table rows must carry data-node-id so the click handler can " +
      "forward node_id in the POST body",
  );
});

test("overrideTrust posts to /swarm/peer-trust-override and re-fetches loadSwarm", () => {
  const fnStart = HTML_NO_COMMENTS.indexOf("async function overrideTrust");
  assert.ok(fnStart > 0, "overrideTrust function must exist");
  // Bound the body to the next top-level function so this test can't be
  // satisfied by an unrelated fetch elsewhere.
  const fnEnd = HTML_NO_COMMENTS.indexOf("\nfunction ", fnStart + 1);
  const body = HTML_NO_COMMENTS.slice(
    fnStart,
    fnEnd > 0 ? fnEnd : fnStart + 2000,
  );
  assert.match(
    body,
    /fetch\("\/swarm\/peer-trust-override"/,
    "overrideTrust must POST to /swarm/peer-trust-override",
  );
  assert.match(
    body,
    /method:\s*"POST"/,
    "overrideTrust fetch must use POST",
  );
  assert.match(
    body,
    /node_id:\s*nodeId/,
    "overrideTrust must forward node_id in the JSON body",
  );
  assert.match(
    body,
    /action/,
    "overrideTrust must forward the action in the JSON body",
  );
  assert.match(
    body,
    /loadSwarm\(\)/,
    "overrideTrust must re-fetch loadSwarm() on success so the row " +
      "reflects the new trust weight + cleared quarantine",
  );
});
