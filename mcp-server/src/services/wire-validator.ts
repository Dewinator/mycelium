/**
 * Wire validator — Swarm Phase 3b (issue #86).
 *
 * Pure runtime validator for incoming wire records. Implements rejection
 * rules 1-13 from docs/SWARM_SPEC.md §5; rules 14 (local trust — caller's
 * job) and 15 (body cap — transport-layer concern) are intentionally
 * out of scope here. Rule 10 (duplicate id+signed_at with conflicting
 * signature) is also caller-side: it requires a database read against
 * already-ingested records and cannot be answered by a pure function.
 *
 * Design discipline (issue #86 Hard constraints):
 *   - Pure: no DB, no HTTP, no file I/O, no caching/memoization.
 *   - All side-channel data (current time, pubkey-by-node lookup) is
 *     injected via `opts` so this function is trivially testable and
 *     deterministic for a given input.
 *   - Composes the existing JCS+Ed25519 primitives in `signature.ts` and
 *     the `computeNodeId` helper in `node-identity.ts`. Re-implementing
 *     either would create a divergence surface — the trust premise of
 *     the swarm is that two honest implementations agree on the
 *     bytes-under-signature and on the node_id derivation.
 */
import { verify } from "./signature.js";
import { computeNodeId } from "./node-identity.js";
import { verifyInclusionProof } from "./evidence-merkle.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ValidationOk = { ok: true };
export type ValidationErr = { ok: false; rule: number; reason: string };
export type ValidationResult = ValidationOk | ValidationErr;

export type WireKind = "lesson" | "hub_anchor" | "node_advertisement";

export interface ValidateOptions {
  /** Major component of the receiver's spec version (e.g. 1 for v1.x). */
  ourSpecMajor: number;
  /** Current time. Injected so tests are clock-independent. */
  now: Date;
  /**
   * Lookup the raw 32-byte Ed25519 pubkey for a non-self node, or `null`
   * if unknown. Used for rule 5 on Lesson and HubAnchor (signature
   * verification against the producer's key). NodeAdvertisement is
   * self-signed: the pubkey is in the record itself, so this callback
   * is not consulted for that kind.
   */
  getPubkeyForNode: (nodeId: string) => Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Constants from SWARM_SPEC §5
// ---------------------------------------------------------------------------

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;          // rule 7
const STALE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;    // rule 8
const LESSON_CONTENT_BYTE_LIMIT = 8 * 1024;         // rule 12
const HUB_TOPIC_LABEL_CHAR_LIMIT = 256;             // rule 12
const ADV_DISPLAY_NAME_CHAR_LIMIT = 64;             // rule 12
const EMBEDDING_DIM = 768;                          // rule 4
const ED25519_PUBKEY_LEN = 32;

// ---------------------------------------------------------------------------
// Field schemas — exhaustive required-field lists per kind
//
// The required-field set is the chokepoint for rules 2 and 3: a field
// that's missing is rule 2, a field present-but-wrong-type is rule 3.
// Optional fields (Lesson.tags, HubAnchor.topic_label,
// NodeAdvertisement.display_name) are validated separately because their
// rejection rules differ (rule 12 size limits, not rule 2/3 presence).
// ---------------------------------------------------------------------------

type FieldType = "string" | "number" | "array";

interface FieldSpec {
  name: string;
  type: FieldType;
}

const LESSON_REQUIRED: readonly FieldSpec[] = [
  { name: "id", type: "string" },
  { name: "content", type: "string" },
  { name: "embedding", type: "array" },
  { name: "synthesized_from_cluster_size", type: "number" },
  { name: "origin_node_id", type: "string" },
  { name: "signed_at", type: "string" },
  { name: "signature", type: "string" },
  { name: "created_at", type: "string" },
  { name: "spec_version", type: "string" },
];

const HUB_REQUIRED: readonly FieldSpec[] = [
  { name: "embedding", type: "array" },
  { name: "hub_score", type: "number" },
  { name: "local_memory_count", type: "number" },
  { name: "origin_node_id", type: "string" },
  { name: "signed_at", type: "string" },
  { name: "signature", type: "string" },
  { name: "spec_version", type: "string" },
];

const ADV_REQUIRED: readonly FieldSpec[] = [
  { name: "node_id", type: "string" },
  { name: "pubkey", type: "string" },
  { name: "endpoint_url", type: "string" },
  { name: "spec_version", type: "string" },
  { name: "signed_at", type: "string" },
  { name: "signature", type: "string" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(rule: number, reason: string): ValidationErr {
  return { ok: false, rule, reason };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkPresentAndTyped(
  record: Record<string, unknown>,
  specs: readonly FieldSpec[]
): ValidationErr | null {
  for (const f of specs) {
    if (!(f.name in record) || record[f.name] === null || record[f.name] === undefined) {
      return fail(2, `missing required field: ${f.name}`);
    }
  }
  for (const f of specs) {
    const v = record[f.name];
    if (f.type === "string" && typeof v !== "string") {
      return fail(3, `field ${f.name} must be string, got ${typeof v}`);
    }
    if (f.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) {
      return fail(
        3,
        `field ${f.name} must be a finite number, got ${typeof v}`
      );
    }
    if (f.type === "array" && !Array.isArray(v)) {
      return fail(3, `field ${f.name} must be array, got ${typeof v}`);
    }
  }
  return null;
}

function checkEmbedding(value: unknown): ValidationErr | null {
  if (!Array.isArray(value)) {
    // Defensive — type pass already enforced array, this is belt-and-suspenders.
    return fail(4, "embedding must be an array");
  }
  if (value.length !== EMBEDDING_DIM) {
    return fail(
      4,
      `embedding must have ${EMBEDDING_DIM} elements, got ${value.length}`
    );
  }
  for (let i = 0; i < value.length; i++) {
    const x = value[i];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      return fail(4, `embedding[${i}] is not a finite number`);
    }
  }
  return null;
}

/** Parse `<major>.<minor>` per SWARM_SPEC §1. Returns null if malformed. */
function parseSpec(specVersion: string): { major: number; minor: number } | null {
  // Spec §1: decimal integers, no leading zeros, no whitespace. Single-digit
  // majors are common ("1.0"), multi-digit minors are valid ("1.10"); we
  // accept any non-leading-zero decimal pair.
  const m = specVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// v1.1 Proof-of-Knowledge field set on Lesson (SWARM_SPEC §3.1, §3.7).
// `prev_lesson_hash` is intentionally absent here because its type is
// `string | null` (first-ever-published lesson uses null) — the generic
// string-or-array typing pass cannot express that union, so it is checked
// inline below.
const LESSON_V11_REQUIRED: readonly FieldSpec[] = [
  { name: "evidence_root", type: "string" },
  { name: "evidence_count", type: "number" },
  { name: "maturity_age_days", type: "number" },
  { name: "useful_count", type: "number" },
];

const LESSON_V11_FIELD_NAMES = [
  "evidence_root",
  "evidence_count",
  "prev_lesson_hash",
  "maturity_age_days",
  "useful_count",
] as const;

/** Parse an ISO-8601 timestamp into ms-epoch, or null if unparseable. */
function parseTimestamp(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Decode `pubkey` from a NodeAdvertisement. SWARM_SPEC §3 / §3.3 fix the
 * encoding to unpadded base64url. We refuse padded base64 and any
 * non-alphabet character so a producer that picked the wrong variant
 * fails loudly here, not later inside Ed25519.
 */
function decodeAdvertisementPubkey(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// validateWireRecord — entry point
//
// Returns Promise<ValidationResult> per the issue contract; the body is
// synchronous today, but keeping the async surface lets a future receive
// path block on e.g. an async pubkey lookup without re-fitting every
// caller. (Synchronous in v1, async-shaped for v2 — same trade-off the
// rest of the swarm services took.)
// ---------------------------------------------------------------------------

export async function validateWireRecord(
  record: unknown,
  kind: WireKind,
  opts: ValidateOptions
): Promise<ValidationResult> {
  if (!isObject(record)) {
    return fail(
      3,
      `record must be a JSON object, got ${
        Array.isArray(record) ? "array" : typeof record
      }`
    );
  }

  const specs =
    kind === "lesson"
      ? LESSON_REQUIRED
      : kind === "hub_anchor"
        ? HUB_REQUIRED
        : ADV_REQUIRED;

  // Rules 2 + 3: required-field presence and JSON-type match.
  const presenceErr = checkPresentAndTyped(record, specs);
  if (presenceErr) return presenceErr;

  // Rule 1: spec_version major. Done after presence/type so we know the
  // field is at least a string before we try to parse it.
  const specVersion = record.spec_version as string;
  const spec = parseSpec(specVersion);
  if (spec === null) {
    // A string that isn't a valid <major>.<minor> is a type-shape problem
    // for that field — it can't pass spec-version negotiation but it isn't
    // a major mismatch in the rule-1 sense either. Surface as rule 3.
    return fail(3, `spec_version "${specVersion}" is not a valid <major>.<minor>`);
  }
  if (spec.major !== opts.ourSpecMajor) {
    return fail(
      1,
      `spec_version major ${spec.major} != receiver's major ${opts.ourSpecMajor}`
    );
  }

  // Rule 4: embedding shape (Lesson and HubAnchor only).
  if (kind === "lesson" || kind === "hub_anchor") {
    const e = checkEmbedding(record.embedding);
    if (e) return e;
  }

  // Rule 12: kind-specific size limits. Optional fields are also typed
  // here because their type was not exercised by checkPresentAndTyped.
  if (kind === "lesson") {
    const content = record.content as string;
    if (Buffer.byteLength(content, "utf8") > LESSON_CONTENT_BYTE_LIMIT) {
      return fail(
        12,
        `Lesson.content > ${LESSON_CONTENT_BYTE_LIMIT} bytes UTF-8`
      );
    }
  } else if (kind === "hub_anchor") {
    const topic = record.topic_label;
    if (topic !== undefined && topic !== null) {
      if (typeof topic !== "string") {
        return fail(3, `topic_label must be string, got ${typeof topic}`);
      }
      if (topic.length > HUB_TOPIC_LABEL_CHAR_LIMIT) {
        return fail(
          12,
          `HubAnchor.topic_label > ${HUB_TOPIC_LABEL_CHAR_LIMIT} chars`
        );
      }
    }
  } else if (kind === "node_advertisement") {
    const dn = record.display_name;
    if (dn !== undefined && dn !== null) {
      if (typeof dn !== "string") {
        return fail(3, `display_name must be string, got ${typeof dn}`);
      }
      if (dn.length > ADV_DISPLAY_NAME_CHAR_LIMIT) {
        return fail(
          12,
          `NodeAdvertisement.display_name > ${ADV_DISPLAY_NAME_CHAR_LIMIT} chars`
        );
      }
    }
  }

  // Rule 13: NodeAdvertisement.endpoint_url MUST be https.
  if (kind === "node_advertisement") {
    const url = record.endpoint_url as string;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail(13, `endpoint_url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
      return fail(
        13,
        `endpoint_url must use https, got ${parsed.protocol}//`
      );
    }
  }

  // Rule 11: Lesson.synthesized_from_cluster_size >= 2 (Generalization rule
  // enforced on the wire, SWARM_SPEC §3.1).
  if (kind === "lesson") {
    const n = record.synthesized_from_cluster_size as number;
    if (n < 2) {
      return fail(
        11,
        `Lesson.synthesized_from_cluster_size must be >= 2, got ${n}`
      );
    }
  }

  // SWARM_SPEC §5 v1.1 additions for Lesson — rules 16 and 20 (rules
  // 17/18/19 are out-of-band: 17/18 require a fetched proof, 19 requires
  // the receiver's prev-lesson cache).
  //
  // The minor-version split is: v1.0 records MUST NOT carry the five
  // PoK fields (rule 20 third leg, the cross-version smuggling guard);
  // v1.1+ records MUST carry all five (rule 2 — required-field presence)
  // and satisfy the count floors (rules 16 + 20 first/second legs).
  if (kind === "lesson") {
    const v11FieldsPresent = LESSON_V11_FIELD_NAMES.filter(
      (f) => f in record && record[f] !== undefined
    );

    if (spec.major === 1 && spec.minor === 0) {
      // Rule 20 (third leg): v1.0 records MUST NOT carry v1.1 fields.
      // Even one PoK field on a "1.0" record is forbidden — this is the
      // cross-version smuggling check, not a "best-effort additive" path.
      if (v11FieldsPresent.length > 0) {
        return fail(
          20,
          `v1.1 fields present on spec_version="1.0" record: ${v11FieldsPresent.join(", ")}`
        );
      }
    } else if (spec.major === 1 && spec.minor >= 1) {
      // Rule 2 / 3 for the four typed v1.1 required fields.
      const v11Err = checkPresentAndTyped(record, LESSON_V11_REQUIRED);
      if (v11Err) return v11Err;

      // prev_lesson_hash: required, but typed `string | null`. The generic
      // helper above does not encode the union, so handle it inline.
      // Presence is the absence of the JS-undefined sentinel; explicit
      // `null` is allowed (first-ever-published lesson, §3.1).
      if (!("prev_lesson_hash" in record) || record.prev_lesson_hash === undefined) {
        return fail(2, `missing required field: prev_lesson_hash`);
      }
      const prevHash = record.prev_lesson_hash;
      if (prevHash !== null && typeof prevHash !== "string") {
        return fail(
          3,
          `prev_lesson_hash must be string or null, got ${typeof prevHash}`
        );
      }

      // Rule 16: evidence_count must be a positive integer.
      const evCount = record.evidence_count as number;
      if (!Number.isInteger(evCount) || evCount < 1) {
        return fail(16, `Lesson.evidence_count must be an integer >= 1, got ${evCount}`);
      }

      // Rule 20 (first leg): maturity_age_days >= 0.
      const maturity = record.maturity_age_days as number;
      if (!Number.isInteger(maturity) || maturity < 0) {
        return fail(
          20,
          `Lesson.maturity_age_days must be a non-negative integer, got ${maturity}`
        );
      }

      // Rule 20 (second leg): useful_count >= 0.
      const useful = record.useful_count as number;
      if (!Number.isInteger(useful) || useful < 0) {
        return fail(
          20,
          `Lesson.useful_count must be a non-negative integer, got ${useful}`
        );
      }
    }
  }

  // Rule 7 + 8: timestamp bounds. signed_at is required for all kinds;
  // rule 8 (90-day staleness) is Lesson/HubAnchor only — NodeAdvertisement
  // is expected to be re-fetched live.
  const signedAtMs = parseTimestamp(record.signed_at as string);
  if (signedAtMs === null) {
    return fail(3, `signed_at is not a parseable ISO-8601 timestamp`);
  }
  const nowMs = opts.now.getTime();
  if (signedAtMs > nowMs + FUTURE_TOLERANCE_MS) {
    return fail(
      7,
      `signed_at ${record.signed_at} is more than 5 minutes in the future`
    );
  }
  if (kind === "lesson" || kind === "hub_anchor") {
    if (signedAtMs < nowMs - STALE_LIMIT_MS) {
      return fail(
        8,
        `signed_at ${record.signed_at} is older than 90 days`
      );
    }
  }

  // Rule 9: Lesson.signed_at MUST NOT precede created_at — a producer
  // cannot sign a lesson before having synthesized it.
  if (kind === "lesson") {
    const createdAtMs = parseTimestamp(record.created_at as string);
    if (createdAtMs === null) {
      return fail(3, `created_at is not a parseable ISO-8601 timestamp`);
    }
    if (signedAtMs < createdAtMs) {
      return fail(9, `Lesson.signed_at (${record.signed_at}) < created_at (${record.created_at})`);
    }
  }

  // Rule 6: NodeAdvertisement.node_id MUST equal multihash(pubkey). This is
  // also where we obtain the verifier pubkey for rule 5 — for self-signed
  // advertisements, no out-of-band lookup is needed.
  let verifierPubkey: Uint8Array | null;
  if (kind === "node_advertisement") {
    const pubkeyB64Url = record.pubkey as string;
    const pubkeyBytes = decodeAdvertisementPubkey(pubkeyB64Url);
    if (!pubkeyBytes || pubkeyBytes.length !== ED25519_PUBKEY_LEN) {
      return fail(
        6,
        `pubkey is not a 32-byte unpadded base64url Ed25519 key`
      );
    }
    let derivedNodeId: string;
    try {
      derivedNodeId = computeNodeId(Buffer.from(pubkeyBytes));
    } catch (e) {
      return fail(6, `cannot derive node_id from pubkey: ${(e as Error).message}`);
    }
    if (derivedNodeId !== record.node_id) {
      return fail(
        6,
        `node_id ${record.node_id} != multihash(pubkey) ${derivedNodeId}`
      );
    }
    verifierPubkey = pubkeyBytes;
  } else {
    const originId = record.origin_node_id as string;
    verifierPubkey = opts.getPubkeyForNode(originId);
    if (!verifierPubkey) {
      // We can't verify a signature against a key we don't hold — collapse
      // this to a rule 5 rejection. Trust establishment (how the receiver
      // ever obtains the pubkey for `originId`) is rule 14's territory.
      return fail(5, `no pubkey available for origin_node_id ${originId}`);
    }
  }

  // Rule 5: Ed25519 signature verification over JCS-canonical bytes.
  // `verify` strips the on-wire `signature` field internally before
  // recomputing — see signature.ts.
  const sig = record.signature as string;
  if (!verify(record, sig, verifierPubkey)) {
    return fail(5, `Ed25519 signature verification failed`);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateLessonProof — receiver-side §5 rules 17 + 18 on a fetched
// /swarm/lessons/{id}/proof envelope (sub-phase 4e, issue #105).
//
// The proof envelope is a different shape than a Lesson record — it is the
// answer to a §4.6 challenge, not a thing that gets ingested into
// `swarm_lessons`. So it gets its own validator entry point rather than
// being squeezed into `validateWireRecord`'s `WireKind` discriminator.
// The §5 rule numbering is the SAME ledger though: rules 17 and 18 both
// fire on the proof, not on the lesson row itself.
//
// What this function checks:
//
//   - Required-field presence and JSON-type shape (rule 2 / 3 leverage)
//   - Rule 5: Ed25519 envelope signature against the producing node's
//     pubkey (per §4.6 the envelope is signed by `origin_node_id`'s key,
//     not the relay's). The receiver MUST already know `origin_node_id`
//     in order to have asked for this proof — so the pubkey lookup is
//     supplied by the caller as `producerPubkey`, not by a callback.
//   - Rule 17: `inclusion_proofs.length === evidence_count`
//   - Rule 18: every `merkle_path` reconstructs `evidence_root` via
//     `verifyInclusionProof` (4c module — same algorithm the producer
//     used at sign time)
//
// What this function does NOT check (out of scope for 4e):
//
//   - Cross-reference against the lesson's own `evidence_root` /
//     `evidence_count` — that lives in the caller's ingest path, which
//     pairs the proof with the previously-stored lesson row.
//   - Reputation decay arithmetic on rule 17/18 failure — sub-phase 4f.
//   - Rule 19 (broken commitment chain) — already enforced inside
//     `validateWireRecord` for incoming lessons, not for proofs.
// ---------------------------------------------------------------------------

const PROOF_REQUIRED: readonly FieldSpec[] = [
  { name: "lesson_id", type: "string" },
  { name: "evidence_count", type: "number" },
  { name: "evidence_root", type: "string" },
  { name: "inclusion_proofs", type: "array" },
  { name: "spec_version", type: "string" },
  { name: "signed_at", type: "string" },
  { name: "signature", type: "string" },
];

export interface ValidateProofOptions {
  /** Major component of the receiver's spec version (e.g. 1 for v1.x). */
  ourSpecMajor: number;
  /** Current time. Injected so tests are clock-independent. */
  now: Date;
  /**
   * Raw 32-byte Ed25519 pubkey of the producing node (`origin_node_id`
   * of the lesson the proof is for). The receiver already knows this
   * — they had to in order to verify the lesson signature in the first
   * place — so a callback indirection would be ceremony without value.
   */
  producerPubkey: Uint8Array;
}

export async function validateLessonProof(
  envelope: unknown,
  opts: ValidateProofOptions
): Promise<ValidationResult> {
  if (!isObject(envelope)) {
    return fail(
      3,
      `proof envelope must be a JSON object, got ${
        Array.isArray(envelope) ? "array" : typeof envelope
      }`
    );
  }

  // Required fields + JSON type. Same rule 2 / 3 mapping as wire records.
  const presenceErr = checkPresentAndTyped(envelope, PROOF_REQUIRED);
  if (presenceErr) return presenceErr;

  // Rule 1: spec_version major. Done after presence/type so we know the
  // field is at least a string.
  const specVersion = envelope.spec_version as string;
  const spec = parseSpec(specVersion);
  if (spec === null) {
    return fail(3, `spec_version "${specVersion}" is not a valid <major>.<minor>`);
  }
  if (spec.major !== opts.ourSpecMajor) {
    return fail(
      1,
      `spec_version major ${spec.major} != receiver's major ${opts.ourSpecMajor}`
    );
  }

  // Rule 7: signed_at must not be too far in the future. Rule 8 (90-day
  // staleness) intentionally NOT applied — a proof is a live answer to a
  // live challenge; an old envelope simply means the producer's clock
  // skewed at sign time. The receiver should still verify the math.
  const signedAtMs = parseTimestamp(envelope.signed_at as string);
  if (signedAtMs === null) {
    return fail(3, `signed_at is not a parseable ISO-8601 timestamp`);
  }
  if (signedAtMs > opts.now.getTime() + FUTURE_TOLERANCE_MS) {
    return fail(
      7,
      `signed_at ${envelope.signed_at} is more than 5 minutes in the future`
    );
  }

  // Rule 5: envelope signature verifies against the producing node's key.
  // The receiver already holds `producerPubkey` (they verified the lesson
  // signature with it earlier); failing here means either the wrong key
  // was supplied or the envelope was tampered with in transit.
  if (
    opts.producerPubkey.length !== ED25519_PUBKEY_LEN
  ) {
    return fail(
      5,
      `producerPubkey is ${opts.producerPubkey.length} bytes; expected ${ED25519_PUBKEY_LEN} (Ed25519)`
    );
  }
  const envSig = envelope.signature as string;
  if (!verify(envelope, envSig, opts.producerPubkey)) {
    return fail(5, `envelope Ed25519 signature verification failed`);
  }

  // Rule 16-shape pin on the proof envelope — evidence_count must be a
  // positive integer to even meaningfully fold a Merkle tree. Without this
  // a malformed `evidence_count: 0` would slip past rule 17 (0 == 0).
  const evCount = envelope.evidence_count as number;
  if (!Number.isInteger(evCount) || evCount < 1) {
    return fail(
      16,
      `proof envelope evidence_count must be an integer >= 1, got ${evCount}`
    );
  }

  // Rule 17: inclusion_proofs.length === evidence_count.
  // Per §4.6 the producer MUST emit one proof per leaf the lesson
  // committed to; a mismatch is the receiver's signal that the producer
  // is either (a) buggy or (b) dropping leaves to hide some — both are
  // §10.1 reputation-decay events at the caller layer (out of scope here).
  const proofs = envelope.inclusion_proofs as unknown[];
  if (proofs.length !== evCount) {
    return fail(
      17,
      `inclusion_proofs.length (${proofs.length}) != evidence_count (${evCount})`
    );
  }

  // Rule 18: every merkle_path reconstructs evidence_root.
  // verifyInclusionProof is the exact algorithm the producer used at
  // sign time (4c module) — sorted-pair inner hashing means the proof
  // verifies position-less. A single failure here means the producer's
  // commitment was either broken or doctored.
  const evidenceRoot = envelope.evidence_root as string;
  for (let i = 0; i < proofs.length; i++) {
    const proof = proofs[i];
    if (!isObject(proof)) {
      return fail(18, `inclusion_proofs[${i}] is not an object`);
    }
    const leaf = proof.hashed_experience_id;
    const path = proof.merkle_path;
    if (typeof leaf !== "string") {
      return fail(
        18,
        `inclusion_proofs[${i}].hashed_experience_id must be string, got ${typeof leaf}`
      );
    }
    if (!Array.isArray(path) || path.some((p) => typeof p !== "string")) {
      return fail(
        18,
        `inclusion_proofs[${i}].merkle_path must be an array of strings`
      );
    }
    if (!verifyInclusionProof(evidenceRoot, leaf, path as string[])) {
      return fail(
        18,
        `inclusion_proofs[${i}] does not reconstruct evidence_root`
      );
    }
  }

  return { ok: true };
}
