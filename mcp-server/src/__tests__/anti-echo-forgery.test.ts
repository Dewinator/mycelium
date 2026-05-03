/**
 * Anti-echo-chamber adversarial corpus — forgery category (W4.1, issue #196).
 *
 * Asserts the §3.7 Proof-of-Knowledge mechanism rejects a lesson whose
 * `evidence_root` does not hash the cited experiences. The fixture is a
 * signature-valid v1.1 envelope (so the wire validator's rule 5 passes —
 * forging a signature is a Pillar-6 problem, not a §10 problem); the
 * mismatch is exposed when the receiver fetches the §4.6 inclusion proof
 * and rule 18 fires because the proofs over the actual cited experiences
 * reconstruct a different root.
 *
 * Mechanics under test:
 *   - `validateWireRecord` on the forged envelope: returns `ok: true`.
 *     This is intentional — the wire validator is content-agnostic about
 *     evidence_root, because the leaves are not on the wire.
 *   - `validateLessonProof` on the proof envelope a producer would have
 *     to reply with under §4.6: returns `ok: false, rule: 18` because no
 *     honest inclusion-proof set over the cited experience IDs can
 *     reconstruct the forged root.
 *
 * Scope: this test exercises forgery via the proof-validation path, which
 * is the only place §3.7 PoK is enforced in unit-test conditions. The
 * full multi-node trust-edge delta is asserted in the W4.3 campaign
 * report; here we assert only the mechanism that owns the rejection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { sign, verify } from "../services/signature.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";
import { validateWireRecord, validateLessonProof } from "../services/wire-validator.js";
import {
  buildEvidenceRoot,
  buildInclusionProof,
} from "../services/evidence-merkle.js";
import type {
  AntiEchoCorpusFixture,
  AntiEchoFixtureMetadata,
} from "./fixtures/anti-echo/corpus-types.js";

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "src", "__tests__", "fixtures", "anti-echo");

interface FixtureKeyFile {
  node_id: string;
  pubkey_raw_b64: string;
  private_key_pem: string;
}

/**
 * Forgery fixtures carry an auxiliary `claimed_experience_ids` field so
 * the harness can reconstruct what the producer would *have to* prove at
 * §4.6 challenge time. Not part of the wire envelope; not present on
 * non-forgery fixtures.
 */
interface ForgeryFixture extends AntiEchoCorpusFixture {
  claimed_experience_ids: string[];
}

function loadKey(): FixtureKeyFile {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "fixture-key.json"), "utf8")
  );
}

function loadForgery(): ForgeryFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, "forgery", "evidence-root-mismatch.json"),
      "utf8"
    )
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("forgery fixture: metadata declares reject + negative trust delta", () => {
  const fixture = loadForgery();
  const meta: AntiEchoFixtureMetadata = fixture.metadata;
  assert.equal(meta.category, "forgery");
  assert.equal(meta.expected_outcome, "reject");
  // Expected trust delta is negative on rejection — the producer should
  // lose reputation for emitting an unprovable commitment.
  assert.ok(
    meta.expected_trust_delta < 0,
    `expected negative trust delta, got ${meta.expected_trust_delta}`
  );
});

test("forgery fixture: envelope signature is valid (Pillar-6 must pass before §10 fires)", () => {
  const key = loadKey();
  const fixture = loadForgery();
  const pubkey = new Uint8Array(Buffer.from(key.pubkey_raw_b64, "base64"));
  const ok = verify(fixture.envelope, fixture.envelope.signature, pubkey);
  assert.equal(
    ok,
    true,
    "envelope signature must verify — forgery tests §10, not §3.7 wire-signature"
  );
});

test("forgery fixture: passes wire-validator (content-agnostic about evidence)", async () => {
  const key = loadKey();
  const fixture = loadForgery();
  const pubkey = new Uint8Array(Buffer.from(key.pubkey_raw_b64, "base64"));
  const result = await validateWireRecord(fixture.envelope, "lesson", {
    ourSpecMajor: 1,
    now: new Date("2026-05-02T00:00:00Z"),
    getPubkeyForNode: (id) => (id === key.node_id ? pubkey : null),
  });
  assert.deepEqual(
    result,
    { ok: true },
    "wire validator must accept — it has no view of the evidence and cannot detect the forgery on its own"
  );
});

test("forgery fixture: §4.6 proof envelope fails rule 18 — inclusion proofs cannot reconstruct the forged root", async () => {
  const key = loadKey();
  const fixture = loadForgery();
  const pubkey = new Uint8Array(Buffer.from(key.pubkey_raw_b64, "base64"));

  // What an honest producer would emit when challenged for the proof:
  // the *actual* inclusion proofs over the experiences they hold. The
  // forgery is that those proofs commit to a different root than the
  // signed lesson does.
  const claimed = fixture.claimed_experience_ids;
  const real = buildEvidenceRoot(claimed);
  const inclusion_proofs = claimed.map((id) =>
    buildInclusionProof(claimed, id)
  );

  // Sanity: the real root MUST differ from the forged one. If this ever
  // collides, the fixture itself is broken (the build script also guards
  // against this, but we assert it here so a regression in either side
  // surfaces loud).
  assert.notEqual(
    real.root,
    fixture.envelope.evidence_root,
    "fixture invariant broken: real evidence root equals the forged value"
  );

  // Build the proof envelope shape the producer would sign and POST in
  // response to GET /swarm/lessons/{id}/proof. Critically, it claims the
  // forged evidence_root from the lesson — that's the §10 contradiction
  // rule 18 catches.
  const proofEnvelope: Record<string, unknown> = {
    lesson_id: fixture.envelope.id,
    evidence_count: claimed.length,
    evidence_root: fixture.envelope.evidence_root, // forged
    inclusion_proofs,
    spec_version: WIRE_SPEC_VERSION,
    signed_at: "2026-05-01T00:00:02.000Z",
  };
  const signature = sign(proofEnvelope, key.private_key_pem);
  proofEnvelope.signature = signature;

  const result = await validateLessonProof(proofEnvelope, {
    ourSpecMajor: 1,
    now: new Date("2026-05-02T00:00:00Z"),
    producerPubkey: pubkey,
  });

  assert.equal(result.ok, false, "proof envelope must be rejected");
  if (result.ok === false) {
    assert.equal(
      result.rule,
      18,
      `expected rule 18 (proof does not reconstruct evidence_root), got rule ${result.rule}: ${result.reason}`
    );
  }
});

test("forgery fixture: HONEST proof envelope (matching root) verifies — sanity that rule 18 fires only on forgery", async () => {
  const key = loadKey();
  const fixture = loadForgery();
  const pubkey = new Uint8Array(Buffer.from(key.pubkey_raw_b64, "base64"));

  // Build an honest envelope: same shape, but evidence_root matches the
  // proofs. This is what the producer would emit if the lesson had not
  // been forged. If this fails, our forgery test is meaningless (it
  // would also fail an honest path), so this guard is load-bearing.
  const claimed = fixture.claimed_experience_ids;
  const real = buildEvidenceRoot(claimed);
  const inclusion_proofs = claimed.map((id) =>
    buildInclusionProof(claimed, id)
  );

  const honestEnvelope: Record<string, unknown> = {
    lesson_id: fixture.envelope.id,
    evidence_count: claimed.length,
    evidence_root: real.root, // honest
    inclusion_proofs,
    spec_version: WIRE_SPEC_VERSION,
    signed_at: "2026-05-01T00:00:02.000Z",
  };
  honestEnvelope.signature = sign(honestEnvelope, key.private_key_pem);

  const result = await validateLessonProof(honestEnvelope, {
    ourSpecMajor: 1,
    now: new Date("2026-05-02T00:00:00Z"),
    producerPubkey: pubkey,
  });
  assert.deepEqual(result, { ok: true }, "honest proof envelope must verify");
});
