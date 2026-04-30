/**
 * Integration tests for GET /swarm/lessons/{id}/proof
 * (Swarm sub-phase 4e, issue #105).
 *
 * Boots a real `node:http` server, registers the handler, and curls it via
 * global `fetch`. Going end-to-end (rather than unit-testing
 * `buildLessonProofResponse` in isolation) verifies the §4.6 contract a
 * real receiver would observe: status code, headers, envelope shape,
 * privacy invariant, and signature verification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";

import {
  buildLessonProofResponse,
  type LessonProofMeta,
} from "../swarm/endpoints/lesson-proof.js";
import { computeNodeId } from "../services/node-identity.js";
import { signWithSelfKey, verify } from "../services/signature.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";
import {
  buildEvidenceRoot,
  verifyInclusionProof,
} from "../services/evidence-merkle.js";

// ---------------------------------------------------------------------------
// Identity + lesson fixture
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

/**
 * Build a producer-side fixture: raw experience IDs + canonical leaves +
 * the lesson row metadata the loader would surface. Uses real
 * `buildEvidenceRoot` so the leaves match what a producer at sign time
 * would have committed.
 */
function buildLessonFixture(opts: { leafCount: number; lessonId?: string }) {
  const lessonId = opts.lessonId ?? "11111111-2222-4333-8444-555555555555";
  const rawIds = Array.from(
    { length: opts.leafCount },
    (_, i) => `exp-${i}-abcdefghij`
  );
  const { root, leaves } = buildEvidenceRoot(rawIds);
  return { lessonId, rawIds, root, leaves };
}

/**
 * Boot a one-route HTTP server on an ephemeral port, return the base URL
 * and a teardown fn. The route extracts the lesson id from the URL and
 * forwards to `buildLessonProofResponse`.
 */
async function bootServer(
  resolveLessonId: (req: http.IncomingMessage) => string | null,
  buildResponse: (lessonId: string) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const lessonId = resolveLessonId(req);
    if (lessonId === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    void buildResponse(lessonId)
      .then((result) => {
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server bind failed");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  return { url, close };
}

const PROOF_PATH_RE = /^\/swarm\/lessons\/([^/]+)\/proof$/;

function extractLessonId(req: http.IncomingMessage): string | null {
  if (!req.url) return null;
  const m = req.url.match(PROOF_PATH_RE);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Happy path — full §4.6 round trip
// ---------------------------------------------------------------------------

test("GET /swarm/lessons/{id}/proof returns a valid signed envelope (1-leaf)", async () => {
  const self = freshIdentity();
  const { lessonId, root, leaves } = buildLessonFixture({ leafCount: 1 });

  const { url, close } = await bootServer(
    extractLessonId,
    async (id) =>
      buildLessonProofResponse({
        lessonId: id,
        loadSelf: async () => ({
          node_id: self.nodeId,
          pubkey_b64: self.pubkeyB64,
        }),
        loadLesson: async (): Promise<LessonProofMeta | null> => ({
          origin_node_id: self.nodeId,
          signed_at: "2026-04-28T11:00:00.000Z",
          spec_version: WIRE_SPEC_VERSION,
        }),
        loadLeaves: async () => leaves,
        wasPublishedByThisNode: async () => true,
        signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
      })
  );

  try {
    const response = await fetch(`${url}/swarm/lessons/${lessonId}/proof`);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8"
    );
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as Record<string, unknown>;
    for (const field of [
      "lesson_id",
      "evidence_count",
      "evidence_root",
      "inclusion_proofs",
      "spec_version",
      "signed_at",
      "signature",
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(body, field),
        `missing required envelope field "${field}"`
      );
    }
    assert.equal(body.lesson_id, lessonId);
    assert.equal(body.evidence_count, 1);
    assert.equal(body.evidence_root, root);
    assert.equal(body.spec_version, WIRE_SPEC_VERSION);

    // Signature verifies against the producing node's pubkey — same key
    // the receiver already had to know to verify the lesson signature.
    const sigOk = verify(
      body,
      body.signature as string,
      self.pubkeyRaw
    );
    assert.equal(sigOk, true, "envelope signature did not verify");

    // The single proof reconstructs the root.
    const proofs = body.inclusion_proofs as Array<{
      hashed_experience_id: string;
      merkle_path: string[];
    }>;
    assert.equal(proofs.length, 1);
    assert.equal(
      verifyInclusionProof(
        body.evidence_root as string,
        proofs[0].hashed_experience_id,
        proofs[0].merkle_path
      ),
      true
    );
  } finally {
    await close();
  }
});

test("GET /swarm/lessons/{id}/proof returns valid proofs for 2-, 5-, and 7-leaf lessons", async () => {
  const self = freshIdentity();
  // Round-trip multiple sizes to exercise the odd-leaf duplication path
  // (5, 7) and the trivial pair path (2). Each has its own lesson_id so
  // they can be served by the same handler with no extra branching.
  for (const leafCount of [2, 5, 7]) {
    const { lessonId, root, leaves } = buildLessonFixture({
      leafCount,
      lessonId: `aaaaaaaa-${leafCount.toString().padStart(4, "0")}-4111-8aaa-bbbbbbbbbbbb`,
    });
    const { url, close } = await bootServer(
      extractLessonId,
      async (id) =>
        buildLessonProofResponse({
          lessonId: id,
          loadSelf: async () => ({
            node_id: self.nodeId,
            pubkey_b64: self.pubkeyB64,
          }),
          loadLesson: async () => ({
            origin_node_id: self.nodeId,
            signed_at: "2026-04-28T11:00:00.000Z",
            spec_version: WIRE_SPEC_VERSION,
          }),
          loadLeaves: async () => leaves,
          wasPublishedByThisNode: async () => true,
          signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
        })
    );
    try {
      const res = await fetch(`${url}/swarm/lessons/${lessonId}/proof`);
      assert.equal(res.status, 200, `leafCount=${leafCount} should be 200`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.evidence_count, leafCount);
      assert.equal(body.evidence_root, root);
      const proofs = body.inclusion_proofs as Array<{
        hashed_experience_id: string;
        merkle_path: string[];
      }>;
      assert.equal(proofs.length, leafCount);
      for (let i = 0; i < proofs.length; i++) {
        assert.equal(
          verifyInclusionProof(
            body.evidence_root as string,
            proofs[i].hashed_experience_id,
            proofs[i].merkle_path
          ),
          true,
          `leafCount=${leafCount} proof[${i}] failed to reconstruct root`
        );
      }
    } finally {
      await close();
    }
  }
});

// ---------------------------------------------------------------------------
// Privacy invariant — Designprinzip 2
//
// Only `hashed_experience_id`s leave the node. The contract test scans
// the response body for any UUID-shaped string AND any of the raw
// experience IDs the fixture used to build the tree. Both are forbidden.
// ---------------------------------------------------------------------------

test("response body contains no raw experience IDs and no UUIDs other than lesson_id", async () => {
  const self = freshIdentity();
  // Use UUID-shaped raw IDs so the privacy guard cannot pass by accident
  // (the default `exp-N-...` IDs would never trip the UUID regex).
  const fixedRawIds = [
    "exp00001-aaaa-4111-8aaa-cccccccccccc",
    "exp00002-bbbb-4222-8bbb-cccccccccccc",
    "exp00003-cccc-4333-8ccc-cccccccccccc",
  ];
  const { root, leaves } = buildEvidenceRoot(fixedRawIds);
  const lessonId = "11111111-2222-4333-8444-555555555555";

  const { url, close } = await bootServer(
    extractLessonId,
    async (id) =>
      buildLessonProofResponse({
        lessonId: id,
        loadSelf: async () => ({
          node_id: self.nodeId,
          pubkey_b64: self.pubkeyB64,
        }),
        loadLesson: async () => ({
          origin_node_id: self.nodeId,
          signed_at: "2026-04-28T11:00:00.000Z",
          spec_version: WIRE_SPEC_VERSION,
        }),
        loadLeaves: async () => leaves,
        wasPublishedByThisNode: async () => true,
        signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
      })
  );

  try {
    const res = await fetch(`${url}/swarm/lessons/${lessonId}/proof`);
    assert.equal(res.status, 200);
    const text = await res.text();

    // Defensive: NO raw ID from the input set should appear anywhere in
    // the body. If one does, the producer-side substrate or the endpoint
    // is leaking pre-hash material.
    for (const raw of fixedRawIds) {
      assert.equal(
        text.includes(raw),
        false,
        `response body leaks raw experience id "${raw}" (Designprinzip 2 violation)`
      );
    }

    // Defensive: any UUID-shaped substring in the body MUST be the
    // lesson_id (the only legitimate UUID-shape value §4.6 allows).
    const UUID_RE =
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const found = text.match(UUID_RE) ?? [];
    for (const u of found) {
      assert.equal(
        u.toLowerCase(),
        lessonId.toLowerCase(),
        `response body contains unexpected UUID "${u}" (only lesson_id is allowed)`
      );
    }

    // Just in case the regex misses a v9+ shape — also assert all the
    // hashed_experience_ids are 46-char Qm... multihashes, not UUIDs.
    const body = JSON.parse(text) as Record<string, unknown>;
    void root;
    const proofs = body.inclusion_proofs as Array<{
      hashed_experience_id: string;
    }>;
    for (const p of proofs) {
      assert.match(
        p.hashed_experience_id,
        /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/,
        "hashed_experience_id must be a base58btc sha2-256 multihash"
      );
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 404 / 410 disambiguation
// ---------------------------------------------------------------------------

test("returns 404 when lesson is not held and never published by this node", async () => {
  const self = freshIdentity();
  const lessonId = "deadbeef-1111-4222-8333-444444444444";
  const result = await buildLessonProofResponse({
    lessonId,
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    loadLesson: async () => null,
    loadLeaves: async () => [],
    wasPublishedByThisNode: async () => false,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 404);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /not held by this node/);
});

test("returns 410 when lesson was published by this node but is no longer held", async () => {
  const self = freshIdentity();
  const lessonId = "deadbeef-2222-4333-8444-555555555555";
  const result = await buildLessonProofResponse({
    lessonId,
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    loadLesson: async () => null,
    loadLeaves: async () => [],
    wasPublishedByThisNode: async () => true,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 410);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /no longer held/);
});

test("returns 404 (not 200) when this node holds a swarm-relayed lesson from another origin", async () => {
  // Relay guard: a node holding a peer's lesson MUST NOT sign a proof
  // envelope on the producer's behalf. §4.6 explicitly forbids this.
  const self = freshIdentity();
  const otherProducer = freshIdentity();
  const { lessonId, leaves } = buildLessonFixture({ leafCount: 3 });
  const result = await buildLessonProofResponse({
    lessonId,
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    // Lesson is held, but origin is someone else.
    loadLesson: async () => ({
      origin_node_id: otherProducer.nodeId,
      signed_at: "2026-04-28T11:00:00.000Z",
      spec_version: WIRE_SPEC_VERSION,
    }),
    // Even if leaves are available locally, the relay guard fires before
    // they're consulted.
    loadLeaves: async () => leaves,
    wasPublishedByThisNode: async () => false,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 404);
  const body = JSON.parse(result.body) as { error?: string; origin_node_id?: string };
  assert.match(body.error ?? "", /relay/);
  assert.equal(body.origin_node_id, otherProducer.nodeId);
});

// ---------------------------------------------------------------------------
// 503 cases — operator-readable preconditions
// ---------------------------------------------------------------------------

test("returns 503 when the node has no self-identity row", async () => {
  const result = await buildLessonProofResponse({
    lessonId: "11111111-2222-4333-8444-555555555555",
    loadSelf: async () => null,
    loadLesson: async () => null,
    loadLeaves: async () => [],
    wasPublishedByThisNode: async () => false,
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /not initialized/);
});

test("returns 503 when this node is the origin but no producer-side leaves were recorded", async () => {
  // Substrate inconsistency: lesson row exists with our origin, but the
  // §4.6 substrate has no rows. Returning a 0-leaf proof would violate
  // rule 16 on the receiver, so we surface the inconsistency loudly.
  const self = freshIdentity();
  const lessonId = "33333333-4444-4555-8666-777777777777";
  const result = await buildLessonProofResponse({
    lessonId,
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    loadLesson: async () => ({
      origin_node_id: self.nodeId,
      signed_at: "2026-04-28T11:00:00.000Z",
      spec_version: WIRE_SPEC_VERSION,
    }),
    loadLeaves: async () => [],
    wasPublishedByThisNode: async () => true,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /no producer-side evidence rows/);
});

test("returns 400 when lesson_id is not a UUID", async () => {
  const self = freshIdentity();
  const result = await buildLessonProofResponse({
    lessonId: "not-a-uuid",
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    loadLesson: async () => null,
    loadLeaves: async () => [],
    wasPublishedByThisNode: async () => false,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 400);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /UUID/);
});

test("returns 503 when a producer-side leaf is malformed (not a multihash)", async () => {
  const self = freshIdentity();
  const lessonId = "44444444-5555-4666-8777-888888888888";
  const result = await buildLessonProofResponse({
    lessonId,
    loadSelf: async () => ({
      node_id: self.nodeId,
      pubkey_b64: self.pubkeyB64,
    }),
    loadLesson: async () => ({
      origin_node_id: self.nodeId,
      signed_at: "2026-04-28T11:00:00.000Z",
      spec_version: WIRE_SPEC_VERSION,
    }),
    // Substrate handed us a non-multihash leaf — reject loudly rather
    // than emit an envelope a receiver would drop under rule 18.
    loadLeaves: async () => ["not-a-multihash"],
    wasPublishedByThisNode: async () => true,
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /not a sha2-256 multihash/);
});
