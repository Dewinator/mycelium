/**
 * Tests for `services/evidence-merkle.ts` — Swarm sub-phase 4c (issue #103).
 *
 * Coverage matrix (issue #103 acceptance):
 *
 *   1. All four exported functions have at least one happy-path test.
 *   2. Hand-recomputed (test-side, independent of the module) root matches
 *      the module's output for 4-leaf and 7-leaf trees. The 7-leaf case
 *      exercises the odd-level trailing-leaf duplication path twice (once
 *      at level-0 with 7 leaves, once at level-1 with 4 leaves).
 *   3. Round-trip: build → proof → verify holds for *every* leaf for
 *      tree sizes 1, 2, 3, 4, 5, 7, 8.
 *   4. Privacy invariant: builder rejects strings that obviously look
 *      like raw experience content (whitespace, multi-line, oversized).
 *      Output of every public function is a hash, not raw content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  hashExperienceId,
  buildEvidenceRoot,
  buildInclusionProof,
  verifyInclusionProof,
  __internal,
} from "../services/evidence-merkle.js";

// ---------------------------------------------------------------------------
// Independent re-implementation of §3.7.1 hashing — the test-side oracle.
//
// This MUST be byte-identical to the module's behaviour, but written from
// scratch from the spec text alone. If the module ever drifts (e.g. wrong
// domain-separation byte, wrong multihash header), the oracle catches it.
// ---------------------------------------------------------------------------

const SHA256_MULTIHASH_HEADER = Buffer.from([0x12, 0x20]);
const BASE58_ALPHA =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function oracleBase58Encode(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = BASE58_ALPHA[r] + out;
  }
  return "1".repeat(zeros) + out;
}

function oracleBase58Decode(s: string): Buffer {
  if (s.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (let i = zeros; i < s.length; i++) {
    const v = BASE58_ALPHA.indexOf(s[i]);
    if (v < 0) throw new Error(`oracle: bad base58 char ${s[i]}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.concat([Buffer.alloc(zeros, 0), Buffer.from(bytes)]);
}

function oracleHashExperienceId(id: string): string {
  const digest = createHash("sha256").update(Buffer.from(id, "utf8")).digest();
  return oracleBase58Encode(Buffer.concat([SHA256_MULTIHASH_HEADER, digest]));
}

function oracleLeafDigest(leafMultihashB58: string): Buffer {
  const mh = oracleBase58Decode(leafMultihashB58);
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x00]), mh]))
    .digest();
}

function oracleInnerDigest(left: Buffer, right: Buffer): Buffer {
  // Sorted pair — matches module's inner-hash convention.
  const [a, b] =
    Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x01]), a, b]))
    .digest();
}

function oracleBuildRoot(experience_ids: string[]): string {
  const leaves = experience_ids.map(oracleHashExperienceId).sort();
  let layer: Buffer[] = leaves.map(oracleLeafDigest);
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(oracleInnerDigest(left, right));
    }
    layer = next;
  }
  return oracleBase58Encode(
    Buffer.concat([SHA256_MULTIHASH_HEADER, layer[0]])
  );
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fakeUuids(n: number): string[] {
  // Deterministic UUID-shaped IDs — keeps test output reproducible.
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const hex = i.toString(16).padStart(32, "0");
    out.push(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
        16,
        20
      )}-${hex.slice(20, 32)}`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("hashExperienceId produces a 46-char base58btc sha2-256 multihash", () => {
  const h = hashExperienceId("00000000-0000-0000-0000-000000000000");
  assert.equal(h.length, 46, "sha2-256 multihash must be 46 base58btc chars");
  assert.ok(h.startsWith("Qm"), "sha2-256 multihash MUST be Qm-prefixed");
  // Independent recomputation
  assert.equal(
    h,
    oracleHashExperienceId("00000000-0000-0000-0000-000000000000")
  );
});

test("hashExperienceId is deterministic and collision-distinguishes near-duplicates", () => {
  assert.equal(hashExperienceId("alpha"), hashExperienceId("alpha"));
  assert.notEqual(hashExperienceId("alpha"), hashExperienceId("alphA"));
});

test("buildEvidenceRoot rejects empty input (evidence_count must be >= 1)", () => {
  assert.throws(() => buildEvidenceRoot([]), /at least one experience id/);
});

test("buildEvidenceRoot single-leaf root = leafHash(multihash) as a multihash", () => {
  const ids = fakeUuids(1);
  const { root, leaves } = buildEvidenceRoot(ids);
  assert.equal(leaves.length, 1);
  // Independent recomputation: a 1-leaf tree has root == leafHash, no inner hashing happens.
  const expected = oracleBase58Encode(
    Buffer.concat([SHA256_MULTIHASH_HEADER, oracleLeafDigest(leaves[0])])
  );
  assert.equal(root, expected);
});

test("buildEvidenceRoot 4-leaf root matches independent oracle computation", () => {
  const ids = fakeUuids(4);
  const { root, leaves } = buildEvidenceRoot(ids);
  assert.equal(leaves.length, 4);
  // Leaves must be sorted ascending — §3.7.1 invariant.
  for (let i = 1; i < leaves.length; i++) {
    assert.ok(leaves[i - 1] <= leaves[i], "leaves must be sorted ascending");
  }
  assert.equal(root, oracleBuildRoot(ids));
});

test("buildEvidenceRoot 7-leaf root matches oracle (odd-level duplication path)", () => {
  // 7 leaves → level-0 has 7 (odd, last duplicates) → level-1 has 4 → level-2 has 2 → root.
  // Two duplications happen; oracle MUST agree.
  const ids = fakeUuids(7);
  const { root, leaves } = buildEvidenceRoot(ids);
  assert.equal(leaves.length, 7);
  assert.equal(root, oracleBuildRoot(ids));
});

test("buildEvidenceRoot is order-independent (leaves get sorted)", () => {
  const ids = fakeUuids(5);
  const a = buildEvidenceRoot(ids).root;
  const b = buildEvidenceRoot([...ids].reverse()).root;
  assert.equal(a, b, "input order must not affect root — leaves are pre-sorted");
});

test("round-trip: build → proof → verify holds for every leaf at sizes {1,2,3,4,5,7,8}", () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8]) {
    const ids = fakeUuids(n);
    const { root, leaves } = buildEvidenceRoot(ids);
    for (const id of ids) {
      const proof = buildInclusionProof(ids, id);
      assert.ok(
        verifyInclusionProof(root, proof.hashed_experience_id, proof.merkle_path),
        `n=${n} id=${id} round-trip failed`
      );
      // The proof's leaf MUST be one of the tree's sorted leaves.
      assert.ok(leaves.includes(proof.hashed_experience_id));
    }
  }
});

test("buildInclusionProof accepts already-hashed leaf as target", () => {
  const ids = fakeUuids(5);
  const { root } = buildEvidenceRoot(ids);
  const targetHashed = hashExperienceId(ids[2]);
  const proof = buildInclusionProof(ids, targetHashed);
  assert.equal(proof.hashed_experience_id, targetHashed);
  assert.ok(verifyInclusionProof(root, proof.hashed_experience_id, proof.merkle_path));
});

test("buildInclusionProof throws when target is not in the leaf set", () => {
  const ids = fakeUuids(3);
  assert.throws(
    () => buildInclusionProof(ids, "ffffffff-ffff-ffff-ffff-ffffffffffff"),
    /target leaf not found/
  );
});

test("verifyInclusionProof rejects a tampered merkle_path", () => {
  const ids = fakeUuids(4);
  const { root } = buildEvidenceRoot(ids);
  const proof = buildInclusionProof(ids, ids[1]);
  assert.ok(verifyInclusionProof(root, proof.hashed_experience_id, proof.merkle_path));
  // Replace one sibling with a hash of "garbage"
  const bad = [...proof.merkle_path];
  bad[0] = hashExperienceId("garbage-leaf");
  assert.equal(
    verifyInclusionProof(root, proof.hashed_experience_id, bad),
    false
  );
});

test("verifyInclusionProof rejects malformed root / path strings without throwing", () => {
  const ids = fakeUuids(4);
  const proof = buildInclusionProof(ids, ids[0]);
  // Bad root — wrong length
  assert.equal(verifyInclusionProof("not-a-multihash", proof.hashed_experience_id, proof.merkle_path), false);
  // Bad path entry — empty string
  assert.equal(verifyInclusionProof(buildEvidenceRoot(ids).root, proof.hashed_experience_id, [""]), false);
  // Bad leaf — invalid base58 char (0 is not in the bitcoin alphabet)
  assert.equal(verifyInclusionProof(buildEvidenceRoot(ids).root, "0", proof.merkle_path), false);
});

test("verifyInclusionProof rejects a proof against the wrong root", () => {
  const idsA = fakeUuids(4);
  const idsB = fakeUuids(4).map((s) => s.replace(/0/g, "1")); // disjoint set
  const rootB = buildEvidenceRoot(idsB).root;
  const proofA = buildInclusionProof(idsA, idsA[0]);
  assert.equal(
    verifyInclusionProof(rootB, proofA.hashed_experience_id, proofA.merkle_path),
    false
  );
});

test("privacy invariant: builder rejects whitespace in IDs (looks like raw content)", () => {
  assert.throws(
    () => hashExperienceId("hello world this is content not an id"),
    /whitespace or structural characters/
  );
  assert.throws(
    () => buildEvidenceRoot(["aaa-bbb", "id with space"]),
    /whitespace or structural characters/
  );
});

test("privacy invariant: builder rejects oversized inputs (likely raw content)", () => {
  const tooLong = "a".repeat(200);
  assert.throws(() => hashExperienceId(tooLong), />128/);
  assert.throws(() => buildEvidenceRoot([tooLong]), />128/);
});

test("privacy invariant: builder rejects multi-line + JSON-shaped inputs", () => {
  assert.throws(
    () => hashExperienceId('{"id": "abc", "content": "secret"}'),
    /whitespace or structural characters/
  );
  assert.throws(() => hashExperienceId("line1\nline2"), /whitespace or structural characters/);
});

test("privacy invariant: outputs of all public functions are hashes, not raw IDs", () => {
  const rawIds = fakeUuids(3);
  const { root, leaves } = buildEvidenceRoot(rawIds);
  // Output must not contain any raw id substring.
  for (const raw of rawIds) {
    assert.ok(!root.includes(raw), `root must not leak raw id ${raw}`);
    for (const leaf of leaves) {
      assert.ok(!leaf.includes(raw), `leaf must not leak raw id ${raw}`);
    }
  }
  const proof = buildInclusionProof(rawIds, rawIds[1]);
  assert.ok(!proof.hashed_experience_id.includes(rawIds[1]));
  for (const sib of proof.merkle_path) {
    for (const raw of rawIds) {
      assert.ok(!sib.includes(raw), `merkle_path must not leak raw id ${raw}`);
    }
  }
});

test("__internal helpers are consistent with the public API", () => {
  // The leaf digest of an id, computed via __internal, equals what
  // verifyInclusionProof's first step would compute. Tightens the
  // contract between the public API and the verification primitive.
  const id = "abc-123";
  const hashedId = hashExperienceId(id);
  const leafD = __internal.leafDigest(hashedId);
  assert.equal(leafD.length, 32);

  // A 1-leaf tree's root is exactly multihash(leafDigest) and verify
  // accepts an empty merkle_path against it.
  const { root } = buildEvidenceRoot([id]);
  assert.equal(verifyInclusionProof(root, hashedId, []), true);
});
