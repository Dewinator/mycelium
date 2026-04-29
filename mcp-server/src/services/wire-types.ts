/**
 * Wire types — Swarm Phase 3a (issue #85).
 *
 * Type-and-canonicalization foundation for the swarm wire format defined
 * in docs/SWARM_SPEC.md §3. Every later wire-touching piece (validator,
 * HTTP handlers, peer storage) reuses the interfaces and helpers here.
 *
 * Scope discipline (issue #85 Hard constraints):
 *   - No runtime validator — that is Phase 3b.
 *   - No HTTP handlers — that is Phase 3c.
 *   - No DB / storage — that is Phase 3d.
 *   - No new runtime dependency: the JCS canonicalizer comes from
 *     services/signature.ts which already implements RFC 8785 in pure JS.
 */
import { canonicalize } from "./signature.js";

/**
 * Wire spec version this module conforms to.
 *
 * Per SWARM_SPEC §1, every signed wire record and every NodeAdvertisement
 * carries a `spec_version` field. Strict equality on the major component
 * (here `"1"`) is the v1 negotiation rule. Producers SHOULD stamp records
 * with this constant rather than a free-form string so a major bump is
 * a single edit, not a search-and-replace.
 *
 * v1.1 (sub-phase 4a, merged in PR #101) adds the Proof-of-Knowledge
 * fields on `Lesson` (`evidence_root`, `evidence_count`,
 * `prev_lesson_hash`, `maturity_age_days`, `useful_count`). The bump is
 * additive — minor bumps are reserved for backward-compatible additions
 * per §1, so v1.0 records remain ingestable on v1.1 nodes.
 */
export const WIRE_SPEC_VERSION = "1.1";

// ---------------------------------------------------------------------------
// Wire interfaces — SWARM_SPEC §3
//
// Field types follow the spec table verbatim. TypeScript cannot enforce
// some of the constraints (e.g. `float[768]` exact length, `≤ 8 KiB`,
// multihash format) — those are runtime rejection rules in §5 and live
// in Phase 3b's validator. Consumers of these interfaces should treat
// them as the *shape* contract, not the *validity* contract.
// ---------------------------------------------------------------------------

/**
 * Lesson — generalized knowledge eligible for the wire (SWARM_SPEC §3.1).
 *
 * Producers MUST satisfy `synthesized_from_cluster_size >= 2` OR document
 * an abstracting synthesis step; on-wire, the cluster-size floor is what
 * the validator (Phase 3b, rule 11) enforces.
 *
 * v1.1 fields (Proof-of-Knowledge — SWARM_SPEC §3.7):
 *   - `evidence_root`     Merkle root over hashed experience IDs (multihash).
 *   - `evidence_count`    Number of underlying experiences (≥ 1).
 *   - `prev_lesson_hash`  Multihash of this node's previous lesson, or null
 *                         for the first lesson a node ever publishes.
 *   - `maturity_age_days` Whole days between local `created_at` and `signed_at`.
 *   - `useful_count`      How often this lesson was reinforced before signing.
 *
 * The five v1.1 fields are typed `?` (optional) here so a v1.0 record
 * — which omits them — still satisfies the interface. The validator
 * (sub-phase 4b runtime, future PR; rules 16–20 in SWARM_SPEC §5) is
 * the place that enforces "MUST be present when spec_version >= 1.1"
 * and "MUST be absent when spec_version == 1.0" (cross-version field
 * smuggling is rule 20).
 */
export interface Lesson {
  id: string;
  content: string;
  embedding: number[];
  synthesized_from_cluster_size: number;
  origin_node_id: string;
  signed_at: string;
  signature: string;
  created_at: string;
  tags?: string[];
  spec_version: string;
  // v1.1 Proof-of-Knowledge fields (SWARM_SPEC §3.1, §3.7)
  evidence_root?: string;
  evidence_count?: number;
  prev_lesson_hash?: string | null;
  maturity_age_days?: number;
  useful_count?: number;
}

/**
 * HubAnchor — signed pointer to a region of embedding-space the producing
 * node has high local activity in (SWARM_SPEC §3.2).
 *
 * Carries no episode content — only the centroid, a producer-local
 * centrality score, and counts. `hub_score` is NOT comparable across
 * nodes (SWARM_SPEC §3.6 — embedding spaces are locked but centrality
 * computation is not).
 */
export interface HubAnchor {
  embedding: number[];
  hub_score: number;
  local_memory_count: number;
  topic_label?: string;
  origin_node_id: string;
  signed_at: string;
  signature: string;
  spec_version: string;
}

/**
 * NodeAdvertisement — a node's self-description (SWARM_SPEC §3.3).
 *
 * Self-signed: the advertisement is signed by the same key it declares,
 * so verification needs no out-of-band trust root. `node_id` MUST equal
 * `multihash(pubkey)` (rule 6 of §5).
 */
export interface NodeAdvertisement {
  node_id: string;
  pubkey: string;
  display_name?: string;
  endpoint_url: string;
  spec_version: string;
  signed_at: string;
  signature: string;
}

/**
 * TrustEdge — local-only trust state (SWARM_SPEC §3.4).
 *
 * Specified here so all implementations agree on its shape, but a node
 * MUST NOT expose this across the wire. Intentionally no `signature`
 * field: trust is the truster's private state, not a signed claim.
 */
export interface TrustEdge {
  truster_node_id: string;
  trustee_node_id: string;
  weight: number;
  reason: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// canonicalizeForSigning — strip-and-JCS in one helper
//
// This is the bytes-under-signature surface from SWARM_SPEC §2.2 step 2,
// exposed independently so the validator and the receive path can compute
// the canonical bytes without going through `sign`/`verify`. Returning
// Uint8Array (not a string) makes it explicit that the result is the
// signature input, not pretty-printable text.
// ---------------------------------------------------------------------------

/**
 * Compute the JCS bytes-under-signature for `record`.
 *
 * Steps (SWARM_SPEC §2.2):
 *   1. Drop the top-level `signature` field if present.
 *   2. JCS-canonicalize the remainder (RFC 8785).
 *   3. Encode as UTF-8 bytes.
 *
 * Two honest implementations of this function MUST produce byte-identical
 * output for the same input — that is the swarm trust premise. This
 * helper composes the same `canonicalize()` that `signature.ts` uses, so
 * any divergence between sign/verify and the validator is impossible by
 * construction.
 */
export function canonicalizeForSigning<
  T extends Record<string, unknown> & { signature?: string }
>(record: T): Uint8Array {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(
      "canonicalizeForSigning: input must be a JSON object (got " +
        (Array.isArray(record) ? "array" : typeof record) +
        ")"
    );
  }
  const { signature: _omit, ...rest } = record as Record<string, unknown>;
  return Buffer.from(canonicalize(rest), "utf8");
}

// ---------------------------------------------------------------------------
// kindOf — best-effort wire-type discriminator
//
// Required-field presence is enough to disambiguate the four kinds
// because their required-field sets are disjoint (TrustEdge has
// truster/trustee, NodeAdvertisement has pubkey, Lesson has
// synthesized_from_cluster_size, HubAnchor has hub_score). This is
// "best-effort" — it does not validate; a record that lies about its
// required fields is still kindOf's problem to disambiguate, but the
// validator (Phase 3b) is the one that decides whether to ingest.
// ---------------------------------------------------------------------------

export type WireKind =
  | "lesson"
  | "hub_anchor"
  | "node_advertisement"
  | "trust_edge";

/**
 * Best-effort discriminator over the four wire-type kinds.
 *
 * Returns the kind whose required-field signature is most-distinctly
 * present, or `null` if no kind matches. Order of checks matters only
 * for defensive disambiguation — TrustEdge first because its fields
 * are the most uniquely-named (truster_node_id / trustee_node_id);
 * NodeAdvertisement second because `pubkey` is unique to it; then
 * Lesson and HubAnchor by their unique numeric fields.
 *
 * NOT a validator: a record that passes `kindOf` may still be rejected
 * under SWARM_SPEC §5 (signature failure, embedding-shape mismatch,
 * size-limit overrun, etc.). Phase 3b owns those rules.
 */
export function kindOf(record: unknown): WireKind | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const r = record as Record<string, unknown>;

  if (
    typeof r.truster_node_id === "string" &&
    typeof r.trustee_node_id === "string" &&
    typeof r.weight === "number" &&
    typeof r.reason === "string" &&
    typeof r.updated_at === "string"
  ) {
    return "trust_edge";
  }

  if (
    typeof r.node_id === "string" &&
    typeof r.pubkey === "string" &&
    typeof r.endpoint_url === "string" &&
    typeof r.signed_at === "string"
  ) {
    return "node_advertisement";
  }

  if (
    typeof r.id === "string" &&
    typeof r.content === "string" &&
    typeof r.synthesized_from_cluster_size === "number" &&
    Array.isArray(r.embedding) &&
    typeof r.origin_node_id === "string"
  ) {
    return "lesson";
  }

  if (
    typeof r.hub_score === "number" &&
    typeof r.local_memory_count === "number" &&
    Array.isArray(r.embedding) &&
    typeof r.origin_node_id === "string"
  ) {
    return "hub_anchor";
  }

  return null;
}
