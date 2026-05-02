/**
 * Contract test for the wiring of POST /swarm/contradict-resolve into
 * scripts/dashboard-server.mjs and the operator action buttons in
 * dashboard/index.html (Swarm phase 4, issue #142 frontend slice).
 *
 * The substrate (migration 086) and the dashboard POST handler shipped in
 * PR #157 with their own coverage. This test pins the pieces the HTTP host
 * has to assemble so a future refactor can't silently break the operator
 * round-trip:
 *
 *   1. /swarm-overview reads the *_active VIEW (resolved pairs disappear).
 *   2. The dispatcher routes POST /swarm/contradict-resolve to the handler.
 *   3. The handler calls operator_resolve_contradict and forwards the
 *      'decision' whitelist {a,b,park}.
 *   4. The dashboard renders 3 action buttons per pair with data-decision
 *      values matching the RPC whitelist, and the click handler POSTs to
 *      /swarm/contradict-resolve before re-fetching loadSwarm().
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
// HTML carries CSS comments + JS comments inside <script>; strip both shapes
// so prose like "/* operator buttons */" can't satisfy a code-shape assert.
const HTML_NO_COMMENTS = HTML_RAW
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// (1) /swarm-overview reads the migration-086 active VIEW, not the raw table.
// Resolved pairs ship with resolved_at IS NOT NULL, so a raw-table read would
// keep showing them in the dashboard after the operator action — which is
// exactly the bug this slice is meant to close.
// ---------------------------------------------------------------------------

test("/swarm-overview reads swarm_lesson_contradictions_active for the contradict list", () => {
  assert.match(
    SERVER_NO_COMMENTS,
    /swarm_lesson_contradictions_active\?select=id,a_id,b_id/,
    "/swarm-overview contradicts list must read the *_active VIEW so " +
      "operator-resolved pairs drop out without an application-level filter",
  );
});

test("/swarm-overview KPI counter reads swarm_lesson_contradictions_active", () => {
  // The widersprüche tile counts open contradicts. If it stayed on the raw
  // table the number would never decrement after a resolve; the operator
  // would see "1× operator-prüfung offen" forever.
  const kpiCountReads = SERVER_NO_COMMENTS.match(
    /swarm_lesson_contradictions_active\?select=id&limit=1000/g,
  );
  assert.ok(
    kpiCountReads && kpiCountReads.length >= 1,
    "the contradicts KPI count must read the *_active VIEW so the " +
      "widersprüche tile decrements after a resolve action",
  );
});

test("dashboard-server.mjs no longer reads the raw swarm_lesson_contradictions table", () => {
  // Catch a partial revert — if either the list or the KPI roll-back to
  // the raw table, the active-view firewall has a hole.
  assert.ok(
    !/swarm_lesson_contradictions\?select/.test(SERVER_NO_COMMENTS),
    "/swarm-overview must NOT SELECT from swarm_lesson_contradictions " +
      "directly — both the list and the KPI count must use the *_active " +
      "VIEW from migration 086",
  );
});

// ---------------------------------------------------------------------------
// (2) The dispatcher routes POST /swarm/contradict-resolve to the handler
// and the handler calls operator_resolve_contradict.
// ---------------------------------------------------------------------------

test("dashboard-server registers the /swarm/contradict-resolve route", () => {
  assert.match(
    SERVER_NO_COMMENTS,
    /req\.url\s*===\s*"\/swarm\/contradict-resolve"\s*\)\s*return\s+handleSwarmContradictResolve/,
    "dispatcher must route /swarm/contradict-resolve to " +
      "handleSwarmContradictResolve",
  );
});

test("handleSwarmContradictResolve calls the operator_resolve_contradict RPC", () => {
  // The operator decision goes through the SECURITY-INVOKER RPC from
  // migration 086 — bypassing it would lose the audit trail in
  // tier_promotion_log. callRpc() is the helper that prefixes /rpc/ and
  // attaches the service-role JWT.
  assert.match(
    SERVER_NO_COMMENTS,
    /callRpc\(\s*"operator_resolve_contradict"/,
    "handleSwarmContradictResolve must invoke " +
      "callRpc('operator_resolve_contradict', ...) so tier_promotion_log " +
      "captures the operator decision",
  );
});

test("handleSwarmContradictResolve enforces the {a,b,park} decision whitelist client-side", () => {
  // The RPC also enforces this, but doing it on the HTTP boundary lets us
  // 4xx the operator before a round-trip.
  const handlerStart = SERVER_NO_COMMENTS.indexOf(
    "function handleSwarmContradictResolve",
  );
  assert.ok(handlerStart > 0, "handler function must exist");
  const handlerEnd = SERVER_NO_COMMENTS.indexOf(
    "function handleSwarm",
    handlerStart + 1,
  );
  const body = SERVER_NO_COMMENTS.slice(
    handlerStart,
    handlerEnd > 0 ? handlerEnd : handlerStart + 4000,
  );
  assert.match(
    body,
    /\["a",\s*"b",\s*"park"\]|'a',\s*'b',\s*'park'|"a"\s*,\s*"b"\s*,\s*"park"/,
    "handleSwarmContradictResolve must validate decision against the " +
      "{a,b,park} whitelist before forwarding to the RPC",
  );
});

// ---------------------------------------------------------------------------
// (3) The dashboard renders the three operator buttons with data-decision
// values that match the RPC whitelist, and the click path POSTs to the
// dashboard-server route before re-fetching loadSwarm().
// ---------------------------------------------------------------------------

test("dashboard renders contradict action buttons with the {a,b,park} decisions", () => {
  // All three values must appear as data-decision attributes inside the
  // contradicts-actions block — a missing one would silently leave the
  // operator unable to choose that branch.
  assert.match(
    HTML_NO_COMMENTS,
    /class="contradicts-actions"[^>]*data-pair-id=/,
    "contradicts-actions wrapper must carry the pair_id for the click " +
      "handler to forward to the RPC",
  );
  for (const decision of ["a", "b", "park"]) {
    const re = new RegExp(`data-decision="${decision}"`);
    assert.match(
      HTML_NO_COMMENTS,
      re,
      `contradicts-actions must render a button with ` +
        `data-decision="${decision}" — missing the ${decision} branch ` +
        `would leave the operator unable to choose it`,
    );
  }
});

test("resolveContradict posts to /swarm/contradict-resolve and re-fetches loadSwarm", () => {
  const fnStart = HTML_NO_COMMENTS.indexOf("async function resolveContradict");
  assert.ok(fnStart > 0, "resolveContradict function must exist");
  // Bound the body to the next top-level function so this test can't be
  // satisfied by an unrelated fetch elsewhere.
  const fnEnd = HTML_NO_COMMENTS.indexOf("\nfunction ", fnStart + 1);
  const body = HTML_NO_COMMENTS.slice(
    fnStart,
    fnEnd > 0 ? fnEnd : fnStart + 2000,
  );
  assert.match(
    body,
    /fetch\("\/swarm\/contradict-resolve"/,
    "resolveContradict must POST to /swarm/contradict-resolve",
  );
  assert.match(
    body,
    /method:\s*"POST"/,
    "resolveContradict fetch must use POST",
  );
  assert.match(
    body,
    /pair_id:\s*pairId/,
    "resolveContradict must forward pair_id in the JSON body",
  );
  assert.match(
    body,
    /decision/,
    "resolveContradict must forward the decision in the JSON body",
  );
  assert.match(
    body,
    /loadSwarm\(\)/,
    "resolveContradict must re-fetch loadSwarm() on success so the " +
      "resolved row drops out of the *_active view",
  );
});
