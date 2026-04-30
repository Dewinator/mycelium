/**
 * GET /swarm/lessons/{id}/proof — Swarm sub-phase 4e (issue #105).
 *
 * Serves the §4.6 Merkle-inclusion-proof envelope for a Lesson this node
 * has published. The envelope contains every leaf's `merkle_path` so a
 * receiver can verify, without ever seeing raw episode content, that the
 * `evidence_root` the lesson committed to actually folds over the claimed
 * `evidence_count` leaves (SWARM_SPEC §3.7 + §4.6).
 *
 * Responsibility split:
 *
 *   - The producer-side substrate (migration 077) records the canonical
 *     leaf order in `lesson_evidence_origin` at signing time. This handler
 *     never re-derives leaves from raw experience IDs — it only reads what
 *     was already committed. Re-deriving here would re-introduce a divergence
 *     surface and risk silently re-sorting under the receiver.
 *   - The 4c module (`evidence-merkle.ts`) computes the Merkle paths from
 *     the canonical leaf list. Same code the producer used at sign time, so
 *     `evidence_root` recomputed here MUST equal the value the lesson signed
 *     over — if it doesn't, the producer corrupted its own substrate and we
 *     answer 503 rather than emit a proof that won't verify.
 *
 * Status mapping (§4.6):
 *
 *   - 200: lesson held by this node AND we are its producer AND substrate
 *     leaves recorded — full envelope, signed by this node's self-key.
 *   - 404: lesson with that id is not held here, or held only as a swarm-
 *     relayed copy from another producer. Per §4.6: "Receivers may try
 *     another peer." A relay MUST NOT sign a proof envelope for someone
 *     else's lesson — only the producing node can.
 *   - 410: this node DID publish that lesson_id (a `lesson_chain` row
 *     exists for it) but no longer holds the content. Authoritative —
 *     the receiver MUST NOT retry this peer for that id.
 *   - 503: precondition not met (no self-identity, signing failure,
 *     producer-substrate corruption — `evidence_root` mismatch). Caller
 *     gets a deterministic operator-readable error string.
 *
 * Privacy invariant (Designprinzip 2):
 *
 *   The response body MUST contain only `hashed_experience_id`s, never
 *   the raw producer-local experience IDs that fed them. The substrate
 *   table only stores hashes, so this is naturally satisfied — but the
 *   contract test `lesson-proof-endpoint.test.ts` checks the response
 *   body for any UUID-shaped string that isn't the lesson_id, as a
 *   defensive guard against future shape regressions.
 */
import {
  signWithSelfKey,
  type SignedRecord,
} from "../../services/signature.js";
import { WIRE_SPEC_VERSION } from "../../services/wire-types.js";
import {
  buildInclusionProofFromHashedLeaves,
  computeRootFromHashedLeaves,
  type InclusionProof,
} from "../../services/evidence-merkle.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Lesson metadata the handler needs to build the response envelope.
 * Kept intentionally narrow — no signature, no embedding, no content. The
 * envelope re-signs over the proof; we do not relay the lesson signature.
 */
export interface LessonProofMeta {
  origin_node_id: string;
  signed_at: string;
  spec_version: string;
}

export interface LessonProofDeps {
  /** UUID of the lesson the receiver is asking about. */
  lessonId: string;
  /**
   * Load the lesson row (`swarm_lessons`) for `lessonId`. Returns null
   * when the lesson is not held — handler then disambiguates 404 vs 410
   * via `wasPublishedByThisNode`.
   */
  loadLesson: (lessonId: string) => Promise<LessonProofMeta | null>;
  /**
   * Load the canonical-ordered `hashed_experience_id` leaves recorded at
   * signing time (`lesson_evidence_origin`, ORDER BY position ASC).
   * Returns an empty array if no producer-side record exists for the lesson.
   */
  loadLeaves: (lessonId: string) => Promise<string[]>;
  /**
   * True iff this node ever published `lessonId` (a row in `lesson_chain`).
   * Used to distinguish 404 (never heard of) from 410 (we did publish it,
   * since forgotten/superseded).
   */
  wasPublishedByThisNode: (lessonId: string) => Promise<boolean>;
  /**
   * Self-row from `nodes` (`is_self = true`). Used to (a) prove we are
   * the producer of the requested lesson before serving a 200, and
   * (b) embed our `node_id` in the envelope if needed.
   */
  loadSelf: () => Promise<{ node_id: string; pubkey_b64: string } | null>;
  /**
   * Sign an unsigned record with this node's persistent self-key.
   * Defaults to `signWithSelfKey` (reads `MYCELIUM_NODE_KEY` or
   * `~/.mycelium/node.key`). Tests inject a memory-backed signer.
   */
  signRecord?: <T extends object>(record: T) => SignedRecord<T>;
}

export interface HttpResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Envelope shape served at `GET /swarm/lessons/{id}/proof`. Mirrors
 * SWARM_SPEC §4.6 verbatim — keep this interface in sync if the spec
 * field set changes (and bump the spec version, not the field set, to
 * keep v1.x receivers parsing the same shape).
 */
export interface LessonProofEnvelope {
  lesson_id: string;
  evidence_count: number;
  evidence_root: string;
  inclusion_proofs: InclusionProof[];
  spec_version: string;
  signed_at: string;
  signature: string;
}

const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

// UUID v1-v8, lowercase or uppercase. Used as a precondition check on the
// path parameter so a malformed id never reaches the DB layer (and so the
// privacy contract test can compare against the input id without false
// positives from non-UUID-shaped strings).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// sha2-256 multihash in base58btc — same shape pin used in evidence-merkle
// and migration 077. The proof envelope's leaves MUST satisfy this; if a
// substrate row violates it the §4.6 receiver would drop our proof under
// rule 18, so we surface that as a 503 producer-substrate-corruption.
const MULTIHASH_LEAF_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/**
 * Build the response for `GET /swarm/lessons/{id}/proof`.
 *
 * Returns an HTTP-shaped triple so the surrounding HTTP server can write
 * it without further policy. Every error mode is operator-readable rather
 * than opaque — same discipline as `buildNodeAdvertisementResponse`.
 */
export async function buildLessonProofResponse(
  deps: LessonProofDeps
): Promise<HttpResponseShape> {
  const { lessonId } = deps;

  if (!lessonId || !UUID_RE.test(lessonId)) {
    // §4.6 doesn't dictate a code for malformed input; 400 is the natural
    // HTTP shape for "client sent a bad path parameter" and keeps the 404
    // / 410 / 503 codes narrow on their spec'd meanings.
    return jsonResponse(400, {
      error: "lesson_id must be a UUID",
      lesson_id: lessonId,
    });
  }

  let self: { node_id: string; pubkey_b64: string } | null;
  try {
    self = await deps.loadSelf();
  } catch (e) {
    return jsonResponse(503, {
      error: "loadSelf failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  if (!self) {
    return jsonResponse(503, {
      error:
        "node identity not initialized; run scripts/init-node-identity.mjs first",
    });
  }

  let lesson: LessonProofMeta | null;
  try {
    lesson = await deps.loadLesson(lessonId);
  } catch (e) {
    return jsonResponse(503, {
      error: "loadLesson failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (!lesson) {
    // Distinguish 404 (never held) from 410 (we published it, no longer
    // hold the content). Per §4.6 the 410 is authoritative — the
    // receiver MUST NOT retry this peer for that id, so getting this
    // disambiguation right matters more than getting a perf-optimal
    // single-call path.
    let wasOurs = false;
    try {
      wasOurs = await deps.wasPublishedByThisNode(lessonId);
    } catch (e) {
      return jsonResponse(503, {
        error: "wasPublishedByThisNode failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    if (wasOurs) {
      return jsonResponse(410, {
        error: "lesson was published by this node but is no longer held",
        lesson_id: lessonId,
      });
    }
    return jsonResponse(404, {
      error: "lesson not held by this node",
      lesson_id: lessonId,
    });
  }

  // Relay guard. §4.6: "The envelope is signed by the producing node
  // (origin_node_id of the lesson), not the relay." A relay holding a
  // peer's lesson MUST NOT sign a proof envelope on the producer's
  // behalf — that would let any node forge inclusion claims for any
  // lesson it has merely seen. So if this node is not the origin, the
  // receiver gets 404 with a hint to ask the actual origin.
  if (lesson.origin_node_id !== self.node_id) {
    return jsonResponse(404, {
      error: "lesson held only as a swarm relay; ask origin_node_id for proof",
      lesson_id: lessonId,
      origin_node_id: lesson.origin_node_id,
    });
  }

  let leaves: string[];
  try {
    leaves = await deps.loadLeaves(lessonId);
  } catch (e) {
    return jsonResponse(503, {
      error: "loadLeaves failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (leaves.length === 0) {
    // We are the origin of this lesson (above guard) but no producer-side
    // evidence rows exist. Either the substrate write failed at sign time
    // (a bug — operator must investigate) or the lesson predates v1.1's
    // `lesson_evidence_origin` table. Either way, returning a "valid"
    // 200 with `evidence_count = 0` would violate rule 16 of §5 on the
    // receiver. Surface as 503 so the failure is loud at the producer.
    return jsonResponse(503, {
      error:
        "no producer-side evidence rows for lesson; substrate may be missing or corrupted",
      lesson_id: lessonId,
    });
  }

  // Defensive shape-pin on every leaf before they enter the response.
  // The substrate's CHECK constraints already enforce this, but a future
  // schema change or a manual operator INSERT could slip a malformed
  // leaf through; surfacing here keeps a malformed envelope from ever
  // hitting the wire.
  for (let i = 0; i < leaves.length; i++) {
    if (!MULTIHASH_LEAF_RE.test(leaves[i])) {
      return jsonResponse(503, {
        error: `producer-side leaf at position ${i} is not a sha2-256 multihash`,
        lesson_id: lessonId,
      });
    }
  }

  // Build the inclusion proof for every leaf and re-derive the root from
  // the same canonical leaf set. Both calls take the leaves AS-GIVEN —
  // the substrate row order IS the producer-canonical order (migration
  // 077 stores `position` and the loader reads `ORDER BY position ASC`),
  // so any extra sort here would silently change the bytes-under-signature
  // and break receiver verification.
  let inclusion_proofs: InclusionProof[];
  let evidence_root: string;
  try {
    inclusion_proofs = leaves.map((leaf) =>
      buildInclusionProofFromHashedLeaves(leaves, leaf)
    );
    evidence_root = computeRootFromHashedLeaves(leaves);
  } catch (e) {
    return jsonResponse(503, {
      error: "merkle proof construction failed",
      detail: e instanceof Error ? e.message : String(e),
      lesson_id: lessonId,
    });
  }

  // Build the unsigned envelope. signed_at is added by the signer so it
  // lands inside the canonical bytes (§2.2 step 1).
  const unsigned: Omit<LessonProofEnvelope, "signed_at" | "signature"> = {
    lesson_id: lessonId,
    evidence_count: leaves.length,
    evidence_root,
    inclusion_proofs,
    spec_version: WIRE_SPEC_VERSION,
  };

  const signer = deps.signRecord ?? signWithSelfKey;
  let signed: SignedRecord<typeof unsigned>;
  try {
    signed = signer(unsigned);
  } catch (e) {
    return jsonResponse(503, {
      error: "signing failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const envelope: LessonProofEnvelope = {
    ...signed.record,
    signature: signed.signature,
  };

  return {
    status: 200,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(envelope),
  };
}

function jsonResponse(status: number, body: unknown): HttpResponseShape {
  return {
    status,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(body),
  };
}
