import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  SwarmAdmitService,
  parseAdmitResponse,
  type SwarmAdmitDeps,
  type SwarmAdmitOutcome,
} from "../services/swarm-admit.js";
import {
  swarmAdmitLesson,
  swarmAdmitLessonSchema,
} from "../tools/swarm-admit.js";
import { sign } from "../services/signature.js";
import { computeNodeId } from "../services/node-identity.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";
import type { HttpResponseShape } from "../swarm/endpoints/lesson-admission.js";

// ---------------------------------------------------------------------------
// swarm_admit_lesson — fifth and final write-side slice of issue #143
//
// Three contracts:
//   1. parseAdmitResponse maps the handler's HttpResponseShape into the
//      typed SwarmAdmitOutcome union. Throws on shape drift (missing
//      lesson_id on 201, non-JSON body) so a future handler edit fails
//      loud rather than silently mis-shaping the MCP output.
//   2. SwarmAdmitService.admit threads the deps bag into admitSwarmLesson
//      and returns a typed outcome — exercising the happy path and the
//      five rejection branches end-to-end against the same in-memory
//      harness lesson-admission.test.ts uses.
//   3. swarmAdmitLesson tool refuses without OPENCLAW_ALLOW_SWARM_WRITE=1,
//      writes a memory-bus row only on a 201, and surfaces operator-
//      actionable fix_hints on every non-201 decision.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (1) parseAdmitResponse — pure mapper
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: unknown): HttpResponseShape {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

test("parseAdmitResponse maps a 201 into the admitted outcome", () => {
  const out = parseAdmitResponse(
    jsonRes(201, {
      lesson_id: "11111111-2222-4333-8444-555555555555",
      lesson_tier: "B",
      contradictions: 0,
      origin_node_id: "QmFakePeerId",
    }),
  );
  assert.equal(out.decision, "admitted");
  if (out.decision !== "admitted") return;
  assert.equal(out.lesson_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(out.lesson_tier, "B");
  assert.deepEqual(out.contradicts_with, []);
  assert.equal(out.trust_delta, 0.05);
  assert.equal(out.origin_node_id, "QmFakePeerId");
  assert.equal(out.http_status, 201);
});

test("parseAdmitResponse throws on a 201 with missing lesson_id (shape drift loud)", () => {
  assert.throws(
    () => parseAdmitResponse(jsonRes(201, { lesson_tier: "B" })),
    /201 body missing/i,
  );
});

test("parseAdmitResponse throws on non-JSON body (shape drift loud)", () => {
  assert.throws(
    () =>
      parseAdmitResponse({
        status: 500,
        headers: {},
        body: "<html>upstream down</html>",
      }),
    /non-JSON body/i,
  );
});

test("parseAdmitResponse maps a 403 onto decision='quarantined'", () => {
  const out = parseAdmitResponse(
    jsonRes(403, {
      error: "origin is currently quarantined",
      origin_node_id: "QmPeer",
      quarantined_until: "2026-05-02T13:00:00.000Z",
    }),
  );
  assert.equal(out.decision, "quarantined");
  assert.equal(out.http_status, 403);
  assert.equal((out as { origin_node_id?: string }).origin_node_id, "QmPeer");
  assert.equal((out as { quarantined?: boolean }).quarantined, false); // pre-check, not a fresh quarantine
});

test("parseAdmitResponse maps a 401 unknown-peer onto decision='unknown_peer'", () => {
  const out = parseAdmitResponse(
    jsonRes(401, {
      error: "unknown peer; pubkey not held for origin_node_id",
      origin_node_id: "QmStranger",
    }),
  );
  assert.equal(out.decision, "unknown_peer");
});

test("parseAdmitResponse maps a 400 self-loop onto decision='self_loop'", () => {
  const out = parseAdmitResponse(
    jsonRes(400, {
      error: "admission of self-published lesson refused (use producer path)",
      origin_node_id: "QmSelf",
    }),
  );
  assert.equal(out.decision, "self_loop");
});

test("parseAdmitResponse maps a 401+rule5 onto decision='rejected' with quarantined=true", () => {
  const out = parseAdmitResponse(
    jsonRes(401, {
      error: "wire validation rejected record",
      rule: 5,
      reason: "ed25519 verify returned false",
      origin_node_id: "QmSpoof",
      quarantined: true,
    }),
  );
  assert.equal(out.decision, "rejected");
  assert.equal((out as { rule?: number }).rule, 5);
  assert.equal((out as { quarantined?: boolean }).quarantined, true);
});

test("parseAdmitResponse maps a 503 onto decision='internal_error'", () => {
  const out = parseAdmitResponse(
    jsonRes(503, {
      error: "insertSwarmLesson failed",
      detail: "ECONNREFUSED 127.0.0.1:5432",
    }),
  );
  assert.equal(out.decision, "internal_error");
  assert.equal((out as { detail?: string }).detail, "ECONNREFUSED 127.0.0.1:5432");
});

// ---------------------------------------------------------------------------
// (2) SwarmAdmitService.admit — orchestration end-to-end with a real signer
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

function full768(seed = 0): number[] {
  const out = new Array<number>(768);
  for (let i = 0; i < 768; i++) out[i] = (seed + i) / 1000;
  return out;
}

function buildValidEnvelope(
  producer: Identity,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const unsigned = {
    id: "11111111-2222-4333-8444-555555555555",
    content: "Receivers must firebreak admitted lessons at Tier-B by default.",
    embedding: full768(),
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
  deps: SwarmAdmitDeps;
  inserted: Array<{ id: string; lesson_tier: string }>;
  trust: Array<{ node_id: string; delta: number; reason: string }>;
  quarantines: Array<{ node_id: string; until_ms: number; reason: string }>;
}

function buildHarness(opts: {
  self: Identity;
  knownPeers?: Map<string, Identity>;
  quarantinedUntil?: Map<string, string>;
  failInsert?: boolean;
  failTrust?: boolean;
  loadSelfThrows?: boolean;
}): DepsHarness {
  const inserted: DepsHarness["inserted"] = [];
  const trust: DepsHarness["trust"] = [];
  const quarantines: DepsHarness["quarantines"] = [];
  return {
    inserted,
    trust,
    quarantines,
    deps: {
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
      insertSwarmLesson: async (row) => {
        if (opts.failInsert) throw new Error("insert boom");
        inserted.push({ id: row.id, lesson_tier: row.lesson_tier });
        return { lesson_id: row.id };
      },
      setQuarantine: async (node_id, until_ms, reason) => {
        quarantines.push({ node_id, until_ms, reason });
      },
      recordTrustEdgeChange: async (node_id, delta, reason) => {
        if (opts.failTrust) throw new Error("trust boom");
        trust.push({ node_id, delta, reason });
      },
    },
  };
}

const FIXED_NOW = new Date("2026-04-28T12:00:00.000Z");

test("admit returns 'admitted' on a valid v1.1 envelope and pins lesson_tier='B'", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const h = buildHarness({
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });
  const envelope = buildValidEnvelope(peer);

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });

  assert.equal(out.decision, "admitted");
  if (out.decision !== "admitted") return;
  assert.equal(out.lesson_tier, "B");
  assert.equal(out.trust_delta, 0.05);
  assert.equal(out.origin_node_id, peer.nodeId);
  // §10.6 firebreak: every admitted row lands at B.
  assert.equal(h.inserted[0].lesson_tier, "B");
  assert.equal(h.trust[0].delta, 0.05);
  assert.equal(h.trust[0].reason, "admitted");
});

test("admit returns 'self_loop' when the envelope claims this node as origin", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const envelope = buildValidEnvelope(self);
  const h = buildHarness({ self });

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  assert.equal(out.decision, "self_loop");
  assert.equal(h.inserted.length, 0, "self-loop must not persist");
});

test("admit returns 'unknown_peer' when the producer's pubkey is not held", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const h = buildHarness({ self, knownPeers: new Map() });
  const envelope = buildValidEnvelope(peer);

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  assert.equal(out.decision, "unknown_peer");
  // No edge to quarantine — §10.2 single-strike only fires for known peers.
  assert.equal(h.quarantines.length, 0);
});

test("admit returns 'quarantined' on a peer with a future quarantined_until", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const futureIso = new Date(FIXED_NOW.getTime() + 30 * 60 * 1000).toISOString();
  const h = buildHarness({
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    quarantinedUntil: new Map([[peer.nodeId, futureIso]]),
  });
  const envelope = buildValidEnvelope(peer);

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  assert.equal(out.decision, "quarantined");
  // Pre-check is decision-only — never re-quarantines.
  assert.equal(h.quarantines.length, 0);
  assert.equal(h.inserted.length, 0);
});

test("admit returns 'rejected' with rule=5 + quarantined=true on bad signature", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const envelope = buildValidEnvelope(peer);
  // Tamper the signature so rule 5 fails.
  envelope.signature = "BADBASE64=";
  const h = buildHarness({
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
  });

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  assert.equal(out.decision, "rejected");
  assert.equal((out as { rule?: number }).rule, 5);
  assert.equal((out as { quarantined?: boolean }).quarantined, true);
  // §10.2 single-strike: handler called setQuarantine.
  assert.equal(h.quarantines.length, 1);
  assert.equal(h.quarantines[0].reason, "wire-rule-5");
});

test("admit returns 'internal_error' when insertSwarmLesson throws", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const h = buildHarness({
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    failInsert: true,
  });
  const envelope = buildValidEnvelope(peer);

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  assert.equal(out.decision, "internal_error");
});

test("admit still returns 'admitted' when the trust-edge bump throws (best-effort)", async () => {
  const svc = new SwarmAdmitService("http://stub", "stub");
  const self = freshIdentity();
  const peer = freshIdentity();
  const h = buildHarness({
    self,
    knownPeers: new Map([[peer.nodeId, peer]]),
    failTrust: true,
  });
  const envelope = buildValidEnvelope(peer);

  const out = await svc.admit(envelope, h.deps, { now: FIXED_NOW });
  // Lesson is durable; trust failure degrades reputation accuracy, not correctness.
  assert.equal(out.decision, "admitted");
  assert.equal(h.inserted.length, 1);
  assert.equal(h.trust.length, 0);
});

// ---------------------------------------------------------------------------
// (3) MCP tool: ethics-gate, fix_hints, memory side-effect
// ---------------------------------------------------------------------------

const FAKE_ENVELOPE = { id: "irrelevant — gate refuses before validation" };

test("swarmAdmitLesson refuses when OPENCLAW_ALLOW_SWARM_WRITE is unset", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  try {
    const stubSvc = {} as unknown as SwarmAdmitService;
    const stubMem = {} as unknown as Parameters<typeof swarmAdmitLesson>[1];
    const out = await swarmAdmitLesson(stubSvc, stubMem, { envelope: FAKE_ENVELOPE });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
    assert.ok(out.fix_hint);
  } finally {
    if (original !== undefined) process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmAdmitLesson refuses with non-'1' env values (only '1' opens the gate)", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "true";
  try {
    const stubSvc = {} as unknown as SwarmAdmitService;
    const stubMem = {} as unknown as Parameters<typeof swarmAdmitLesson>[1];
    const out = await swarmAdmitLesson(stubSvc, stubMem, { envelope: FAKE_ENVELOPE });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmAdmitLessonSchema accepts an object envelope and rejects non-objects", () => {
  const ok = swarmAdmitLessonSchema.safeParse({ envelope: { id: "x" } });
  assert.equal(ok.success, true);
  // Non-object envelope is rejected by Zod.
  const bad1 = swarmAdmitLessonSchema.safeParse({ envelope: "not-an-object" });
  assert.equal(bad1.success, false);
  const bad2 = swarmAdmitLessonSchema.safeParse({ envelope: 42 });
  assert.equal(bad2.success, false);
});

// Tool happy-path + memory side-effect — uses a fake service that returns a
// canned outcome so we can pin the memory metadata shape without spinning
// up Supabase.
test("swarmAdmitLesson writes a decisions/swarm memory on a 201 admit", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const fakeSvc = {
      defaultDeps: () => ({}) as SwarmAdmitDeps,
      admit: async () =>
        ({
          decision: "admitted",
          lesson_id: "11111111-2222-4333-8444-555555555555",
          lesson_tier: "B",
          contradicts_with: [],
          trust_delta: 0.05,
          origin_node_id: "QmPeerXYZ",
          http_status: 201,
        }) as SwarmAdmitOutcome,
    } as unknown as SwarmAdmitService;
    const created: Array<Record<string, unknown>> = [];
    const fakeMem = {
      create: async (row: Record<string, unknown>) => {
        created.push(row);
      },
    } as unknown as Parameters<typeof swarmAdmitLesson>[1];

    const out = await swarmAdmitLesson(fakeSvc, fakeMem, {
      envelope: FAKE_ENVELOPE,
    });
    assert.equal(out.ok, true);
    assert.equal(out.decision, "admitted");
    assert.equal(out.lesson_id, "11111111-2222-4333-8444-555555555555");
    assert.equal(out.memory_recorded, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].category, "decisions");
    assert.deepEqual(
      (created[0].tags as string[]).slice(0, 2),
      ["swarm", "lesson-admitted"],
    );
    const meta = created[0].metadata as Record<string, unknown>;
    assert.equal(meta.lesson_id, "11111111-2222-4333-8444-555555555555");
    assert.equal(meta.origin_node_id, "QmPeerXYZ");
    assert.equal(meta.source, "swarm_admit_lesson");
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmAdmitLesson reports memory failure as memory_error but still ok=true", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const fakeSvc = {
      defaultDeps: () => ({}) as SwarmAdmitDeps,
      admit: async () =>
        ({
          decision: "admitted",
          lesson_id: "11111111-2222-4333-8444-555555555555",
          lesson_tier: "B",
          contradicts_with: [],
          trust_delta: 0.05,
          origin_node_id: "QmPeerXYZ",
          http_status: 201,
        }) as SwarmAdmitOutcome,
    } as unknown as SwarmAdmitService;
    const fakeMem = {
      create: async () => {
        throw new Error("ollama down");
      },
    } as unknown as Parameters<typeof swarmAdmitLesson>[1];

    const out = await swarmAdmitLesson(fakeSvc, fakeMem, {
      envelope: FAKE_ENVELOPE,
    });
    // Lesson admission is durable; the memory row is convenience.
    assert.equal(out.ok, true);
    assert.equal(out.memory_recorded, false);
    assert.match(out.memory_error ?? "", /ollama down/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmAdmitLesson surfaces a fix_hint specific to each non-201 decision", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const cases: Array<{ outcome: SwarmAdmitOutcome; hintMatch: RegExp }> = [
      {
        outcome: {
          decision: "self_loop",
          http_status: 400,
          quarantined: false,
          error: "self-published",
        },
        hintMatch: /producer path/i,
      },
      {
        outcome: {
          decision: "unknown_peer",
          http_status: 401,
          quarantined: false,
          error: "unknown peer",
        },
        hintMatch: /pubkey_b64url/i,
      },
      {
        outcome: {
          decision: "quarantined",
          http_status: 403,
          quarantined: false,
          error: "origin is currently quarantined",
        },
        hintMatch: /quarantine window/i,
      },
      {
        outcome: {
          decision: "rejected",
          http_status: 401,
          rule: 5,
          quarantined: true,
          error: "wire validation rejected record",
        },
        hintMatch: /single-strike/i,
      },
      {
        outcome: {
          decision: "internal_error",
          http_status: 503,
          quarantined: false,
          error: "insertSwarmLesson failed",
        },
        hintMatch: /dashboard logs/i,
      },
    ];

    for (const c of cases) {
      const fakeSvc = {
        defaultDeps: () => ({}) as SwarmAdmitDeps,
        admit: async () => c.outcome,
      } as unknown as SwarmAdmitService;
      const fakeMem = {
        create: async () => {
          throw new Error("memory shouldn't be touched on non-201");
        },
      } as unknown as Parameters<typeof swarmAdmitLesson>[1];
      const out = await swarmAdmitLesson(fakeSvc, fakeMem, {
        envelope: FAKE_ENVELOPE,
      });
      assert.equal(out.ok, false);
      assert.equal(out.decision, c.outcome.decision);
      assert.match(out.fix_hint ?? "", c.hintMatch);
    }
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmAdmitLesson translates a service-layer throw into ok=false + fix_hint", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const fakeSvc = {
      defaultDeps: () => {
        throw new Error("supabase unreachable");
      },
      admit: async () => {
        throw new Error("never reached");
      },
    } as unknown as SwarmAdmitService;
    const fakeMem = {
      create: async () => {},
    } as unknown as Parameters<typeof swarmAdmitLesson>[1];
    const out = await swarmAdmitLesson(fakeSvc, fakeMem, {
      envelope: FAKE_ENVELOPE,
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /supabase unreachable/);
    assert.match(out.fix_hint ?? "", /init-node-identity/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});
