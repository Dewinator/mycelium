import { test } from "node:test";
import assert from "node:assert/strict";

import { swarmListPeers, swarmListPeersSchema } from "../tools/swarm-peers.js";
import type {
  SwarmPeersClient,
  PeerSummary,
} from "../services/swarm-peers.js";

// ---------------------------------------------------------------------------
// swarm_list_peers — issue #143 read-only slice
//
// The service-side query logic (joins against trust_edge_log + 24h
// admission window) is exercised by the integration test in the follow-up
// PR that wires Supabase fixtures. These tests pin the contracts the tool
// layer owns:
//
//   1. schema accepts/rejects inputs as documented
//   2. empty peer list produces a friendly "no peers known" message,
//      never an empty content array (which the MCP client renders as a
//      blank reply, surprising the operator)
//   3. quarantine flag derives from quarantined_until vs. now, not from
//      the timestamp's raw presence — an expired quarantine must NOT
//      render as "yes" (regression prevention for the schwarm-tab bug
//      where quarantines stayed sticky in the UI)
//   4. last_trust_delta absence → "(none)" line, not a missing line
//      (operators read the delta to triage trust drift; absent is a
//      meaningful signal, not a placeholder to hide)
//   5. includeSelf flag round-trips into the service call so the tool
//      can't silently ignore it
// ---------------------------------------------------------------------------

class FakeService implements SwarmPeersClient {
  rows: PeerSummary[] = [];
  calls: Array<{ includeSelf: boolean }> = [];
  error: Error | null = null;

  async listPeers(includeSelf: boolean): Promise<PeerSummary[]> {
    this.calls.push({ includeSelf });
    if (this.error) throw this.error;
    return this.rows;
  }
}

function peer(overrides: Partial<PeerSummary>): PeerSummary {
  return {
    node_id: "QmFakePeer1",
    display_name: null,
    is_self: false,
    trust_weight: 0.5,
    is_quarantined: false,
    quarantined_until: null,
    last_seen_at: null,
    last_decay_at: null,
    decay_reason: null,
    consecutive_rejections: 0,
    last_trust_delta: null,
    recent_admissions_24h: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) schema
// ---------------------------------------------------------------------------

test("schema: includeSelf defaults to undefined (tool resolves to false)", () => {
  const parsed = swarmListPeersSchema.parse({});
  assert.equal(parsed.includeSelf, undefined);
});

test("schema: rejects non-boolean includeSelf", () => {
  assert.throws(() => swarmListPeersSchema.parse({ includeSelf: "yes" }));
  assert.throws(() => swarmListPeersSchema.parse({ includeSelf: 1 }));
});

// ---------------------------------------------------------------------------
// (2) empty peer list
// ---------------------------------------------------------------------------

test("empty peer set returns a friendly no-peers message", async () => {
  const svc = new FakeService();
  const r = await swarmListPeers(svc, { includeSelf: false });
  assert.equal(r.content.length, 1);
  assert.match(r.content[0].text, /No peers known yet/);
});

// ---------------------------------------------------------------------------
// (3) includeSelf flag round-trips
// ---------------------------------------------------------------------------

test("includeSelf=true is forwarded to the service", async () => {
  const svc = new FakeService();
  await swarmListPeers(svc, { includeSelf: true });
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].includeSelf, true);
});

test("includeSelf omitted defaults to false at the service boundary", async () => {
  const svc = new FakeService();
  await swarmListPeers(svc, {});
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].includeSelf, false);
});

// ---------------------------------------------------------------------------
// (4) quarantine rendering
// ---------------------------------------------------------------------------

test("active quarantine renders 'yes (until <ts>)'", async () => {
  const svc = new FakeService();
  svc.rows = [
    peer({
      node_id: "QmActive",
      is_quarantined: true,
      quarantined_until: "2099-01-01T00:00:00Z",
    }),
  ];
  const r = await swarmListPeers(svc, {});
  assert.match(
    r.content[0].text,
    /quarantined:\s+yes \(until 2099-01-01T00:00:00Z\)/
  );
});

test("expired quarantine renders 'no (last quarantine expired …)' — never 'yes'", async () => {
  // Regression: the schwarm-tab UI used to render any non-NULL
  // quarantined_until as "still quarantined" because it never compared
  // against now(). The tool layer must NEVER reproduce that bug — the
  // expiry comparison happens in the service and is_quarantined is what
  // the renderer consults.
  const svc = new FakeService();
  svc.rows = [
    peer({
      node_id: "QmExpired",
      is_quarantined: false,
      quarantined_until: "2020-01-01T00:00:00Z",
    }),
  ];
  const r = await swarmListPeers(svc, {});
  assert.match(r.content[0].text, /quarantined:\s+no \(last quarantine expired/);
  assert.doesNotMatch(r.content[0].text, /quarantined:\s+yes/);
});

test("never-quarantined peer renders plain 'no'", async () => {
  const svc = new FakeService();
  svc.rows = [peer({ node_id: "QmFresh" })];
  const r = await swarmListPeers(svc, {});
  assert.match(r.content[0].text, /quarantined:\s+no\b/);
  assert.doesNotMatch(r.content[0].text, /quarantine expired/);
});

// ---------------------------------------------------------------------------
// (5) trust delta + admissions rendering
// ---------------------------------------------------------------------------

test("absent last_trust_delta renders '(none)' line (not omitted)", async () => {
  const svc = new FakeService();
  svc.rows = [peer({ node_id: "QmNoDelta", last_trust_delta: null })];
  const r = await swarmListPeers(svc, {});
  assert.match(r.content[0].text, /last_trust_delta:\s+\(none\)/);
});

test("present last_trust_delta renders before→after with reason and timestamp", async () => {
  const svc = new FakeService();
  svc.rows = [
    peer({
      node_id: "QmDelta",
      last_trust_delta: {
        weight_before: 0.5,
        weight_after: 0.55,
        reason: "admitted",
        at: "2026-04-30T10:00:00Z",
      },
    }),
  ];
  const r = await swarmListPeers(svc, {});
  assert.match(
    r.content[0].text,
    /last_trust_delta:\s+0\.500 → 0\.550\s+\(admitted, 2026-04-30T10:00:00Z\)/
  );
});

test("recent_admissions_24h is rendered as a number (0 included, not hidden)", async () => {
  const svc = new FakeService();
  svc.rows = [
    peer({ node_id: "QmQuiet", recent_admissions_24h: 0 }),
    peer({ node_id: "QmActive", recent_admissions_24h: 12 }),
  ];
  const r = await swarmListPeers(svc, {});
  assert.match(r.content[0].text, /admissions_24h:\s+0/);
  assert.match(r.content[0].text, /admissions_24h:\s+12/);
});

// ---------------------------------------------------------------------------
// (6) self row labelling
// ---------------------------------------------------------------------------

test("self row is marked '(self)' next to the node_id", async () => {
  const svc = new FakeService();
  svc.rows = [peer({ node_id: "QmMe", is_self: true })];
  const r = await swarmListPeers(svc, { includeSelf: true });
  assert.match(r.content[0].text, /QmMe\s+\(self\)/);
});

test("non-self row has no '(self)' marker", async () => {
  const svc = new FakeService();
  svc.rows = [peer({ node_id: "QmThem", is_self: false })];
  const r = await swarmListPeers(svc, {});
  assert.doesNotMatch(r.content[0].text, /\(self\)/);
});

// ---------------------------------------------------------------------------
// (7) error propagation
// ---------------------------------------------------------------------------

test("service errors propagate (caller's withErrorHandling wraps them)", async () => {
  const svc = new FakeService();
  svc.error = new Error("postgrest 500");
  await assert.rejects(swarmListPeers(svc, {}), /postgrest 500/);
});

// ---------------------------------------------------------------------------
// (8) header pluralisation
// ---------------------------------------------------------------------------

test("header pluralises by count (1 peer vs. N peers)", async () => {
  const svc = new FakeService();
  svc.rows = [peer({ node_id: "QmOne" })];
  const r1 = await swarmListPeers(svc, {});
  assert.match(r1.content[0].text, /Found 1 peer:/);

  svc.rows = [peer({ node_id: "QmOne" }), peer({ node_id: "QmTwo" })];
  const r2 = await swarmListPeers(svc, {});
  assert.match(r2.content[0].text, /Found 2 peers:/);
});
