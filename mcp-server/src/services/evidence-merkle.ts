/**
 * Evidence-Merkle service — Swarm sub-phase 4c (issue #103, RFC #100).
 *
 * Pure, dependency-free producer-side Merkle tree that anchors a Lesson's
 * `evidence_root` to the experience IDs that produced it, per
 * docs/SWARM_SPEC.md §3.7.1 and §4.6.
 *
 * Hashing rules (RFC 6962, Bitcoin trailing-leaf duplication):
 *   - Leaf hash:  H(0x00 || hashed_experience_id_bytes)
 *   - Inner hash: H(0x01 || min(L, R) || max(L, R))     (see §design notes below)
 *   - Odd levels: trailing leaf duplicated
 *
 * § design notes — sorted-pair inner-hash convention:
 *
 *   The 4c API contract (issue #103) is `verifyInclusionProof(root, leaf,
 *   path) → bool`. There is no leaf-index parameter, so the verifier
 *   cannot recover left/right placement at each level the way classical
 *   RFC 6962 audit-path verification does. Sorted-pair concatenation
 *   `H(0x01 || min(L,R) || max(L,R))` is the position-less normal form
 *   compatible with that signature; it is the same construction used by
 *   OpenZeppelin's MerkleProof.sol and most on-chain verifiers. The
 *   collision-resistance argument is unchanged from RFC 6962 because
 *   inner-domain (0x01) is disjoint from leaf-domain (0x00).
 *
 *   Trade-off: an attacker who can choose which two of N leaves are
 *   adjacent-siblings at level 0 can cause the tree to swap the
 *   left/right of those two; sorted-pair hashing collapses both
 *   orderings to the same hash. Because v1.1 lessons sort leaves
 *   ascending before tree construction (spec §3.7.1) the attacker
 *   cannot control adjacency without controlling the experience-id
 *   hashes themselves — which they cannot, because the canonical
 *   experience id space is enforced by the producer node and the
 *   verifier never sees raw IDs.
 *
 * Privacy invariant (Designprinzip 2):
 *
 *   Only **hashes** of experience IDs ever leave this module. The
 *   evidence-root and merkle-paths are sha2-256 multihashes; the
 *   `hashed_experience_id` exposed in inclusion proofs is itself a
 *   hash. Raw experience IDs are accepted at the input boundary
 *   (because the producer needs them to compute hashes), but they
 *   never appear in the output of any exported function. A defensive
 *   shape check rejects anything that obviously isn't an ID (whitespace,
 *   structural delimiters, suspicious length).
 */
import { createHash } from "node:crypto";
import { base58btcEncode } from "./node-identity.js";

// ---------------------------------------------------------------------------
// Multihash + base58btc helpers (sha2-256 only, the single hash this swarm
// commits to per SWARM_SPEC §3.7.1).
// ---------------------------------------------------------------------------

const MULTIHASH_SHA256_HEADER = Buffer.from([0x12, 0x20]); // sha2-256, 32-byte digest
const MULTIHASH_TOTAL_BYTES = 34; // 2-byte header + 32-byte digest
const LEAF_PREFIX = Buffer.from([0x00]);
const INNER_PREFIX = Buffer.from([0x01]);

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_INDEX = (() => {
  const idx = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    idx[BASE58_ALPHABET.charCodeAt(i)] = i;
  }
  return idx;
})();

function base58btcDecode(s: string): Buffer {
  if (s.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (let i = zeros; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? BASE58_INDEX[code] : -1;
    if (v < 0) {
      throw new Error(
        `base58btcDecode: invalid base58btc character '${s[i]}' at index ${i}`
      );
    }
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.concat([Buffer.alloc(zeros, 0), Buffer.from(out)]);
}

function multihashFromDigest(digest: Buffer): string {
  if (digest.length !== 32) {
    throw new Error(`multihashFromDigest: expected 32-byte digest, got ${digest.length}`);
  }
  return base58btcEncode(Buffer.concat([MULTIHASH_SHA256_HEADER, digest]));
}

function digestFromMultihash(multihashB58: string): Buffer {
  const decoded = base58btcDecode(multihashB58);
  if (decoded.length !== MULTIHASH_TOTAL_BYTES) {
    throw new Error(
      `digestFromMultihash: expected ${MULTIHASH_TOTAL_BYTES}-byte sha2-256 multihash, got ${decoded.length} bytes`
    );
  }
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(
      `digestFromMultihash: prefix 0x${decoded[0].toString(16)} 0x${decoded[1].toString(16)} is not sha2-256 (expected 0x12 0x20)`
    );
  }
  return decoded.subarray(2);
}

// ---------------------------------------------------------------------------
// Privacy guard — defensive check that rejects obviously-not-an-ID input.
//
// This is not a security boundary (a 36-char alphanumeric blob would slip
// through). The guard exists to fail loud on accidental misuse — e.g. a
// caller mistakenly passing experience.content instead of experience.id.
// ---------------------------------------------------------------------------

const FORBIDDEN_ID_CHARS = /[\s{}\[\]"<>]/;
const MAX_REASONABLE_ID_LENGTH = 128;

function assertExperienceIdShape(value: unknown, ctx: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${ctx}: experience_id must be a string, got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new Error(`${ctx}: experience_id must not be empty`);
  }
  if (value.length > MAX_REASONABLE_ID_LENGTH) {
    throw new Error(
      `${ctx}: experience_id is ${value.length} chars (>${MAX_REASONABLE_ID_LENGTH}); refusing to accept what looks like raw content. Pass an ID, not an experience body.`
    );
  }
  if (FORBIDDEN_ID_CHARS.test(value)) {
    throw new Error(
      `${ctx}: experience_id contains whitespace or structural characters; refusing to accept what looks like raw content. Pass an ID, not an experience body.`
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a producer-local experience ID into the leaf form that goes onto
 * the wire: `multihash(sha2-256, utf8-bytes-of-experience-id)` encoded in
 * base58btc. Output is a 46-character `Qm…`-prefixed string (same shape as
 * `node_id` from §3.5).
 *
 * Inputs are required to look like IDs (no whitespace, ≤ 128 chars). The
 * canonical byte-encoding for an experience id is its UTF-8 representation;
 * §3.7.1 phrases this as `experience_id_canonical_bytes`.
 */
export function hashExperienceId(experience_id: string): string {
  assertExperienceIdShape(experience_id, "hashExperienceId");
  const digest = createHash("sha256")
    .update(Buffer.from(experience_id, "utf8"))
    .digest();
  return multihashFromDigest(digest);
}

export interface EvidenceRoot {
  /** base58btc multihash of the Merkle root (sha2-256). */
  root: string;
  /**
   * The full set of `hashed_experience_id` leaves, sorted ascending —
   * the same order in which they were folded into the tree. Producers
   * persist this so they can later answer a §4.6 inclusion-proof
   * challenge without re-deriving the hashes from raw IDs.
   */
  leaves: string[];
}

/**
 * Build the `evidence_root` Merkle commitment over a producer-local set
 * of experience IDs. Leaves are hashed, sorted ascending (lex order on the
 * base58btc strings), then folded with RFC 6962 / Bitcoin conventions
 * documented at module top.
 *
 * Empty input is rejected — a v1.1 Lesson MUST satisfy `evidence_count ≥ 1`
 * (§3.1). Single-leaf trees are valid; the root is `H(0x00 || multihash)`.
 */
export function buildEvidenceRoot(experience_ids: string[]): EvidenceRoot {
  if (!Array.isArray(experience_ids)) {
    throw new Error("buildEvidenceRoot: experience_ids must be an array");
  }
  if (experience_ids.length === 0) {
    throw new Error(
      "buildEvidenceRoot: at least one experience id is required (evidence_count must be >= 1 per SWARM_SPEC §3.1)"
    );
  }
  experience_ids.forEach((id, i) =>
    assertExperienceIdShape(id, `buildEvidenceRoot[${i}]`)
  );
  const leaves = experience_ids.map(hashExperienceId).sort();
  const root = computeRoot(leaves);
  return { root, leaves };
}

export interface InclusionProof {
  /** The leaf this proof attests to. base58btc sha2-256 multihash. */
  hashed_experience_id: string;
  /**
   * Bottom-up sibling hashes (each a base58btc sha2-256 multihash of an
   * intermediate node). Combined with `hashed_experience_id` per §3.7.1
   * leaf-then-inner hashing, reconstructs `evidence_root`.
   */
  merkle_path: string[];
}

/**
 * Build an inclusion proof for `target` over `experience_ids`.
 *
 * `target` may be either the raw experience id (will be hashed
 * internally) or an already-hashed leaf (`hashExperienceId(...)` output).
 * Both forms resolve to the same on-tree leaf — accepting either lets the
 * §4.6 endpoint hand the function the value it already has, without
 * requiring re-derivation.
 *
 * Throws if the target is not present in the leaf set; that is a
 * producer-side invariant violation, not a quietly-empty proof.
 */
export function buildInclusionProof(
  experience_ids: string[],
  target: string
): InclusionProof {
  if (!Array.isArray(experience_ids) || experience_ids.length === 0) {
    throw new Error(
      "buildInclusionProof: experience_ids must be a non-empty array"
    );
  }
  experience_ids.forEach((id, i) =>
    assertExperienceIdShape(id, `buildInclusionProof[${i}]`)
  );
  // Resolve target to its leaf form. A 46-char Qm-prefixed string is a
  // hashed leaf; anything else is treated as a raw id and hashed.
  const leafTarget = looksLikeMultihashLeaf(target)
    ? target
    : hashExperienceId(target);

  const leaves = experience_ids.map(hashExperienceId).sort();
  const idx = leaves.indexOf(leafTarget);
  if (idx < 0) {
    throw new Error(
      `buildInclusionProof: target leaf not found among ${leaves.length} hashed experience ids`
    );
  }

  const path = collectAuditPath(leaves, idx);
  return {
    hashed_experience_id: leafTarget,
    merkle_path: path.map(multihashFromDigest),
  };
}

/**
 * Compute the evidence root over an already-hashed, already-sorted leaf
 * set. Same algorithm as `buildEvidenceRoot`, but skips the input
 * hash-and-sort step — used by the §4.6 proof endpoint, which reads
 * leaves out of `lesson_evidence_origin` (already canonical) and would
 * corrupt them if the producer's hash function were called a second time.
 *
 * The leaf order is taken AS-GIVEN. Callers MUST pass leaves in the same
 * canonical order the producer signed over (ascending lex on the base58btc
 * multihash form, per §3.7.1) — passing an unsorted array silently
 * produces a different root, which would fail every receiver's rule 18
 * check. The migration-077 substrate stores leaves in `position` order and
 * the proof endpoint reads them ORDER BY position ASC, so the contract
 * holds end-to-end without an extra sort here.
 */
export function computeRootFromHashedLeaves(sortedHashedLeaves: string[]): string {
  if (!Array.isArray(sortedHashedLeaves) || sortedHashedLeaves.length === 0) {
    throw new Error(
      "computeRootFromHashedLeaves: at least one hashed leaf is required"
    );
  }
  return computeRoot(sortedHashedLeaves);
}

/**
 * Build an inclusion proof from already-hashed leaves. Companion to
 * `computeRootFromHashedLeaves`: caller supplies the same canonical leaf
 * list the producer committed and the multihash of the leaf to prove
 * (`looksLikeMultihashLeaf`-shaped). Throws if `target` is not present
 * — that's a producer-side substrate inconsistency, not a quietly-empty
 * proof.
 */
export function buildInclusionProofFromHashedLeaves(
  sortedHashedLeaves: string[],
  target: string
): InclusionProof {
  if (!Array.isArray(sortedHashedLeaves) || sortedHashedLeaves.length === 0) {
    throw new Error(
      "buildInclusionProofFromHashedLeaves: at least one hashed leaf is required"
    );
  }
  if (!looksLikeMultihashLeaf(target)) {
    throw new Error(
      `buildInclusionProofFromHashedLeaves: target ${target} is not a base58btc sha2-256 multihash`
    );
  }
  const idx = sortedHashedLeaves.indexOf(target);
  if (idx < 0) {
    throw new Error(
      `buildInclusionProofFromHashedLeaves: target leaf not found among ${sortedHashedLeaves.length} hashed leaves`
    );
  }
  const path = collectAuditPath(sortedHashedLeaves, idx);
  return {
    hashed_experience_id: target,
    merkle_path: path.map(multihashFromDigest),
  };
}

/**
 * Verify an inclusion proof against `root`. Stateless and position-less:
 * sorted-pair inner hashing means the proof reconstructs the root without
 * any leaf-index argument (see module-top design notes).
 *
 * Returns false on any structural error — invalid multihash, non-base58btc
 * input, wrong digest length. Never throws on bad data; that lets a
 * receiver safely call this on adversarial peer input.
 */
export function verifyInclusionProof(
  root: string,
  hashed_experience_id: string,
  merkle_path: string[]
): boolean {
  try {
    const rootDigest = digestFromMultihash(root);
    let h = sha256(Buffer.concat([LEAF_PREFIX, base58btcDecode(hashed_experience_id)]));
    for (const sib of merkle_path) {
      const sibDigest = digestFromMultihash(sib);
      h = innerHash(h, sibDigest);
    }
    return h.equals(rootDigest);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal tree builder + audit-path collector
// ---------------------------------------------------------------------------

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function leafDigest(leafMultihashB58: string): Buffer {
  // Leaf hash domain-separation byte 0x00 prefixed to the FULL multihash
  // bytes (header + digest). Per §3.7.1 the leaf hash is over the
  // hashed_experience_id, which is the multihash form on the wire.
  return sha256(Buffer.concat([LEAF_PREFIX, base58btcDecode(leafMultihashB58)]));
}

function innerHash(left: Buffer, right: Buffer): Buffer {
  // Sorted-pair: see module-top design note. Equivalent to RFC 6962
  // H(0x01 || L || R) when leaves are pre-sorted at the bottom level
  // and we propagate that order up by always taking min/max at each
  // pairing.
  const [a, b] = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return sha256(Buffer.concat([INNER_PREFIX, a, b]));
}

function computeRoot(sortedLeaves: string[]): string {
  let layer: Buffer[] = sortedLeaves.map(leafDigest);
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      // Bitcoin convention: trailing odd leaf is duplicated.
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(innerHash(left, right));
    }
    layer = next;
  }
  return multihashFromDigest(layer[0]);
}

function collectAuditPath(sortedLeaves: string[], targetIdx: number): Buffer[] {
  const path: Buffer[] = [];
  let layer: Buffer[] = sortedLeaves.map(leafDigest);
  let cursor = targetIdx;
  while (layer.length > 1) {
    const sibIdx = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    // Odd-leaf duplication: when our level has an odd count and we are
    // the last node, our "sibling" is ourselves.
    const sib = sibIdx < layer.length ? layer[sibIdx] : layer[cursor];
    path.push(sib);
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(innerHash(left, right));
    }
    layer = next;
    cursor = Math.floor(cursor / 2);
  }
  return path;
}

function looksLikeMultihashLeaf(s: string): boolean {
  // sha2-256 multihash in base58btc is a deterministic 46-char Qm... string.
  return s.length === 46 && s.startsWith("Qm");
}

// ---------------------------------------------------------------------------
// Test-only exports — stable surface for the unit suite to recompute
// hashes independently. Not part of the public swarm API.
// ---------------------------------------------------------------------------

export const __internal = {
  sha256,
  leafDigest,
  innerHash,
  multihashFromDigest,
  digestFromMultihash,
  base58btcDecode,
  LEAF_PREFIX,
  INNER_PREFIX,
};
