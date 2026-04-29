import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WIRE_SPEC_VERSION,
  canonicalizeForSigning,
  kindOf,
  type Lesson,
  type HubAnchor,
  type NodeAdvertisement,
  type TrustEdge,
} from "../services/wire-types.js";
import { canonicalize } from "../services/signature.js";

// ---------------------------------------------------------------------------
// Example records — one per kind. Each is `satisfies` the corresponding
// interface, which is the compile-time half of the acceptance criterion:
// if the spec field tables drift from these interfaces, this file stops
// compiling.
//
// Numeric values are intentionally pedestrian; the validator (Phase 3b)
// owns "is the embedding really 768 elements" and "is signed_at within
// the staleness window". This file only proves type-shape and the
// canonicalize/kindOf helpers.
// ---------------------------------------------------------------------------

const exampleLesson = {
  id: "11111111-2222-3333-4444-555555555555",
  content: "Mock lessons can pass tests that real migrations break.",
  embedding: [0.1, 0.2, 0.3],
  synthesized_from_cluster_size: 4,
  origin_node_id: "QmExampleNodeId",
  signed_at: "2026-04-28T05:00:00.000Z",
  signature: "AAAA",
  created_at: "2026-04-27T20:00:00.000Z",
  tags: ["testing", "mocks"],
  spec_version: WIRE_SPEC_VERSION,
} satisfies Lesson;

const exampleHubAnchor = {
  embedding: [0.0, 0.5, 1.0],
  hub_score: 0.82,
  local_memory_count: 17,
  topic_label: "test-mocks",
  origin_node_id: "QmExampleNodeId",
  signed_at: "2026-04-28T05:00:00.000Z",
  signature: "AAAA",
  spec_version: WIRE_SPEC_VERSION,
} satisfies HubAnchor;

const exampleNodeAdvertisement = {
  node_id: "QmExampleNodeId",
  pubkey: "abc123-base64url-pubkey",
  display_name: "test-node",
  endpoint_url: "https://node.example.com",
  spec_version: WIRE_SPEC_VERSION,
  signed_at: "2026-04-28T05:00:00.000Z",
  signature: "AAAA",
} satisfies NodeAdvertisement;

const exampleTrustEdge = {
  truster_node_id: "QmTruster",
  trustee_node_id: "QmTrustee",
  weight: 0.7,
  reason: "passed three lesson-verification rounds without rejects",
  updated_at: "2026-04-28T05:00:00.000Z",
} satisfies TrustEdge;

// ---------------------------------------------------------------------------
// WIRE_SPEC_VERSION
// ---------------------------------------------------------------------------

test("WIRE_SPEC_VERSION is the spec-defined string '1.1' (SWARM_SPEC §1, §3.7)", () => {
  // Pinned literal: a typo or accidental bump here would mis-stamp every
  // record produced by the node, and v1 negotiation is strict-equal on
  // the major component. Catch the mistake at the unit-test boundary.
  // v1.1 (sub-phase 4a, PR #101) added the Proof-of-Knowledge fields on
  // Lesson; the major component remains "1" so v1.0 nodes stay
  // negotiation-compatible per SWARM_SPEC §1.
  assert.equal(WIRE_SPEC_VERSION, "1.1");
});

// ---------------------------------------------------------------------------
// canonicalizeForSigning — determinism, signature stripping, encoding
// ---------------------------------------------------------------------------

test("canonicalizeForSigning: deterministic across repeated calls", () => {
  // The bytes-under-signature MUST be byte-stable per call; otherwise two
  // honest verifications of the same record could disagree.
  const a = canonicalizeForSigning(exampleLesson);
  const b = canonicalizeForSigning(exampleLesson);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("canonicalizeForSigning: strips top-level signature field", () => {
  // SWARM_SPEC §2.2 step 1: signature is removed before canonicalization.
  // A record-with-signature and the same-record-without-signature MUST
  // produce identical bytes — anything else and the verify path breaks.
  const withSig = {
    ...exampleHubAnchor,
    signature: "this-should-be-stripped-not-signed-over",
  };
  const withoutSig = (() => {
    const { signature: _omit, ...rest } = exampleHubAnchor;
    return rest;
  })();
  const withSigBytes = canonicalizeForSigning(withSig);
  const withoutSigBytes = canonicalizeForSigning(withoutSig);
  assert.deepEqual(Array.from(withSigBytes), Array.from(withoutSigBytes));
});

test("canonicalizeForSigning: composes the same JCS as services/signature.ts", () => {
  // Independent reference: build the canonical string via the same
  // `canonicalize` that `sign`/`verify` use, encode, compare. If this
  // ever fails the wire-format service has drifted from the primitives
  // it composes — exactly the regression Lesson #X warns against.
  const sample = { z: 3, a: 1, m: 2 };
  const expected = Buffer.from(canonicalize(sample), "utf8");
  const actual = canonicalizeForSigning(sample);
  assert.deepEqual(Array.from(actual), Array.from(expected));
  // Sanity: the canonical form sorts keys (RFC 8785 §3.2.3).
  assert.equal(Buffer.from(actual).toString("utf8"), '{"a":1,"m":2,"z":3}');
});

test("canonicalizeForSigning: returns Uint8Array, not string", () => {
  // The return type is the signature input, not pretty-printable text.
  // Asserting the runtime shape catches a silent change to `string`.
  const out = canonicalizeForSigning({ a: 1 });
  assert.ok(out instanceof Uint8Array);
});

test("canonicalizeForSigning: rejects non-object inputs", () => {
  // The spec only signs JSON objects; arrays, primitives, and null are
  // not signable wire records. Refuse loudly rather than silently
  // canonicalize them and let the verify path "succeed" on garbage.
  assert.throws(() => canonicalizeForSigning(null as never));
  assert.throws(() => canonicalizeForSigning([1, 2, 3] as never));
  assert.throws(() => canonicalizeForSigning("nope" as never));
});

// ---------------------------------------------------------------------------
// kindOf — discriminator over the four wire kinds
// ---------------------------------------------------------------------------

test("kindOf: correctly classifies each example wire record", () => {
  assert.equal(kindOf(exampleLesson), "lesson");
  assert.equal(kindOf(exampleHubAnchor), "hub_anchor");
  assert.equal(kindOf(exampleNodeAdvertisement), "node_advertisement");
  assert.equal(kindOf(exampleTrustEdge), "trust_edge");
});

test("kindOf: returns null on garbage and on partial records", () => {
  // Defensive: a record missing a required field is not a valid wire
  // type, so refuse to classify it. The validator (Phase 3b) will then
  // refuse to ingest it for separate, more specific reasons.
  assert.equal(kindOf(null), null);
  assert.equal(kindOf(undefined), null);
  assert.equal(kindOf(42), null);
  assert.equal(kindOf("hello"), null);
  assert.equal(kindOf([]), null);
  assert.equal(kindOf({}), null);
  assert.equal(kindOf({ random: "object" }), null);
  // Lesson missing synthesized_from_cluster_size — the field that makes
  // it a Lesson rather than "any signed thing with content".
  const partialLesson = { ...exampleLesson } as Record<string, unknown>;
  delete partialLesson.synthesized_from_cluster_size;
  assert.equal(kindOf(partialLesson), null);
});

// ---------------------------------------------------------------------------
// v1.1 Proof-of-Knowledge field shape — SWARM_SPEC §3.1, §3.7
//
// These tests pin the type-shape contract for the five new optional fields.
// They do NOT assert validation rules (those are rules 16–20 in §5, owned
// by the validator); they only prove that:
//   (a) a v1.0 Lesson without the new fields still satisfies the interface,
//   (b) a v1.1 Lesson with all five fields populated also satisfies it,
//   (c) the discriminator (kindOf) classifies both shapes as "lesson".
// ---------------------------------------------------------------------------

test("Lesson interface still accepts a v1.0-shaped record (no PoK fields)", () => {
  // A literal v1.0 Lesson — spec_version "1.0", no evidence_* fields.
  // SWARM_SPEC §1 says minor bumps are additive, so v1.1 nodes ingest
  // v1.0 records (with evidence_unverifiable=true marking, per §3.1
  // compatibility note). At the type-level that means the five v1.1
  // fields MUST be optional — if they were required, this `satisfies
  // Lesson` annotation would stop compiling.
  const v10Lesson = {
    id: "11111111-2222-3333-4444-555555555555",
    content: "Pre-PoK lesson, valid under v1.0.",
    embedding: [0.1, 0.2, 0.3],
    synthesized_from_cluster_size: 3,
    origin_node_id: "QmV10Node",
    signed_at: "2026-04-22T00:00:00.000Z",
    signature: "AAAA",
    created_at: "2026-04-20T00:00:00.000Z",
    spec_version: "1.0",
  } satisfies Lesson;

  assert.equal(v10Lesson.spec_version, "1.0");
  assert.ok(!("evidence_root" in v10Lesson));
  assert.ok(!("evidence_count" in v10Lesson));
  assert.ok(!("prev_lesson_hash" in v10Lesson));
  assert.ok(!("maturity_age_days" in v10Lesson));
  assert.ok(!("useful_count" in v10Lesson));
  assert.equal(kindOf(v10Lesson), "lesson");
});

test("Lesson interface accepts a v1.1-shaped record (all PoK fields populated)", () => {
  // Pin the type shape for every PoK field declared in SWARM_SPEC §3.1
  // (v1.1+). The `satisfies Lesson` annotation is the compile-time half;
  // the runtime presence checks are the regression guard.
  const examplePokLesson = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    content: "Lessons in v1.1 carry provenance commitments, not just signatures.",
    embedding: [0.1, 0.2, 0.3],
    synthesized_from_cluster_size: 5,
    origin_node_id: "QmExampleNodeId",
    signed_at: "2026-04-30T01:00:00.000Z",
    signature: "AAAA",
    created_at: "2026-04-23T00:00:00.000Z",
    tags: ["pok", "swarm-v1.1"],
    spec_version: WIRE_SPEC_VERSION,
    evidence_root: "QmEvidenceRootMultihash",
    evidence_count: 5,
    prev_lesson_hash: "QmPreviousLessonHash",
    maturity_age_days: 7,
    useful_count: 3,
  } satisfies Lesson;

  assert.equal(examplePokLesson.evidence_count, 5);
  assert.equal(examplePokLesson.maturity_age_days, 7);
  assert.equal(examplePokLesson.prev_lesson_hash, "QmPreviousLessonHash");
  assert.equal(kindOf(examplePokLesson), "lesson");
});

test("Lesson interface accepts prev_lesson_hash=null (first-published lesson)", () => {
  // SWARM_SPEC §3.1 v1.1 row: "prev_lesson_hash null only for the very
  // first lesson a node ever publishes." Pin the null variant so the
  // type stays `string | null`, not just `string`.
  const firstEverLesson = {
    id: "ffffffff-1111-2222-3333-444444444444",
    content: "First lesson this node ever publishes.",
    embedding: [0.5, 0.5, 0.5],
    synthesized_from_cluster_size: 2,
    origin_node_id: "QmFreshNode",
    signed_at: "2026-04-30T01:00:00.000Z",
    signature: "AAAA",
    created_at: "2026-04-29T00:00:00.000Z",
    spec_version: WIRE_SPEC_VERSION,
    evidence_root: "QmEvidenceRootMultihash",
    evidence_count: 2,
    prev_lesson_hash: null,
    maturity_age_days: 1,
    useful_count: 0,
  } satisfies Lesson;

  assert.equal(firstEverLesson.prev_lesson_hash, null);
});

test("kindOf: does not confuse Lesson with HubAnchor (both carry embedding)", () => {
  // Both kinds have an `embedding` and an `origin_node_id`; the
  // discriminator MUST use the kind-distinct fields (`content` vs.
  // `hub_score`), not just embedding presence. Regression-proof it.
  const lessonShaped = {
    id: "abc",
    content: "x",
    embedding: [0],
    synthesized_from_cluster_size: 2,
    origin_node_id: "n",
  };
  const hubShaped = {
    embedding: [0],
    hub_score: 0.5,
    local_memory_count: 1,
    origin_node_id: "n",
  };
  assert.equal(kindOf(lessonShaped), "lesson");
  assert.equal(kindOf(hubShaped), "hub_anchor");
});
