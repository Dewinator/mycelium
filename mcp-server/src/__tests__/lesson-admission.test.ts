/**
 * Tests for admitSwarmLesson — Swarm sub-phase 4j (issue #138).
 *
 * Substrate-only: the handler returns an HttpResponseShape and takes every
 * side-effect via injected callbacks. So we test the handler in isolation
 * (no HTTP server, no DB) by passing in-memory deps and asserting on the
 * triple's status / body / headers, plus on what the deps observed.
 *
 * Coverage (one assertion per branch in admitSwarmLesson):
 *   - 400 on non-object body
 *   - 400 on missing origin_node_id
 *   - 400 on malformed lesson id
 *   - 400 on self-loop (origin == self.node_id)
 *   - 401 on unknown peer (no quarantine — no edge to write to)
 *   - 403 on already-quarantined origin
 *   - 401 + quarantine on bad signature (rule 5)
 *   - 401 + quarantine on broken chain (rule 19)
 *   - 400 + quarantine on PoK count rule (rule 16)
 *   - 400 + quarantine on PoK shape rule (rule 20)
 *   - 400 plain on missing required field (rule 2)
 *   - 503 on insertSwarmLesson throw (validation passed but persist failed)
 *   - 201 happy path: row inserted with lesson_tier='B', trust +0.05 logged,
 *     gate ran, response carries the lesson_id and contradiction count
 *   - Trust-edge throw is non-fatal (still 201)
 *   - Gate throw is non-fatal (still 201)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  admitSwarmLesson,
  type LessonAdmissionDeps,
} from "../swarm/endpoints/lesson-admission.js";
import { sign } from "../services/signature.js";
import { computeNodeId } from "../services/node-identity.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";
import type { ContradictionFinding, SwarmLessonRow } from "../services/lesson-contradiction-gate.js";

// ---------------------------------------------------------------------------
// Fixtures (mirror wire-validator.test.ts so failure modes match)
// ---------------------------------------------------------------------------

interface Identity {
  pem: string;
  pubkeyRaw: Uint8Array;
  pubkeyB64: string;
  nodeId: string;
}

function freshIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubkeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    pem,
    pubkeyRaw,
    pubkeyB64: Buffer.from(pubkeyRaw).toString("base64"),
    nodeId: computeNodeId(Buffer.from(pubkeyRaw)),
  };
}

function full768Embedding(seed = 0): number[] {
  const out = new Array<number>(768);
  for (let i = 0; i < 768; i++) out[i] = (seed + i) / 1000;
  return out;
}

const FIXED_NOW = new Date("2026-04-28T12:00:00.000Z");

function buildValidLessonRecord(
  producer: Identity,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const unsigned = {
    id: "11111111-2222-4333-8444-555555555555",
    content: "Receivers must firebreak admitted lessons at Tier-B by default.",
    embedding: full768Embedding(),
    synthesized_from_cluster_size: 4,
    origin_node_id: producer.nodeId,
    signed_at: "2026-04-28T11:00:00.000Z",
    created_at: "2026-04-27T10:00:00.000Z",
    tags: ["test", "swarm"],
    spec_version: WIRE_SPEC_VERSION,
    evidence_root: "1220" + "ab".repeat(32),
    evidence_count: 4,
    prev_lesson_hash: null,
    maturity_age_days: 1,
    useful_count: 0,
    ...overrides,
  };
  return { ...unsigned, signature: sign(unsigned, producer.pem) };
}

interface DepsHarness {
  deps: LessonAdmissionDeps;
  inserted: Array<{ row: unknown; assigned_id: string }>;
  trustEdges: Array<{ node_id: string; delta: number; reason: string }>;
  quarantines: Array<{ node_id: string; until_ms: number; reason: string }>;
  gateInputs: SwarmLessonRow[];
}

interface HarnessOptions {
  body: unknown;
  self: Identity;
  knownPeers?: Map<string, Identity>;
  quarantinedUntil?: Map<string, string>;
  expectedPrevHash?: Map<string, string>;
  failInsert?: boolean;
  failTrust?: boolean;
  failGate?: boolean;
  gateFindings?: ContradictionFinding[];
  withGate?: boolean;
  loadSelfThrows?: boolean;
}

function buildHarness(opts: HarnessOptions): DepsHarness {
  const inserted: DepsHarness["inserted"] = [];
  const trustEdges: DepsHarness["trustEdges"] = [];
  const quarantines: DepsHarness["quarantines"] = [];
  const gateInputs: SwarmLessonRow[] = [];

  const deps: LessonAdmissionDeps = {
    body: opts.body,
    ourSpecMajor: 1,
    now: FIXED_NOW,
    loadSelf: async () => {
      if (opts.loadSelfThrows) throw new Error("loadSelf boom");
      return { node_id: opts.self.nodeId, pubkey_b64: opts.self.pubkeyB64 };
    },
    getPubkeyForNode: async (nodeId) => {
      const peer = opts.knownPeers?.get(nodeId);
      return peer ? peer.pubkeyRaw : null;
    },
    getQuarantinedUntil: async (nodeId) =>
      opts.quarantinedUntil?.get(nodeId) ?? null,
    getExpectedPrevLessonHash: opts.expectedPrevHash
      ? async (nodeId) => opts.expectedPrevHash!.get(nodeId) ?? null
      : undefined,
    insertSwarmLesson: async (row) => {
      if (opts.failInsert) throw new Error("insert boom");
      const assigned_id = row.id; // honour the wire id (validator already enforced UUID)
      inserted.push({ row, assigned_id });
      return { lesson_id: assigned_id };
    },
    setQuarantine: async (node_id, until_ms, reason) => {
      quarantines.push({ node_id, until_ms, reason });
    },
    recordTrustEdgeChange: async (node_id, delta, reason) => {
      if (opts.failTrust) throw new Error("trust boom");
      trustEdges.push({ node_id, delta, reason });
    },
    runContradictionGate: opts.withGate
      ? async (incoming) => {
          gateInputs.push(incoming);
          if (opts.failGate) throw new Error("gate boom");
          return { findings: opts.gateFindings ?? [] };
        }
      : undefined,
  };

  return { deps, inserted, trustEdges, quarantines, gateInputs };
}

async function readJson(body: string): Promise<Record<string, unknown>> {
  return JSON.parse(body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 400 / 401 / 403 — pre-validation guards
// ---------------------------------------------------------------------------

test("rejects 400 when body is not a JSON object", async () => {
  const self = freshIdentity();
  const h = buildHarness({ body: "this is a string", self });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.match(body.error as string, /JSON object/);
  assert.equal(h.inserted.length, 0);
  assert.equal(h.quarantines.length, 0);
});

test("rejects 400 when origin_node_id is missing or empty", async () => {
  const self = freshIdentity();
  const h = buildHarness({ body: { content: "no origin" }, self });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.equal(body.rule, 2);
  assert.equal(h.inserted.length, 0);
});

test("rejects 400 when lesson id is not a UUID", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer, { id: "not-a-uuid" });
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.equal(body.rule, 3);
  assert.equal(h.inserted.length, 0);
});

test("rejects 400 on self-loop (origin == self.node_id)", async () => {
  const self = freshIdentity();
  const record = buildValidLessonRecord(self);
  const h = buildHarness({ body: record, self });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.match(body.error as string, /self-published/);
  assert.equal(body.origin_node_id, self.nodeId);
});

test("rejects 401 with no quarantine when peer is unknown", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map(), // peer not registered
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 401);
  const body = await readJson(res.body);
  assert.match(body.error as string, /unknown peer/);
  // No edge to quarantine — the firebreak only applies once we know who they are.
  assert.equal(h.quarantines.length, 0);
});

test("rejects 403 when origin is currently quarantined", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const futureIso = new Date(FIXED_NOW.getTime() + 30 * 60 * 1000).toISOString();
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    quarantinedUntil: new Map([[peer.nodeId, futureIso]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 403);
  const body = await readJson(res.body);
  assert.equal(body.quarantined_until, futureIso);
  // Pre-check is decision-only — does not re-quarantine.
  assert.equal(h.quarantines.length, 0);
  // And we never reached the persist layer.
  assert.equal(h.inserted.length, 0);
});

test("admits 201 when an expired quarantine is in the past", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const pastIso = new Date(FIXED_NOW.getTime() - 60 * 1000).toISOString();
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    quarantinedUntil: new Map([[peer.nodeId, pastIso]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 201);
  assert.equal(h.inserted.length, 1);
});

// ---------------------------------------------------------------------------
// Single-strike rules: 5, 19 (-> 401 + quarantine), 16, 20 (-> 400 + quarantine)
// ---------------------------------------------------------------------------

test("rejects 401 + quarantine on bad signature (rule 5)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  // Sign as `peer`, then mutate a field after signing — signature no longer matches.
  const tampered = {
    ...buildValidLessonRecord(peer),
    content: "MUTATED AFTER SIGNING",
  };
  const h = buildHarness({
    body: tampered,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 401);
  const body = await readJson(res.body);
  assert.equal(body.rule, 5);
  assert.equal(body.quarantined, true);
  assert.equal(h.quarantines.length, 1);
  assert.equal(h.quarantines[0].node_id, peer.nodeId);
  assert.equal(
    h.quarantines[0].until_ms,
    FIXED_NOW.getTime() + 60 * 60 * 1000,
  );
  assert.equal(h.inserted.length, 0);
});

test("rejects 401 + quarantine on broken commitment chain (rule 19)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  // Producer claims their predecessor was hash A, but our cache says hash B.
  const record = buildValidLessonRecord(peer, {
    prev_lesson_hash: "Qm" + "z".repeat(44),
  });
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    expectedPrevHash: new Map([[peer.nodeId, "Qm" + "x".repeat(44)]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 401);
  const body = await readJson(res.body);
  assert.equal(body.rule, 19);
  assert.equal(body.quarantined, true);
  assert.equal(h.quarantines.length, 1);
});

test("rejects 400 + quarantine on PoK count rule (rule 16)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  // evidence_count=0 trips rule 16 (must be integer >= 1).
  const record = buildValidLessonRecord(peer, { evidence_count: 0 });
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.equal(body.rule, 16);
  assert.equal(body.quarantined, true);
  assert.equal(h.quarantines.length, 1);
});

test("rejects 400 + quarantine on PoK shape rule (rule 20, smuggling on 1.0)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  // v1.0 record carrying v1.1 PoK fields trips rule 20 (third leg).
  const record = buildValidLessonRecord(peer, {
    spec_version: "1.0",
    // PoK fields stay attached from the base fixture — illegal on v1.0.
  });
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.equal(body.rule, 20);
  assert.equal(body.quarantined, true);
});

// ---------------------------------------------------------------------------
// Plain rejections — validator failures that do NOT pull a quarantine
// ---------------------------------------------------------------------------

test("rejects 400 plain on missing required field (rule 2)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  // Drop `content` AFTER signing — but we have to re-sign without it so
  // rule 5 doesn't fire first. So drop content from the unsigned base
  // and re-sign.
  const valid = buildValidLessonRecord(peer);
  const { content, signature, ...withoutContent } = valid as Record<
    string,
    unknown
  >;
  void content;
  void signature;
  const resigned = { ...withoutContent, signature: sign(withoutContent, peer.pem) };
  const h = buildHarness({
    body: resigned,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 400);
  const body = await readJson(res.body);
  assert.equal(body.rule, 2);
  assert.equal(body.quarantined, false);
  assert.equal(h.quarantines.length, 0);
});

// ---------------------------------------------------------------------------
// Persistence-layer failures
// ---------------------------------------------------------------------------

test("rejects 503 when insertSwarmLesson throws", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    failInsert: true,
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 503);
  const body = await readJson(res.body);
  assert.match(body.error as string, /insertSwarmLesson failed/);
  // Trust update must NOT have run — the lesson never persisted.
  assert.equal(h.trustEdges.length, 0);
});

test("rejects 503 when loadSelf throws", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    loadSelfThrows: true,
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("admits 201 and writes the row, trust edge, and runs gate", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const finding: ContradictionFinding = {
    new_lesson_id: "11111111-2222-4333-8444-555555555555",
    prior_lesson_id: "99999999-8888-4777-8666-555555555555",
    cosine: 0.91,
    confidence: 0.91,
    reason: "polarity inversion",
  };
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    withGate: true,
    gateFindings: [finding],
  });
  const res = await admitSwarmLesson(h.deps);

  assert.equal(res.status, 201);
  assert.equal(
    res.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  const body = await readJson(res.body);
  assert.equal(body.lesson_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(body.lesson_tier, "B");
  assert.equal(body.contradictions, 1);
  assert.equal(body.origin_node_id, peer.nodeId);

  // Row persisted with the §10.6 firebreak default.
  assert.equal(h.inserted.length, 1);
  const persisted = h.inserted[0].row as Record<string, unknown>;
  assert.equal(persisted.lesson_tier, "B");
  assert.equal(persisted.origin_node_id, peer.nodeId);

  // Trust edge: §10.1 +0.05 'admitted'.
  assert.equal(h.trustEdges.length, 1);
  assert.equal(h.trustEdges[0].node_id, peer.nodeId);
  assert.equal(h.trustEdges[0].delta, 0.05);
  assert.equal(h.trustEdges[0].reason, "admitted");

  // Gate received the freshly-admitted row.
  assert.equal(h.gateInputs.length, 1);
  assert.equal(h.gateInputs[0].id, body.lesson_id);
  assert.equal(h.gateInputs[0].lesson_tier, "B");

  // No quarantine on the happy path.
  assert.equal(h.quarantines.length, 0);
});

test("admits 201 even when trust-edge bookkeeping throws", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    failTrust: true,
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 201);
  // Lesson still persisted; trust failure is non-fatal.
  assert.equal(h.inserted.length, 1);
  assert.equal(h.trustEdges.length, 0);
});

test("admits 201 even when contradiction gate throws", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    withGate: true,
    failGate: true,
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 201);
  const body = await readJson(res.body);
  // Findings default to 0 when the gate threw.
  assert.equal(body.contradictions, 0);
  assert.equal(h.inserted.length, 1);
});

test("admits 201 with no gate dep wired (gate is optional)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const record = buildValidLessonRecord(peer);
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    withGate: false,
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 201);
  const body = await readJson(res.body);
  assert.equal(body.contradictions, 0);
  assert.equal(h.gateInputs.length, 0);
});

test("forwards prev-hash chain into the validator (happy chain)", async () => {
  const self = freshIdentity();
  const peer = freshIdentity();
  const expected = "Qm" + "y".repeat(44);
  const record = buildValidLessonRecord(peer, { prev_lesson_hash: expected });
  const h = buildHarness({
    body: record,
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    expectedPrevHash: new Map([[peer.nodeId, expected]]),
  });
  const res = await admitSwarmLesson(h.deps);
  assert.equal(res.status, 201);
});
