# SWARM_SPEC — wire-format spec for the decentralized mycelium swarm

**Spec version:** `1.1`
**Status:** phases 0–3 implemented on `main`; phase 4a (this doc) introduces
the Proof-of-Knowledge layer + self-healing immunity (§3.7, §4.6, §10);
phases 4b–9 still spec-only.
See [§9 Implementation status](#9-implementation-status) for the per-phase
mapping to merged commits.

**v1.1 additions (this revision):** five new signed fields on `Lesson` for
provenance commitment (`evidence_root`, `evidence_count`, `prev_lesson_hash`,
`maturity_age_days`, `useful_count`); a new `/swarm/lessons/{id}/proof`
endpoint for Merkle-inclusion verification without leaking raw episodes; a
new §10 specifying six consumer-side self-healing mechanisms that protect
the swarm against poisoned, plagiarized, and echo-chamber-amplified content.
All additions are backward-compatible per §1: v1.0 producers remain valid;
v1.1 producers are v1.0-readable but offer stronger guarantees.
**Audience:** anyone implementing a mycelium node — this repo, a port to
another language, or an independent peer that wants to be reachable by the
swarm.

---

## 0. Three unverletzliche Designprinzipien

These three principles are non-negotiable. Any change to this spec, or any
implementation of it, that weakens one of them is invalid and must be
rejected before merge.

1. **Souveränität.** Every node is owned and operated by its user.
   The swarm has no central authority. A node can be disconnected from the
   swarm at any moment and continue to function as a complete cognitive
   substrate. Federation is opt-in; offline is the default-correct state.

2. **Generalisierung-vor-Sharing.** Raw episodic memory never leaves the
   node. Only knowledge that has already been generalized inside the
   originating node — synthesized lessons, hub-anchor embeddings,
   signed metadata — is eligible for the wire. The producing node decides
   what is general enough to share; consumers cannot pull raw episodes.

3. **Diversität.** The swarm's value is the spread of lived experience
   across nodes, not the average. Sync protocols, trust functions, and any
   future ranking machinery must preserve heterogeneity. Convergence
   pressure (e.g. "everyone keeps the most-popular lesson") is an
   anti-goal.

These mirror the project's [`CONSTITUTION.md`](../CONSTITUTION.md) and the
*Schwarm-These* memory (`3acb8bb1-f374-436c-a3db-df2af9e50a83`).

---

## 1. Spec versioning

- The current spec version is the string `"1.0"`.
- Every signed wire record and every `NodeAdvertisement` MUST carry a
  `spec_version` field.
- Version negotiation between two nodes is **strict equality on the
  major component** for v1: a node implementing `"1.x"` MUST refuse to
  consume records whose `spec_version` major differs from its own. Minor
  bumps are reserved for backward-compatible additions (new optional
  fields, new endpoints, new rejection rules); a v1.1 node MUST still
  accept v1.0 records.
- The string format is `"<major>.<minor>"`, both decimal integers,
  no leading zeros, no whitespace. Future pre-release suffixes are out
  of scope for v1.
- Spec amendments are made by PR against this file; bumping `spec_version`
  is the same kind of change as a Constitution amendment in spirit and
  must explicitly justify why it does not weaken the three Designprinzipien
  above.

---

## 2. JSON Canonical Form

All signatures in this spec are computed over the **JSON Canonicalization
Scheme (JCS), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)**,
applied to the record with the `signature` field omitted.

JCS gives us a single deterministic byte sequence for any given JSON
value. The relevant rules, restated for implementer convenience:

- Object keys are sorted by **UTF-16 code unit** order (not Unicode code
  point, not byte order).
- Whitespace is removed; the encoding is the minimal compact form.
- Strings use UTF-8 with the JSON-mandated escapes; no extra escapes.
- Numbers are serialized using the **ECMAScript `Number.prototype.toString`**
  algorithm as required by JCS.
- The input is constrained to **I-JSON** (no duplicate keys, no NaN, no
  Infinity, no `-0` distinct from `0`).

### 2.1 Float embeddings under JCS — implementer warning

Embeddings are arrays of 768 IEEE-754 double-precision floats. JCS
serializes each via ECMAScript's number-to-string algorithm, which is
**not** the same as a language's default `printf("%g")` or
`json.dumps(float)`. Two implementations that round embeddings differently
before signing will produce different signatures over byte-identical
vectors.

Rules for v1:

- The producer MUST serialize each embedding component using a JCS-conformant
  number serializer. Reference implementations exist in JS
  ([`json-canonicalize`](https://www.npmjs.com/package/json-canonicalize)),
  Rust ([`serde_json_canonicalizer`](https://docs.rs/serde_json_canonicalizer/)),
  and others.
- Embeddings MUST be transmitted as full-precision floats (no pre-truncation
  to N decimal places). Truncating before signing is allowed, but the
  truncated value is then the signed value — receivers cannot distinguish.
- The producer MUST sign the canonical bytes, not the in-memory value.
- A receiver computes the canonical bytes from the received JSON, verifies
  the signature against those bytes, and only then trusts the parsed value.

### 2.2 Signing inputs

For a signed record `R`:

1. Take the JSON object `R'` = `R` with the `signature` key removed.
2. Compute `bytes = JCS(R')`.
3. `signature = base64(Ed25519_sign(node_private_key, bytes))`.
4. Re-attach `signature` to `R` for transport.

Verification is the inverse: strip `signature`, JCS the remainder, verify
against the producer node's published public key.

### 2.3 Signature algorithm

- v1 uses **Ed25519** exclusively (RFC 8032).
- Public keys are 32 raw bytes, transported as unpadded base64url in
  `pubkey` fields, padded base64 in `signature` fields. (The asymmetry is
  inherited from common library defaults; both encodings are valid base64
  variants and both are stable across implementations.)
- Key rotation is **out of scope for v1** (see §6).

---

## 3. Wire types

All wire types are JSON objects. Field types use the following shorthand:

| shorthand | meaning |
|---|---|
| `string` | UTF-8 string, no NUL bytes |
| `uuid` | RFC 4122 v4 UUID, lowercase, hyphenated, 36 chars |
| `iso8601` | RFC 3339 date-time, UTC (`Z` suffix), millisecond precision: `2026-04-27T18:31:33.183Z` |
| `int` | JSON number, integer, fits in int64, ≥ 0 unless noted |
| `float` | JSON number, IEEE-754 double, finite (no NaN/Inf) |
| `float[N]` | JSON array of exactly N `float` |
| `string[]` | JSON array of `string`, may be empty |
| `base64` | standard base64 with padding (RFC 4648 §4) |
| `base64url` | URL-safe base64 without padding (RFC 4648 §5) |
| `multihash` | self-describing hash per the multihash spec, base58btc-encoded; see §3.5 |
| `https-url` | absolute URL, scheme MUST be `https`, no fragment, no userinfo |

All timestamps in wire records are UTC. Local-zone timestamps are a v1
hard error (§5).

### 3.1 `Lesson`

A generalized piece of knowledge that the producing node has decided is
shareable. Lessons are the primary unit of swarm sync.

| field | type | required | meaning |
|---|---|---|---|
| `id` | `uuid` | yes | Lesson identity. Stable across re-publishes. |
| `content` | `string` | yes | The lesson text, in the producer's voice. ≤ 8 KiB UTF-8. |
| `embedding` | `float[768]` | yes | Embedding of `content` from the producer's local model (see §3.6). |
| `synthesized_from_cluster_size` | `int` | yes | Number of source episodes the producer condensed to make this lesson. ≥ 1. Provenance signal — receivers may weight by it. |
| `origin_node_id` | `string` (multihash) | yes | The producing node's `node_id` (§3.5). |
| `signed_at` | `iso8601` | yes | When the producer signed this record. |
| `signature` | `base64` | yes | Ed25519 signature over JCS(record − signature) using `origin_node_id`'s key. |
| `created_at` | `iso8601` | yes | When the lesson was first synthesized locally. May be earlier than `signed_at`. |
| `tags` | `string[]` | no | Free-form classification hints. Producers SHOULD keep ≤ 16 tags, each ≤ 64 chars. |
| `spec_version` | `string` | yes | Spec version this record conforms to (§1). |
| `evidence_root` | `string` (multihash) | yes (v1.1+) | Merkle root over the producer-local hashed experience IDs that ground this lesson. See §3.7. |
| `evidence_count` | `int` | yes (v1.1+) | Number of underlying experiences ≥ 1. MUST equal the count of leaves in the Merkle tree whose root is `evidence_root`. Verifiable via §4.6. |
| `prev_lesson_hash` | `string` (multihash) \| `null` | yes (v1.1+) | Multihash of this node's previous published lesson, forming a per-node commitment chain. `null` only for the very first lesson a node ever publishes. See §3.7. |
| `maturity_age_days` | `int` | yes (v1.1+) | Whole days between local `created_at` and `signed_at`. Receivers MAY use this as a producer-side "difficulty knob" (§3.7). |
| `useful_count` | `int` | yes (v1.1+) | How often this lesson was reinforced locally before this signing. ≥ 0. |

**Generalization rule.** A `Lesson` MUST NOT be a verbatim copy of a single
episode. Producers MUST satisfy `synthesized_from_cluster_size ≥ 2` OR
have a documented synthesis step that demonstrably abstracts (e.g. a REM
synthesizer call). This is the on-wire enforcement of Designprinzip 2.

**v1.0 → v1.1 compatibility.** A v1.0 receiver consuming a v1.1 record
MUST tolerate the five new fields (per §1, minor bumps are additive).
A v1.1 receiver MAY downgrade-accept v1.0 records but MUST mark them
internally as `evidence_unverifiable=true`; such records MUST NOT be
re-broadcast under §10.6 two-tier pinning.

### 3.2 `HubAnchor`

A signed pointer to a region of embedding-space where the producing node
has high local activity ("a hub I have a lot to say about"). Used by
peers to discover whose lessons are likely to cover a given topic.

| field | type | required | meaning |
|---|---|---|---|
| `embedding` | `float[768]` | yes | Centroid of the hub region, in the producer's embedding space. |
| `hub_score` | `float` | yes | 0..1, the producer's internal centrality measure for this hub. Comparison across nodes is not guaranteed (§3.6). |
| `local_memory_count` | `int` | yes | Number of local memories aggregated into this anchor. ≥ 1. |
| `topic_label` | `string` | no | Short human-readable label, ≤ 256 chars. Hint only — not a key. |
| `origin_node_id` | `string` (multihash) | yes | Producing node. |
| `signed_at` | `iso8601` | yes | Signing time. |
| `signature` | `base64` | yes | Ed25519 over JCS(record − signature). |
| `spec_version` | `string` | yes | Spec version. |

`HubAnchor` does not carry any episode content — only the centroid and
counts. It is a pointer, not data.

### 3.3 `NodeAdvertisement`

A node's self-description, served at `/.well-known/mycelium-node` (§4) and
relayed via `/swarm/peers`.

| field | type | required | meaning |
|---|---|---|---|
| `node_id` | `string` (multihash) | yes | The node's identity. MUST equal `multihash(pubkey)` (§3.5). |
| `pubkey` | `base64url` | yes | Ed25519 public key, 32 raw bytes, unpadded base64url. |
| `display_name` | `string` | no | Human-friendly label, ≤ 64 chars. |
| `endpoint_url` | `https-url` | yes | Base URL where this node's swarm endpoints (§4) are served. |
| `spec_version` | `string` | yes | Highest spec version the node implements. |
| `signed_at` | `iso8601` | yes | Signing time. |
| `signature` | `base64` | yes | Ed25519 over JCS(record − signature). |

Self-signing is required: the advertisement is signed by the same key it
declares. Verification therefore needs no out-of-band trust root.

### 3.4 `TrustEdge` (local-only)

Trust is **local state**, never shared on the wire. It is specified here
so all implementations agree on its shape.

| field | type | required | meaning |
|---|---|---|---|
| `truster_node_id` | `string` (multihash) | yes | The node whose opinion this is (= the local node). |
| `trustee_node_id` | `string` (multihash) | yes | The node being rated. |
| `weight` | `float` | yes | 0..1. 0 = ignore everything from `trustee`, 1 = full weight. |
| `reason` | `string` | yes | Free-form, ≤ 512 chars. Auditable note for the user. |
| `updated_at` | `iso8601` | yes | Last change. |

A node MAY expose its trust list to its operator (the user who owns the
node) but MUST NOT expose it across the wire. There is intentionally no
HTTP endpoint that returns `TrustEdge` records (§4).

### 3.5 `node_id` — multihash of the public key

`node_id` is a self-certifying identifier:

```
node_id = base58btc( multihash( sha2-256, pubkey_raw_bytes ) )
```

per the [multihash](https://multiformats.io/multihash/) spec, function
code `0x12` (sha2-256), digest length 32. This makes a node's address
verifiable without consulting any registry: you can hash the `pubkey`
field of a `NodeAdvertisement` and check it matches `node_id`.

### 3.6 Embedding model

v1 fixes the embedding to **768-dimensional `nomic-embed-text`** vectors
(matching the local Ollama model already used by mycelium). All wire
records carrying an `embedding` field MUST use this model.

This is a hard constraint, not a hint: cross-model embeddings are
geometrically incomparable and would silently degrade `HubAnchor`
matching. Mixing models is out of scope for v1; v2 will define a
`embedding_model_id` field and per-model index segregation.

### 3.7 Proof-of-Knowledge — provenance commitment for `Lesson` (v1.1)

The five v1.1 `Lesson` fields (`evidence_root`, `evidence_count`,
`prev_lesson_hash`, `maturity_age_days`, `useful_count`) implement a
**Proof-of-Knowledge** layer analogous to Bitcoin's Proof-of-Work — but
with *lived experience over time* as the scarce resource instead of CPU
hashpower. The goals:

1. **Forge-resistance.** A node cannot produce a valid v1.1 lesson
   without backing it with experience-IDs it actually holds locally.
2. **Plagiarism-detection.** Re-signing another node's lesson under your
   own key requires a fake `evidence_root`, which fails the §4.6 challenge.
3. **Sybil-cost.** Spinning up N fake nodes does not give you N nodes'
   worth of valid lessons — each fake node would still need real local
   experience clusters to produce provable evidence.
4. **Tamper-evident history.** `prev_lesson_hash` chains a node's lessons
   into an append-only sequence; rewriting lesson N invalidates every
   subsequent hash for that node.

#### 3.7.1 Evidence Merkle tree

Producers compute `evidence_root` as the root of a binary Merkle tree
whose leaves are `multihash(sha2-256, experience_id_canonical_bytes)`,
sorted ascending. The tree uses RFC 6962 conventions:

- Leaf hash: `H(0x00 || hashed_experience_id)`
- Inner node hash: `H(0x01 || left_child || right_child)`
- Odd levels: the trailing leaf is duplicated (Bitcoin convention).

Because only **hashes** of experience IDs ever enter the tree, the
`evidence_root` field on the wire leaks zero raw episode content. This
is the cryptographic enforcement of Designprinzip 2.

#### 3.7.2 Per-node commitment chain

Every node maintains, locally, a strictly-ordered list of all lessons it
has ever published. The `prev_lesson_hash` of lesson L_n is
`multihash(sha2-256, JCS(L_{n-1} including its signature))`. The very
first lesson a node ever publishes has `prev_lesson_hash = null`.

Receivers MAY (but are not required to) reconstruct a producer's chain
by paginating `/swarm/lessons` ordered by `signed_at ASC` — peers
exposing a v1.1-compliant `/swarm/lessons` MUST emit chain-consistent
results (no gaps, no out-of-order hashes). Receivers that detect a
broken chain MUST treat all subsequent lessons from that origin as
`untrusted` until a signed re-anchor lesson appears.

#### 3.7.3 Difficulty knob (receiver-side, local policy)

A v1.1 receiver MAY enforce per-origin acceptance thresholds, e.g.:

```yaml
swarm.lesson_acceptance:
  min_evidence_count: 3
  min_maturity_age_days: 7
  min_useful_count: 2
  require_inclusion_proof_for_untrusted: true
```

This is **local policy**, not part of the wire contract. Two nodes with
different policies remain interoperable; they just accept different
fractions of each other's output. This mirrors Bitcoin's adjustable
difficulty target — no global consensus needed.

---

## 4. Endpoints

All endpoints are HTTP/1.1 or HTTP/2 over TLS (`https://`). No WebSocket,
no long-poll, no server push in v1. All response bodies are
`application/json; charset=utf-8`.

### 4.1 `GET /.well-known/mycelium-node`

Returns this node's `NodeAdvertisement`.

- **200**: body is a single `NodeAdvertisement` object.
- This endpoint is **unauthenticated** and **idempotent**. Every node
  exposes it. Discovery starts here.

### 4.2 `GET /swarm/peers`

Returns peers this node has chosen to relay. The list is the responding
node's curated view, not a global directory.

- **200**: body is `{ "peers": NodeAdvertisement[], "signed_at": iso8601, "signature": base64, "origin_node_id": string }`.
- The wrapping envelope itself is signed by the responding node so the
  receiver can attribute the curation choice.
- A node SHOULD NOT include peers it does not currently trust (`TrustEdge.weight = 0`).
- Pagination is out of scope for v1; if the list grows past one response,
  a v1 node MAY truncate and the receiver MUST tolerate truncation.

### 4.3 `GET /swarm/lessons`

Returns signed `Lesson` records.

Query parameters:

| name | required | type | meaning |
|---|---|---|---|
| `since` | no | `iso8601` | Only lessons with `signed_at > since`. Default: epoch. |
| `topic` | no | `base64url` of `float[768]` packed as little-endian float64 | Only lessons whose `embedding` cosine-distance to `topic` is below the responder's local threshold. Encoding: 768 × 8 = 6144 bytes → 8192 base64url chars. |
| `limit` | no | `int` | Max lessons. Default 100. Hard cap 1000. |

- **200**: body is `{ "lessons": Lesson[], "spec_version": string }`.
- Each `Lesson` is independently signed by its `origin_node_id`. The
  responding node MAY relay lessons it received from peers; the
  signature is what authorizes consumption, not the transport.
- **400**: malformed `topic` (wrong length, not base64url, etc.).

### 4.4 `GET /swarm/hubs`

Returns signed `HubAnchor` records produced by this node.

- **200**: body is `{ "hubs": HubAnchor[], "spec_version": string }`.
- v1 does not specify topic-filtered hub queries; the list is small by
  construction (one anchor per high-centrality cluster).

### 4.5 Common HTTP behavior

- `Content-Type` on all responses: `application/json; charset=utf-8`.
- `Cache-Control: no-store` on `NodeAdvertisement` responses
  (`signed_at` is observable).
- Rate limiting is implementation-defined. A v1 node MAY return **429**;
  receivers MUST tolerate it.
- Auth between peers: TLS only in v1. Per-request auth (HTTP Signatures,
  capabilities, etc.) is out of scope.

### 4.6 `GET /swarm/lessons/{id}/proof` (v1.1)

Returns Merkle-inclusion proofs for the `evidence_root` of a previously
served `Lesson`. Used by receivers to verify the §3.7 commitment
without ever seeing raw episode content.

- **200**: body is

  ```json
  {
    "lesson_id": "uuid-of-the-lesson",
    "evidence_count": 17,
    "evidence_root": "<multihash repeated from the lesson>",
    "inclusion_proofs": [
      {
        "hashed_experience_id": "<multihash sha2-256>",
        "merkle_path": ["<sibling_hash>", "..."]
      }
    ],
    "spec_version": "1.1",
    "signed_at": "2026-04-30T01:00:00Z",
    "signature": "<envelope signed by origin_node_id>"
  }
  ```

- The number of `inclusion_proofs` MUST equal `evidence_count` from the
  lesson body. Each `merkle_path` MUST reconstruct `evidence_root` when
  combined with `hashed_experience_id` per the §3.7.1 hashing rules.
- **404**: lesson with that `id` is not held by this node. Receivers
  may try another peer.
- **410**: lesson with that `id` was published by this node but has
  since been forgotten or superseded. Treated as authoritative — do
  not retry against this peer for this id.
- The envelope is signed by the **producing node** (`origin_node_id` of
  the lesson), not the relay. Receivers MUST verify both the lesson
  signature and the proof envelope signature against the same key.
- Receivers MAY treat absence of a `/swarm/lessons/{id}/proof` response
  (404 from origin, not relay) as a §10.1 reputation-decay event for
  that origin.

---

## 5. Rejection rules

A receiving node MUST reject an incoming record before it influences any
local decision (recall ranking, hub-matching, peer selection, …) if any
of the following holds. All implementations MUST agree on this list.

1. **Wrong `spec_version` major.** `spec_version` major differs from the
   receiver's implemented major (§1). → drop, do not log content.
2. **Missing required field.** Any field marked "required" in §3 absent
   or `null`. → drop.
3. **Type mismatch.** Field present but wrong JSON type
   (e.g. `local_memory_count` is a string). → drop.
4. **Embedding shape mismatch.** `embedding` not exactly 768 elements,
   or contains non-finite values. → drop.
5. **Bad signature.** JCS-recompute + Ed25519-verify against the
   declared `origin_node_id`'s public key fails. → drop.
6. **`origin_node_id` ≠ multihash(pubkey)** for `NodeAdvertisement`. → drop.
7. **Future-dated.** `signed_at > now + 5 minutes` (clock skew tolerance). → drop.
8. **Stale-dated.** `signed_at < now − 90 days` for `Lesson` and
   `HubAnchor`. v1 treats long-stale records as expired even if the
   signature verifies. (Operational rationale: protects against replay of
   superseded snapshots; the producing node will re-sign current records.)
9. **`signed_at < created_at`** for `Lesson`. → drop.
10. **Duplicate `id`** with a different `signature` for the same
    `origin_node_id` and the same `signed_at`. → drop the later-arriving
    one and flag the producer.
11. **`Lesson` violates Generalization rule.**
    `synthesized_from_cluster_size < 2`. → drop. (v1 enforces the floor
    on the wire; the documented-synthesis-step exemption from §3.1 is a
    producer-side rule, not visible on the wire, and v2 will add an
    explicit `synthesis_method` field for it.)
12. **`content` over size limit** (`Lesson.content` > 8 KiB,
    `HubAnchor.topic_label` > 256 chars, `NodeAdvertisement.display_name` > 64). → drop.
13. **`endpoint_url` not `https`** in a `NodeAdvertisement`. → drop.
14. **Trust `weight` of 0** on the producer (local trust). → silently
    drop, no log.
15. **Body too large.** Receivers MAY enforce a body cap (recommended:
    16 MiB for `/swarm/lessons` responses); records over the cap are
    treated as a transport error, not a content-rejection — the receiver
    SHOULD retry with a smaller `limit`.

**v1.1 additions (Proof-of-Knowledge — apply only to records with
`spec_version >= "1.1"`):**

16. **`evidence_count < 1`** for a `Lesson`. → drop. (Rule 11 still
    applies as the floor; rule 16 is the additional integrity check
    that the count is sane.)
17. **`evidence_count` does not match the leaf count** when a
    `/swarm/lessons/{id}/proof` response is fetched and validated. → drop
    the lesson, log the discrepancy, mark origin for §10.1 decay.
18. **Merkle root mismatch.** Reconstructing `evidence_root` from any
    fetched proof yields a different value. → drop, log, §10.1.
19. **Broken commitment chain.** `prev_lesson_hash` does not match
    `multihash(JCS(L_{n-1}))` when the receiver has L_{n-1} cached. →
    drop the new lesson AND quarantine the origin per §10.2 (this is a
    history-rewrite signal, treated as severe).
20. **`maturity_age_days < 0`** or `useful_count < 0` or any of the
    five v1.1 fields present on a `spec_version="1.0"` record. → drop.
    (Cross-version field smuggling is forbidden.)

Records dropped under rules 1–20 SHOULD be counted in a local metric so
the operator can see when a peer is misbehaving. Trust adjustments based
on rejection counts are no longer "a v2 concern" — see §10.1.

---

## 6. Out of scope for v1

The following are intentionally **not** part of this spec. Implementations
MUST NOT extend the wire format with these features under the v1 banner;
they are reserved for v2.

- **NAT traversal** — v1 nodes are reachable only at routable HTTPS
  endpoints. Hole-punching, STUN/TURN, and relays are deferred.
- **libp2p / Kademlia DHT** — discovery in v1 is bootstrap-list +
  `/swarm/peers` gossip. No DHT.
- **WebSocket / server push** — pull-only. Receivers poll.
- **Key rotation** — `node_id` is permanent in v1; losing the key means
  losing the identity. v2 will define a rotation envelope.
- **Encrypted transport beyond HTTPS** — no end-to-end record encryption,
  no per-record secrecy. Records are signed, not encrypted.
- **Differential privacy / k-anonymity** on shared lessons — out of
  scope. The Generalization rule (§3.1) plus the §10 self-healing
  layer are the v1.1 privacy/integrity posture; differential privacy
  for lesson bodies is a v2 concern.
- **Per-request authentication** — TLS pins identity to endpoint, signed
  records pin identity to content. No bearer tokens, no HTTP Signatures.
- **Microtransactions** — Constitution Pillar 4 applies, but the v1
  wire has no economic envelope. v2 will add a payment-channel field.
- **Cross-model embeddings** — locked to 768-d nomic-embed-text in v1
  (§3.6).
- **Schema evolution within v1** — additive only via minor bumps; no
  field removals, no semantics changes.

---

## 7. Node-to-node interaction

```mermaid
sequenceDiagram
    autonumber
    participant A as Node A
    participant B as Node B (peer)

    Note over A: A wakes up, wants fresh lessons in topic T
    A->>B: GET /.well-known/mycelium-node
    B-->>A: NodeAdvertisement (signed by B)
    A->>A: verify multihash(B.pubkey) == B.node_id
    A->>A: check spec_version compatibility (§1)

    A->>B: GET /swarm/peers
    B-->>A: { peers: [...], signature: ... }
    A->>A: verify envelope signature against B's pubkey
    A->>A: queue new peers for later discovery

    A->>B: GET /swarm/lessons?since=T0&topic=base64url(T)&limit=100
    B-->>A: { lessons: [Lesson, Lesson, ...] }
    loop for each Lesson L
        A->>A: JCS-recompute L without signature
        A->>A: Ed25519 verify(L.signature, key=L.origin_node_id)
        A->>A: apply rejection rules §5
        alt all checks pass
            A->>A: ingest L (weighted by local TrustEdge for L.origin_node_id)
        else any check fails
            A->>A: drop L, increment local rejection counter
        end
    end

    A->>B: GET /swarm/hubs
    B-->>A: { hubs: [HubAnchor, ...] }
    A->>A: same verify-then-rank loop
```

Key invariants visible in the diagram:

- The transport-layer peer (B) is **not** trusted to vouch for content.
  Every lesson is verified against its **origin** node's key, regardless
  of who relayed it.
- Trust is applied **after** signature verification. A signature only
  proves provenance; weight is a local choice.
- A node never asks a peer for raw episodes — only for already-
  generalized `Lesson` and `HubAnchor` records (Designprinzip 2).

---

## 8. Constitution affirmation

This spec touches:

- **Pillar 1 — Decentralized, networked AI.** Reinforces it: discovery
  via `.well-known` + gossip, no central registry, every endpoint
  optional.
- **Pillar 3 — Swarm intelligence.** Reinforces it: `Lesson` and
  `HubAnchor` are the units that let many specialized nodes pool
  knowledge without flattening difference.
- **Pillar 6 — Cyber security.** Reinforces it: every record is signed,
  identity is self-certifying via multihash, transport is TLS-only,
  rejection rules are explicit and uniform.

No pillar is weakened. Pillars 2 (Reproduction), 4 (Microtransactions),
and 5 (Experts) are not touched by this spec and remain governed by their
respective subsystems and by future swarm phases.

---

## 9. Implementation status

Snapshot maintained alongside the spec — so a reader can tell at a glance
which sections are wired vs. still paper. Update this table whenever a
swarm-labelled phase merges to `main`.

| Phase | Spec section | Issue | Merged commit | Status |
|---|---|---|---|---|
| 0 — Wire-format spec | §0–§8 | [#74](https://github.com/Dewinator/mycelium/issues/74) | `2fef277` | ✅ on `main` |
| 1a — `node_identity` table (migration 070) | §3.1 | [#75](https://github.com/Dewinator/mycelium/issues/75) | `d21cfa3` | ✅ on `main` |
| 1b — `init-node-identity.mjs` + `node_identity_get` tool | §3.1 | [#76](https://github.com/Dewinator/mycelium/issues/76) | `1bfef41` | ✅ on `main` |
| 2 — `signature.ts` Ed25519 sign/verify over JCS | §2, §4 | [#77](https://github.com/Dewinator/mycelium/issues/77) | `39d3fde` | ✅ on `main` |
| 3a — `wire-types.ts` + JCS canonicalize helper | §2, §3 | [#85](https://github.com/Dewinator/mycelium/issues/85) | `329ce06` | ✅ on `main` |
| 3b — `wire-validator.ts` (rejection rules 1–13) | §5 | [#86](https://github.com/Dewinator/mycelium/issues/86) | `b1ec1ac` | ✅ on `main` |
| 3c — `GET /.well-known/mycelium-node` advertisement | §3.2 | [#87](https://github.com/Dewinator/mycelium/issues/87) | `be59267` | ✅ on `main` |
| 3d — Peer + signed-record storage (migration 071) | §6 | [#88](https://github.com/Dewinator/mycelium/issues/88) | `b0eca59` | ✅ on `main` |
| 4a — PoK + self-healing spec (v1.1) | §3.1, §3.7, §4.6, §5 (16–20), §10 | [#100](https://github.com/Dewinator/mycelium/issues/100) | `3292bd6` | ✅ on `main` |
| 4b — `wire-types.ts` v1.1 fields + JCS validator update | §3.1 | [#102](https://github.com/Dewinator/mycelium/issues/102) | — | ⏳ spec-only |
| 4c — Evidence Merkle builder service | §3.7.1 | [#103](https://github.com/Dewinator/mycelium/issues/103) | — | ⏳ spec-only |
| 4d — `prev_lesson_hash` chain table (migration 074) | §3.7.2 | [#104](https://github.com/Dewinator/mycelium/issues/104) | — | ⏳ spec-only |
| 4e — `/swarm/lessons/{id}/proof` endpoint | §4.6 | [#105](https://github.com/Dewinator/mycelium/issues/105) | — | ⏳ spec-only |
| 4f — TrustEdge auto-tuning + quarantine (migration 075) | §10.1, §10.2 | [#107](https://github.com/Dewinator/mycelium/issues/107) | — | ⏳ spec-only |
| 4g — ConscienceAgent contradicts-trigger | §10.3 | [#108](https://github.com/Dewinator/mycelium/issues/108) | — | ⏳ spec-only |
| 4h — REM self-audit pass | §10.5 | [#109](https://github.com/Dewinator/mycelium/issues/109) | — | ⏳ spec-only |
| 4i — Two-tier pinning + diversity policy (migration 078) | §10.4, §10.6 | [#114](https://github.com/Dewinator/mycelium/issues/114) | — | ⏳ spec-only |
| 5 — Outbound peer discovery / gossip client | §3, §7 | _not yet issued_ | — | ⏳ spec-only |
| 6 — Lesson publishing pipeline (producer side) | §4, §6 | _not yet issued_ | — | ⏳ spec-only |
| 7 — Lesson ingestion pipeline (consumer side) | §5, §7 | _not yet issued_ | — | ⏳ spec-only |
| 8 — `HubAnchor` exchange | §4 | _not yet issued_ | — | ⏳ spec-only |
| 9 — Diversity-preserving sync policy | §0.3, §10.4 | _not yet issued_ | — | ⏳ spec-only |

Phases 4b–9 are spec-only after this revision lands — the project's
current priority remains *Gehirn perfektionieren* (see [`CLAUDE.md` §
Roadmap (Reed 2026-04-26)](../CLAUDE.md)). The wire contract is frozen
at v1.1 so an independent implementer can already build a v1.1-equivalent
peer with full PoK and self-healing semantics, and be guaranteed to
remain compatible once 4b+ lands here.

---

## 10. Self-healing immunity (v1.1)

The §3.7 Proof-of-Knowledge layer establishes **provenance** — a lesson
is cryptographically traceable to a node that holds matching local
evidence. Provenance alone does not protect against:

- **Adversarial-but-valid lessons** — a node with real experiences may
  still publish maliciously framed conclusions.
- **Echo-chamber amplification** — multiple nodes re-publishing the
  same fabricated lesson make it look like consensus truth.
- **Slow-poisoning** — an attacker who accumulates real experiences
  over months and then publishes biased generalizations.

§10 specifies six **consumer-side** mechanisms that every v1.1 node MUST
implement. They run locally, never require central authority, and
together form the swarm's self-healing immune system. No mechanism
relies on any other node behaving correctly.

### 10.1 Reputation decay (TrustEdge auto-tuning)

A v1.1 node MUST maintain, for every `origin_node_id` it has ever
ingested from, a rolling **reputation score** updated nightly during
the existing REM cycle:

```
trust_edge.weight(origin) ←
    base_weight
  × successful_inclusion_proof_rate(origin, last_30d)
  × clamp(0, 1, avg_local_useful_count(origin) / threshold)
  × age_factor(origin)
```

`base_weight` defaults to 0.5 for new origins, 1.0 for operator-pinned
origins. The product is clamped to `[0, 1]`. Weight = 0 is effective
ignore. Weight changes MUST be recorded with a `reason` string in
`TrustEdge` (§3.4) so the operator can audit.

### 10.2 Quarantine

After **N consecutive rejections** under §5 rules 1–20 from the same
`origin_node_id`, the receiver MUST quarantine the origin for **K days**.
Quarantined origins are skipped on subsequent `/swarm/lessons` polls.
Default: `N = 5, K = 30`. Operator-overridable.

§5 rule 19 (broken commitment chain) is a **single-strike** trigger —
one occurrence quarantines the origin immediately, regardless of N,
because chain-rewriting is a definitionally adversarial act.

### 10.3 Contradicts-trigger (ConscienceAgent gate)

When two ingested lessons `L_a` (origin A) and `L_b` (origin B) satisfy
all of:

- `cosine_similarity(L_a.embedding, L_b.embedding) > 0.85` (same topic),
- the receiver detects polarity inversion in their content
  (implementation-defined — typically a small classifier or a
  contradiction-relation lookup), and
- both pass §5 rejection rules,

…the receiver MUST mark both as `tentative` and emit a
`memory_relations.type='contradicts'` edge. Neither lesson is eligible
for §10.6 Tier-A pinning until the conflict is resolved (by new
evidence, by an operator decision, or by REM-audit §10.5 falsifying one
of them).

### 10.4 Anti-echo-chamber (diversity policy)

Within any topic cohort the receiver tracks across its peer set, if the
**same lesson** (`id` match, OR `cosine_similarity > 0.95` AND
`evidence_count` similar AND `signed_at` within 7 days) is held by
**>80% of the cohort**, the receiver MUST decrease its local weight by
a factor of `(1 − over_concentration)` rather than increase it.

Rationale: high cross-cohort agreement on a v1.1 lesson without
independent evidence chains is more consistent with re-broadcast of a
plagiarized lesson than with independent corroboration. True
corroboration looks like *different* lessons reaching *similar*
conclusions through *different* `evidence_root`s.

### 10.5 REM self-audit

During each REM cycle (the existing nightly synthesis pass), every
swarm-imported lesson held in `tentative` state MUST be checked against
the local node's own experiences:

```
for each tentative L from origin O:
    local_evidence = recall(L.topic, scope='local-experiences-only')
    if local_evidence has high-confidence contradicting cluster:
        forget(L, reason='local-falsification')
        trust_edge.decrement(O, magnitude=local_confidence,
                             reason='audit-falsification')
        record_lesson(local-falsifying lesson, source_ids=local_evidence)
```

This makes lived experience the ultimate ground-truth filter. The
swarm cannot teach the node something its own life has falsified. The
falsifying lesson the node records becomes itself eligible for v1.1
publication, completing the self-correcting feedback loop.

### 10.6 Two-tier pinning policy

Every v1.1 receiver MUST classify each held lesson into exactly one tier:

- **Tier A — pinned.** Eligible for re-broadcast on this node's
  `/swarm/lessons`. Required: lesson was either generated locally by
  this node, OR ingested from the swarm AND independently corroborated
  by ≥ 2 of this node's local experiences via §10.5 self-audit.
- **Tier B — tentative.** Used at lower local weight. Includes
  contested lessons (§10.3) and freshly-ingested swarm lessons before
  audit. **MUST NOT be re-broadcast.** This is the firebreak that
  prevents the node from amplifying un-vetted content.

Tier transitions are append-only: a Tier-B lesson promoted to Tier-A
records the local evidence that justified the promotion. A Tier-A
lesson demoted by §10.5 falsification cannot be re-promoted without
new evidence.

### 10.7 Constitution mapping for §10

- **Pillar 1** (decentralized) — strengthened: every immune mechanism
  runs purely on local state, no peer-vouching required.
- **Pillar 3** (swarm intelligence) — strengthened: §10.4 actively
  preserves cohort diversity, the swarm-thesis-defining property.
- **Pillar 6** (cyber security) — strengthened: every documented
  attack class (forgery, plagiarism, sybil flood, echo-chamber,
  slow-poisoning) is now addressed by either §3.7 or §10 or both.
- Pillars 2, 4, 5 — untouched.
