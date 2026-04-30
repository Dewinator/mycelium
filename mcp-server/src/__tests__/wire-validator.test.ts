import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  validateWireRecord,
  validateLessonProof,
  type ValidationResult,
} from "../services/wire-validator.js";
import { sign } from "../services/signature.js";
import { computeNodeId } from "../services/node-identity.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";
import {
  buildEvidenceRoot,
  buildInclusionProofFromHashedLeaves,
  type InclusionProof,
} from "../services/evidence-merkle.js";

// ---------------------------------------------------------------------------
// Test fixtures
//
// Every negative test starts from a fully-valid record and breaks ONE
// invariant. That keeps the assertion surface clean: if a test fails on
// rule N but really tripped over rule M, the helper would mask it; we
// build up the valid baseline once and mutate from there.
// ---------------------------------------------------------------------------

interface Identity {
  pem: string;
  pubkeyRaw: Uint8Array;
  nodeId: string;
}

function freshIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Last 32 bytes of the SPKI DER encoding are the raw Ed25519 pubkey.
  const pubkeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const nodeId = computeNodeId(Buffer.from(pubkeyRaw));
  return { pem, pubkeyRaw, nodeId };
}

function full768Embedding(seed = 0): number[] {
  const out = new Array(768);
  for (let i = 0; i < 768; i++) out[i] = (seed + i) / 1000;
  return out;
}

// Anchor "now" so rule 7/8 windows are deterministic.
const FIXED_NOW = new Date("2026-04-28T12:00:00.000Z");

function makePubkeyResolver(known: Map<string, Uint8Array>) {
  return (nodeId: string): Uint8Array | null => known.get(nodeId) ?? null;
}

function attachSignature(
  record: Record<string, unknown>,
  pem: string
): Record<string, unknown> {
  return { ...record, signature: sign(record, pem) };
}

// ---------------------------------------------------------------------------
// Valid examples — one per kind
// ---------------------------------------------------------------------------

function buildValidLesson(producer: Identity): Record<string, unknown> {
  // WIRE_SPEC_VERSION is "1.1", so the fixture MUST carry the five PoK
  // fields specified in SWARM_SPEC §3.1 — otherwise rule 2 (presence)
  // would reject. The values are minimal but spec-shaped: a 32-byte-ish
  // multihash placeholder, evidence_count >= 1, prev_lesson_hash=null
  // (this lesson stands as if it were the producer's very first).
  const unsigned = {
    id: "11111111-2222-3333-4444-555555555555",
    content: "Lessons must be generalized before they leave a node.",
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
  };
  return attachSignature(unsigned, producer.pem);
}

/**
 * Backward-compat fixture: a v1.0 record served by an older producer to a
 * v1.1 receiver. Per SWARM_SPEC §1, minor bumps are additive — a v1.1
 * receiver MUST keep accepting v1.0 records (without PoK fields).
 */
function buildValidV10Lesson(producer: Identity): Record<string, unknown> {
  const unsigned = {
    id: "11111111-2222-3333-4444-666666666666",
    content: "Old-style lesson without PoK fields.",
    embedding: full768Embedding(2),
    synthesized_from_cluster_size: 3,
    origin_node_id: producer.nodeId,
    signed_at: "2026-04-28T11:00:00.000Z",
    created_at: "2026-04-27T10:00:00.000Z",
    spec_version: "1.0",
  };
  return attachSignature(unsigned, producer.pem);
}

function buildValidHubAnchor(producer: Identity): Record<string, unknown> {
  const unsigned = {
    embedding: full768Embedding(7),
    hub_score: 0.82,
    local_memory_count: 17,
    topic_label: "test-cluster",
    origin_node_id: producer.nodeId,
    signed_at: "2026-04-28T11:00:00.000Z",
    spec_version: WIRE_SPEC_VERSION,
  };
  return attachSignature(unsigned, producer.pem);
}

function buildValidAdvertisement(self: Identity): Record<string, unknown> {
  // Pubkey on the wire is unpadded base64url per SWARM_SPEC §3.3.
  const pubkeyB64Url = Buffer.from(self.pubkeyRaw).toString("base64url");
  const unsigned = {
    node_id: self.nodeId,
    pubkey: pubkeyB64Url,
    display_name: "test-node",
    endpoint_url: "https://node.example.com",
    spec_version: WIRE_SPEC_VERSION,
    signed_at: "2026-04-28T11:00:00.000Z",
  };
  return attachSignature(unsigned, self.pem);
}

function expectErr(result: ValidationResult, rule: number): void {
  assert.equal(result.ok, false, `expected rejection on rule ${rule}, got ok=true`);
  if (result.ok) return; // narrowing
  assert.equal(
    result.rule,
    rule,
    `expected rule ${rule}, got rule ${result.rule} (reason: ${result.reason})`
  );
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("valid Lesson is accepted", async () => {
  const producer = freshIdentity();
  const record = buildValidLesson(producer);
  const result = await validateWireRecord(record, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  assert.equal(result.ok, true);
});

test("valid HubAnchor is accepted", async () => {
  const producer = freshIdentity();
  const record = buildValidHubAnchor(producer);
  const result = await validateWireRecord(record, "hub_anchor", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  assert.equal(result.ok, true);
});

test("valid NodeAdvertisement is accepted (self-signed)", async () => {
  const self = freshIdentity();
  const record = buildValidAdvertisement(self);
  const result = await validateWireRecord(record, "node_advertisement", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    // Self-signed: getPubkeyForNode is not consulted; resolver returns null.
    getPubkeyForNode: () => null,
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Negative cases — one per rule (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13)
// ---------------------------------------------------------------------------

test("rule 1: spec_version major mismatch is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  // Re-sign with the wrong spec_version so rule 5 wouldn't also fire.
  const { signature: _omit, ...unsigned } = valid;
  const tampered = attachSignature(
    { ...unsigned, spec_version: "2.0" },
    producer.pem
  );
  const result = await validateWireRecord(tampered, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 1);
});

test("rule 2: missing required field is rejected", async () => {
  const producer = freshIdentity();
  const record = buildValidLesson(producer) as Record<string, unknown>;
  delete record.content;
  const result = await validateWireRecord(record, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 2);
});

test("rule 3: type mismatch on a typed field is rejected", async () => {
  const producer = freshIdentity();
  const record = buildValidLesson(producer);
  // synthesized_from_cluster_size is typed as number; flip to string.
  const broken = { ...record, synthesized_from_cluster_size: "four" };
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 3);
});

test("rule 4: embedding wrong length is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, embedding: [0.1, 0.2, 0.3] },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 4);
});

test("rule 4: embedding containing non-finite is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, embedding: _e, ...rest } = valid;
  const emb = full768Embedding();
  emb[42] = Number.NaN;
  // We cannot re-sign a record with NaN inside (canonicalize refuses);
  // attach a placeholder signature that the validator will never reach.
  const broken = { ...rest, embedding: emb, signature: "AAAA" };
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 4);
});

test("rule 5: bad signature is rejected (content mutated post-sign)", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  // Mutate content AFTER signing so JCS-recompute produces different bytes.
  const tampered = { ...valid, content: "Mutated after signing." };
  const result = await validateWireRecord(tampered, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 5);
});

test("rule 6: NodeAdvertisement node_id != multihash(pubkey) is rejected", async () => {
  const self = freshIdentity();
  const other = freshIdentity();
  const valid = buildValidAdvertisement(self);
  const { signature: _omit, ...unsigned } = valid;
  // Substitute a foreign node_id and re-sign with self's key — rule 5 still
  // verifies (self signed it) but rule 6 must trip first.
  const broken = attachSignature(
    { ...unsigned, node_id: other.nodeId },
    self.pem
  );
  const result = await validateWireRecord(broken, "node_advertisement", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: () => null,
  });
  expectErr(result, 6);
});

test("rule 7: signed_at more than 5 minutes in the future is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  // FIXED_NOW + 1 hour — well past the 5-min skew tolerance.
  const broken = attachSignature(
    { ...unsigned, signed_at: "2026-04-28T13:00:00.000Z" },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 7);
});

test("rule 8: Lesson signed_at older than 90 days is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  // 100 days before FIXED_NOW. created_at must precede signed_at (rule 9),
  // so push it earlier too.
  const broken = attachSignature(
    {
      ...unsigned,
      signed_at: "2026-01-18T12:00:00.000Z",
      created_at: "2026-01-17T12:00:00.000Z",
    },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 8);
});

test("rule 9: Lesson signed_at < created_at is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    {
      ...unsigned,
      signed_at: "2026-04-28T10:00:00.000Z",
      created_at: "2026-04-28T11:00:00.000Z",
    },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 9);
});

test("rule 11: Lesson synthesized_from_cluster_size < 2 is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, synthesized_from_cluster_size: 1 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 11);
});

test("rule 12: Lesson.content over 8 KiB is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, content: "A".repeat(8 * 1024 + 1) },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 12);
});

test("rule 13: NodeAdvertisement endpoint_url not https is rejected", async () => {
  const self = freshIdentity();
  const valid = buildValidAdvertisement(self);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, endpoint_url: "http://node.example.com" },
    self.pem
  );
  const result = await validateWireRecord(broken, "node_advertisement", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: () => null,
  });
  expectErr(result, 13);
});

// ---------------------------------------------------------------------------
// Defensive extras (not required by the issue, cheap to keep)
// ---------------------------------------------------------------------------

test("non-object input is rejected (no exception thrown)", async () => {
  const result = await validateWireRecord("not a record" as unknown, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: () => null,
  });
  assert.equal(result.ok, false);
});

test("rule 5: unknown origin_node_id (no pubkey resolver hit) is rejected", async () => {
  const producer = freshIdentity();
  const record = buildValidLesson(producer);
  const result = await validateWireRecord(record, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    // Resolver knows nobody — a swarm without trust state for this node.
    getPubkeyForNode: () => null,
  });
  expectErr(result, 5);
});

// ---------------------------------------------------------------------------
// v1.1 PoK rules — sub-phase 4b (issue #102)
//
// Rules 16 + 20 plus the rule-2 presence checks for the five new fields.
// Rules 17/18/19 are out-of-band (they require a fetched proof or a
// receiver-side prev-lesson cache) and live in their own sub-phases.
// ---------------------------------------------------------------------------

test("backward-compat: a v1.0 Lesson is still accepted by a v1.1 receiver", async () => {
  const producer = freshIdentity();
  const record = buildValidV10Lesson(producer);
  const result = await validateWireRecord(record, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  assert.equal(result.ok, true);
});

test("rule 16: v1.1 Lesson with evidence_count = 0 is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, evidence_count: 0 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 16);
});

test("rule 16: v1.1 Lesson with non-integer evidence_count is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, evidence_count: 2.5 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 16);
});

test("rule 20: v1.1 Lesson with maturity_age_days < 0 is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, maturity_age_days: -1 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 20);
});

test("rule 20: v1.1 Lesson with useful_count < 0 is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, useful_count: -3 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 20);
});

test("rule 20: v1.0 Lesson carrying a v1.1 field (cross-version smuggling) is rejected", async () => {
  const producer = freshIdentity();
  const v10 = buildValidV10Lesson(producer);
  const { signature: _omit, ...unsigned } = v10;
  // Sneak a single PoK field into an otherwise-valid v1.0 record. Rule 20's
  // third leg fires on ANY v1.1 field, not just all five.
  const broken = attachSignature(
    { ...unsigned, evidence_root: "1220" + "cd".repeat(32) },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 20);
});

test("rule 20: v1.0 Lesson carrying useful_count alone is rejected (single-field smuggle)", async () => {
  const producer = freshIdentity();
  const v10 = buildValidV10Lesson(producer);
  const { signature: _omit, ...unsigned } = v10;
  const broken = attachSignature(
    { ...unsigned, useful_count: 7 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 20);
});

test("rule 2: v1.1 Lesson missing evidence_root is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer) as Record<string, unknown>;
  delete valid.evidence_root;
  const result = await validateWireRecord(valid, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 2);
});

test("rule 2: v1.1 Lesson missing prev_lesson_hash (not even null) is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer) as Record<string, unknown>;
  delete valid.prev_lesson_hash;
  const result = await validateWireRecord(valid, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 2);
});

test("rule 3: v1.1 Lesson with prev_lesson_hash typed as number is rejected", async () => {
  const producer = freshIdentity();
  const valid = buildValidLesson(producer);
  const { signature: _omit, ...unsigned } = valid;
  const broken = attachSignature(
    { ...unsigned, prev_lesson_hash: 42 },
    producer.pem
  );
  const result = await validateWireRecord(broken, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  expectErr(result, 3);
});

test("v1.1 Lesson with prev_lesson_hash = null (first-ever-published) is accepted", async () => {
  // Already covered implicitly by buildValidLesson, but pinned explicitly so
  // a future tightening that demands a non-null hash trips this guard.
  const producer = freshIdentity();
  const record = buildValidLesson(producer);
  const result = await validateWireRecord(record, "lesson", {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    getPubkeyForNode: makePubkeyResolver(
      new Map([[producer.nodeId, producer.pubkeyRaw]])
    ),
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// validateLessonProof — §5 rules 17 + 18 on /swarm/lessons/{id}/proof
// envelopes (sub-phase 4e, issue #105).
// ---------------------------------------------------------------------------

interface ProofFixture {
  producer: Identity;
  envelope: Record<string, unknown>;
  evidenceRoot: string;
  leaves: string[];
}

function buildValidProofEnvelope(opts: { leafCount?: number } = {}): ProofFixture {
  const producer = freshIdentity();
  // Synthesize `leafCount` raw experience IDs and build a real evidence tree
  // — so the proofs are mathematically valid against the root, not just
  // shape-correct. 4e callers want an end-to-end "produce → validate" loop.
  const n = opts.leafCount ?? 4;
  const rawIds = Array.from({ length: n }, (_, i) => `exp-${i}-abcdefghij`);
  const { root, leaves } = buildEvidenceRoot(rawIds);
  const proofs: InclusionProof[] = leaves.map((leaf) =>
    buildInclusionProofFromHashedLeaves(leaves, leaf)
  );
  const unsigned = {
    lesson_id: "11111111-2222-3333-4444-555555555555",
    evidence_count: leaves.length,
    evidence_root: root,
    inclusion_proofs: proofs,
    spec_version: WIRE_SPEC_VERSION,
    signed_at: "2026-04-28T11:30:00.000Z",
  };
  const envelope = attachSignature(unsigned, producer.pem);
  return { producer, envelope, evidenceRoot: root, leaves };
}

test("validateLessonProof: a fresh round-trip envelope is accepted", async () => {
  const { producer, envelope } = buildValidProofEnvelope();
  const result = await validateLessonProof(envelope, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  assert.equal(result.ok, true);
});

test("validateLessonProof rule 2: missing inclusion_proofs is rejected", async () => {
  const { producer, envelope } = buildValidProofEnvelope();
  const { inclusion_proofs: _omit, signature: _sig, ...rest } = envelope;
  const broken = attachSignature(rest, producer.pem);
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 2);
});

test("validateLessonProof rule 3: evidence_count typed as string is rejected", async () => {
  const { producer, envelope } = buildValidProofEnvelope();
  const { signature: _sig, ...rest } = envelope;
  const broken = attachSignature(
    { ...rest, evidence_count: "4" },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 3);
});

test("validateLessonProof rule 1: spec_version major mismatch is rejected", async () => {
  const { producer, envelope } = buildValidProofEnvelope();
  const { signature: _sig, ...rest } = envelope;
  const broken = attachSignature(
    { ...rest, spec_version: "2.0" },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 1);
});

test("validateLessonProof rule 5: wrong producer pubkey is rejected", async () => {
  const { envelope } = buildValidProofEnvelope();
  const someoneElse = freshIdentity();
  const result = await validateLessonProof(envelope, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: someoneElse.pubkeyRaw,
  });
  expectErr(result, 5);
});

test("validateLessonProof rule 7: signed_at >5 minutes in the future is rejected", async () => {
  const { producer, envelope } = buildValidProofEnvelope();
  const { signature: _sig, ...rest } = envelope;
  // FIXED_NOW + 6 minutes; envelope must re-sign over the new signed_at so
  // the rejection actually trips on rule 7 not on rule 5.
  const future = new Date(FIXED_NOW.getTime() + 6 * 60 * 1000).toISOString();
  const broken = attachSignature(
    { ...rest, signed_at: future },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 7);
});

test("validateLessonProof rule 16: evidence_count = 0 is rejected", async () => {
  const { producer } = buildValidProofEnvelope();
  // Rule 16 fires after rule 17 in the validator order, but a 0/0 envelope
  // would slip past rule 17 (0 == 0). The shape pin catches it.
  const unsigned = {
    lesson_id: "11111111-2222-3333-4444-555555555555",
    evidence_count: 0,
    evidence_root: "Qm" + "1".repeat(44),
    inclusion_proofs: [] as InclusionProof[],
    spec_version: WIRE_SPEC_VERSION,
    signed_at: "2026-04-28T11:30:00.000Z",
  };
  const envelope = attachSignature(unsigned, producer.pem);
  const result = await validateLessonProof(envelope, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 16);
});

test("validateLessonProof rule 17: inclusion_proofs.length != evidence_count is rejected", async () => {
  const { producer, envelope, evidenceRoot, leaves } = buildValidProofEnvelope({
    leafCount: 5,
  });
  const { signature: _sig, inclusion_proofs: _drop, ...rest } = envelope;
  // Drop one proof — the envelope still claims evidence_count=5 but only
  // ships 4 proofs.
  const tooFew = leaves
    .slice(0, 4)
    .map((leaf) => buildInclusionProofFromHashedLeaves(leaves, leaf));
  const broken = attachSignature(
    {
      ...rest,
      evidence_count: 5,
      evidence_root: evidenceRoot,
      inclusion_proofs: tooFew,
    },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 17);
});

test("validateLessonProof rule 18: tampered merkle_path is rejected", async () => {
  const { producer, envelope, leaves, evidenceRoot } = buildValidProofEnvelope({
    leafCount: 5,
  });
  const { signature: _sig, inclusion_proofs: validProofs, ...rest } = envelope;
  // Swap a single sibling in proof[0].merkle_path with one byte different.
  const tampered = (validProofs as InclusionProof[]).map((p, i) => {
    if (i !== 0) return p;
    const newPath = [...p.merkle_path];
    if (newPath.length === 0) return p;
    // Replace the first sibling with a fresh sha2-256 multihash that
    // definitely is NOT the real sibling.
    newPath[0] = "Qm" + "2".repeat(44);
    return { ...p, merkle_path: newPath };
  });
  void leaves;
  const broken = attachSignature(
    {
      ...rest,
      evidence_root: evidenceRoot,
      inclusion_proofs: tampered,
    },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 18);
});

test("validateLessonProof rule 18: wrong evidence_root is rejected", async () => {
  const { producer, envelope } = buildValidProofEnvelope({ leafCount: 4 });
  const { signature: _sig, ...rest } = envelope;
  // Replace evidence_root with a different (well-formed) multihash. Every
  // proof.merkle_path will fail to reconstruct it.
  const broken = attachSignature(
    {
      ...rest,
      evidence_root: "Qm" + "3".repeat(44),
    },
    producer.pem
  );
  const result = await validateLessonProof(broken, {
    ourSpecMajor: 1,
    now: FIXED_NOW,
    producerPubkey: producer.pubkeyRaw,
  });
  expectErr(result, 18);
});
