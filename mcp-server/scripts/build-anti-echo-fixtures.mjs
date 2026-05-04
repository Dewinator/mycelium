// Anti-echo-chamber adversarial corpus — fixture builder.
//
// One-shot regenerator for the fixtures under
// `mcp-server/src/__tests__/fixtures/anti-echo/`. Composes the production
// `signature.ts` and `evidence-merkle.ts` (via `dist/`) so the
// canonicalization and Merkle algorithms are guaranteed identical to what
// the receiver runs at validation time — re-implementing either here would
// create a divergence surface (SWARM_SPEC §2.2 trust premise).
//
// Usage (assumes a fresh build of dist/):
//
//   cd mcp-server
//   npm run build
//   node scripts/build-anti-echo-fixtures.mjs
//
// The script is deterministic: Ed25519 signing is deterministic per
// RFC 8032, JCS canonicalization is deterministic per RFC 8785, and every
// timestamp / random-looking field below is a hard-coded constant. Re-running
// produces byte-identical JSON, so a no-op run leaves the working tree clean.
//
// `fixture-key.json` is generated ONCE and refused-overwrite on subsequent
// runs. The first generation captures a randomly-drawn Ed25519 keypair into
// a checked-in artifact, after which the keypair is treated as a fixed
// resource for the corpus. Regenerating it would invalidate every previously
// committed signed envelope.
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { sign } from "../dist/services/signature.js";
import { computeNodeId } from "../dist/services/node-identity.js";
import { hashExperienceId } from "../dist/services/evidence-merkle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "src",
  "__tests__",
  "fixtures",
  "anti-echo"
);
const KEY_FILE = path.join(FIXTURES_DIR, "fixture-key.json");
const PLAGIARISM_KEYS_FILE = path.join(
  FIXTURES_DIR,
  "cohort-keys-plagiarism.json"
);
const SYBIL_KEYS_FILE = path.join(
  FIXTURES_DIR,
  "cohort-keys-sybil-flood.json"
);
const ECHO_CHAMBER_KEYS_FILE = path.join(
  FIXTURES_DIR,
  "cohort-keys-echo-chamber.json"
);

// ---------------------------------------------------------------------------
// Step 1 — fixture-key.json (Ed25519, write-once).
// ---------------------------------------------------------------------------

function ensureFixtureKey() {
  if (fs.existsSync(KEY_FILE)) {
    return JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Last 32 bytes of the SPKI DER are the raw Ed25519 pubkey (RFC 8410 §4).
  const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const nodeId = computeNodeId(pubkeyRaw);

  const file = {
    comment:
      "Ed25519 fixture key for the anti-echo adversarial corpus. " +
      "FIXTURE-ONLY; never the production node identity. " +
      "Checked in so the regression suite is fully deterministic. " +
      "See ./README.md and docs/wave-4-anti-echo.md.",
    node_id: nodeId,
    pubkey_raw_b64: pubkeyRaw.toString("base64"),
    pubkey_b64url_unpadded: pubkeyRaw
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
    private_key_pem: pem,
  };
  fs.writeFileSync(KEY_FILE, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), KEY_FILE)} (node_id=${nodeId})`);
  return file;
}

const fixtureKey = ensureFixtureKey();
const PEM = fixtureKey.private_key_pem;
const NODE_ID = fixtureKey.node_id;

// Sanity: the PEM still corresponds to an Ed25519 key the runtime can use.
createPrivateKey(PEM);

// ---------------------------------------------------------------------------
// Step 1b — cohort-keys-plagiarism.json (3× Ed25519, write-once).
//
// §10.4 diversity is a *cross-peer* concentration signal — the receiver
// only counts a near-duplicate as "another peer" if it carries a distinct
// origin_node_id. Plagiarism therefore needs N≥3 distinct fixture keys.
// We keep them in a sibling file (not inline in the cohort fixture) so
// the JSON corpus stays human-scannable and the keys can be re-used by
// any future cohort row that wants to mimic an N-peer broadcast.
//
// Same write-once discipline as fixture-key.json: regenerating the keys
// would invalidate every committed cohort envelope's signature.
// ---------------------------------------------------------------------------

function ensurePlagiarismCohortKeys() {
  if (fs.existsSync(PLAGIARISM_KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(PLAGIARISM_KEYS_FILE, "utf8"));
  }
  const COHORT_SIZE = 3;
  const keys = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const nodeId = computeNodeId(pubkeyRaw);
    keys.push({
      node_id: nodeId,
      pubkey_raw_b64: pubkeyRaw.toString("base64"),
      pubkey_b64url_unpadded: pubkeyRaw
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      private_key_pem: pem,
    });
  }
  const file = {
    comment:
      "Ed25519 fixture keys for the plagiarism cohort (W4.1, §10.4 diversity " +
      "filter). FIXTURE-ONLY; never any production node identity. Each key " +
      "represents one peer in a synthetic N-peer cohort that the receiver " +
      "would treat as N distinct origins for the purpose of cross-peer " +
      "near-duplicate concentration. Checked in so the regression suite is " +
      "fully deterministic. See ./README.md and docs/wave-4-anti-echo.md.",
    keys,
  };
  fs.writeFileSync(PLAGIARISM_KEYS_FILE, JSON.stringify(file, null, 2) + "\n");
  console.log(
    `wrote ${path.relative(process.cwd(), PLAGIARISM_KEYS_FILE)} (${COHORT_SIZE} keys)`
  );
  return file;
}

const plagiarismCohortKeys = ensurePlagiarismCohortKeys();
for (const k of plagiarismCohortKeys.keys) {
  // Same sanity check as the single fixture key above.
  createPrivateKey(k.private_key_pem);
}

// ---------------------------------------------------------------------------
// Step 1c — cohort-keys-sybil-flood.json (10× Ed25519, write-once).
//
// Sybil-flood per docs/wave-4-anti-echo.md §"Corpus categories" requires
// M ≥ 10 sock-puppet keys all signing the same lesson within 7 days.
// Distinct file from plagiarism keys — sybil cohorts are a strictly larger
// scale and re-using the 3-key plagiarism file would silently weaken the
// "M ≥ 10" claim if a future refactor changes plagiarism's cohort size.
//
// Same write-once discipline as the other cohort key files: regenerating
// the keys would invalidate every committed sybil envelope's signature.
// ---------------------------------------------------------------------------

function ensureSybilCohortKeys() {
  if (fs.existsSync(SYBIL_KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(SYBIL_KEYS_FILE, "utf8"));
  }
  const COHORT_SIZE = 10;
  const keys = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const nodeId = computeNodeId(pubkeyRaw);
    keys.push({
      node_id: nodeId,
      pubkey_raw_b64: pubkeyRaw.toString("base64"),
      pubkey_b64url_unpadded: pubkeyRaw
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      private_key_pem: pem,
    });
  }
  const file = {
    comment:
      "Ed25519 fixture keys for the sybil-flood cohort (W4.1, §10.2 + §10.4). " +
      "FIXTURE-ONLY; never any production node identity. Each key represents " +
      "one sock-puppet peer in a synthetic M=10 cohort that the receiver would " +
      "treat as M distinct origins. Checked in so the regression suite is fully " +
      "deterministic. See ./README.md and docs/wave-4-anti-echo.md.",
    keys,
  };
  fs.writeFileSync(SYBIL_KEYS_FILE, JSON.stringify(file, null, 2) + "\n");
  console.log(
    `wrote ${path.relative(process.cwd(), SYBIL_KEYS_FILE)} (${COHORT_SIZE} keys)`
  );
  return file;
}

const sybilCohortKeys = ensureSybilCohortKeys();
for (const k of sybilCohortKeys.keys) {
  createPrivateKey(k.private_key_pem);
}

// ---------------------------------------------------------------------------
// Step 1d — cohort-keys-echo-chamber.json (5× Ed25519, write-once).
//
// Echo-chamber per docs/wave-4-anti-echo.md §"Corpus categories" requires
// a synthetic cohort where ≥80% re-broadcast the same lesson with
// **different** envelopes (legitimate-looking) but no independent
// `evidence_root`. We use the canonical "4 of 5 peers" case from
// rem-diversity.test.ts (over_concentration = 0.8, exactly the §10.4
// trigger boundary): 4 echoers + 1 dissenter. The dissenter is what
// distinguishes echo-chamber from sybil-flood — the cohort really does
// have a heterodox peer, and §10.4 still suppresses the consensus.
//
// Distinct file from plagiarism / sybil keys:
//   - Reusing them would silently couple the echo-chamber cohort size to
//     the other cohorts; a refactor that changed plagiarism's COHORT_SIZE
//     would change the §10.4 over_concentration the echo-chamber test
//     asserts on, weakening the boundary claim.
//   - The dissenter key is conceptually a different peer class (a genuine
//     heterodox node, not a sock-puppet). Naming the file after the
//     attack class makes that intent explicit.
//
// Same write-once discipline as the other cohort key files.
// ---------------------------------------------------------------------------

function ensureEchoChamberCohortKeys() {
  if (fs.existsSync(ECHO_CHAMBER_KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(ECHO_CHAMBER_KEYS_FILE, "utf8"));
  }
  const COHORT_SIZE = 5;
  const keys = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const nodeId = computeNodeId(pubkeyRaw);
    keys.push({
      node_id: nodeId,
      pubkey_raw_b64: pubkeyRaw.toString("base64"),
      pubkey_b64url_unpadded: pubkeyRaw
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
      private_key_pem: pem,
    });
  }
  const file = {
    comment:
      "Ed25519 fixture keys for the echo-chamber cohort (W4.1, §10.4 diversity " +
      "filter). FIXTURE-ONLY; never any production node identity. Five peers: " +
      "keys[0..3] are the four echoers re-broadcasting the consensus lesson with " +
      "shared evidence_root; keys[4] is the dissenter holding a heterodox lesson " +
      "with its own evidence_root and far embedding. The §10.4 over_concentration " +
      "= 4/5 = 0.8 (exact trigger boundary). Checked in so the regression suite is " +
      "fully deterministic. See ./README.md and docs/wave-4-anti-echo.md.",
    keys,
  };
  fs.writeFileSync(ECHO_CHAMBER_KEYS_FILE, JSON.stringify(file, null, 2) + "\n");
  console.log(
    `wrote ${path.relative(process.cwd(), ECHO_CHAMBER_KEYS_FILE)} (${COHORT_SIZE} keys)`
  );
  return file;
}

const echoChamberCohortKeys = ensureEchoChamberCohortKeys();
for (const k of echoChamberCohortKeys.keys) {
  createPrivateKey(k.private_key_pem);
}

// ---------------------------------------------------------------------------
// Step 2 — embedding fixture (768-d, deterministic).
//
// Receivers reject embeddings with the wrong dimension (rule 4). The exact
// values do not matter for the §10 mechanism the forgery fixture
// exercises; we use a deterministic ramp so the JSON stays diff-friendly.
// ---------------------------------------------------------------------------

function ramp768() {
  const arr = new Array(768);
  for (let i = 0; i < 768; i++) {
    // Small finite value distinct per index; magnitudes well below ±1 so
    // anyone reading the JSON can scan it visually without scientific notation.
    arr[i] = Number(((i + 1) / 1000).toFixed(6));
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Step 3 — forgery fixture.
//
// Per docs/wave-4-anti-echo.md §"Corpus categories":
//
//   "Lesson with valid envelope but evidence_root that does not hash the
//    cited evidence."
//
// The fixture is signature-valid (the producer holds the fixture key),
// but the evidence_root commits to bytes that bear no relationship to the
// experiences the producer would later be challenged to prove inclusion
// of (claimed_experience_ids). The receiver-side §3.7 PoK mechanism
// catches this when a /swarm/lessons/{id}/proof challenge comes back —
// rule 18 fires because the inclusion proofs over the cited experiences
// reconstruct a different root.
// ---------------------------------------------------------------------------

function buildForgeryFixture() {
  // Hard-coded, unrelated multihash. This is the multihash for the empty
  // string under sha2-256, base58btc-encoded — a perfectly well-formed
  // value that COULD have been a real evidence_root, but cannot match the
  // cited experiences below.
  //
  // sha2-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  // multihash    = 0x12 0x20 || digest
  // base58btc    = QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n
  const FORGED_EVIDENCE_ROOT = "QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n";

  const claimedExperienceIds = [
    "forgery-fixture-exp-001",
    "forgery-fixture-exp-002",
  ];

  // Defensive: if anyone ever changes hashExperienceId or the
  // claimedExperienceIds set such that they happen to reduce to
  // FORGED_EVIDENCE_ROOT, the forgery test would silently pass. Detect
  // that here at fixture-build time.
  const realLeaves = claimedExperienceIds.map(hashExperienceId).sort();
  if (realLeaves.includes(FORGED_EVIDENCE_ROOT)) {
    throw new Error(
      "forgery fixture invariant broken: a cited experience hashes to the forged evidence_root. Pick a different forged value."
    );
  }

  const envelope = {
    spec_version: "1.1",
    id: "11111111-2222-4333-8444-fffffffffff1",
    content:
      "Wave-4 forgery fixture: lesson body is well-formed, signed by the corpus fixture key, but the evidence_root commits to bytes the producer cannot prove inclusion of. See docs/wave-4-anti-echo.md.",
    embedding: ramp768(),
    synthesized_from_cluster_size: 2,
    origin_node_id: NODE_ID,
    created_at: "2026-05-01T00:00:00.000Z",
    signed_at: "2026-05-01T00:00:01.000Z",
    evidence_root: FORGED_EVIDENCE_ROOT,
    evidence_count: claimedExperienceIds.length,
    prev_lesson_hash: null,
    maturity_age_days: 1,
    useful_count: 0,
    // signature filled below
  };

  // Sign over JCS(envelope − signature). signature.ts strips it internally,
  // so attaching it after the fact is correct.
  const signature = sign(envelope, PEM);
  const signed = { ...envelope, signature };

  const fixture = {
    metadata: {
      category: "forgery",
      expected_outcome: "reject",
      // §10 metric block, doc/wave-4-anti-echo.md §"Metrics — what counts
      // as PASS": rejected forgeries should subtract producer reputation.
      // The exact magnitude is the receiver's policy; the harness asserts
      // sign and the order-of-magnitude band.
      expected_trust_delta: -0.05,
      owns_mechanism: "§3.7 PoK + §5 rule 18",
      comment:
        "Lesson with valid envelope signature but evidence_root that does not hash the cited evidence. Caught at /swarm/lessons/{id}/proof time: inclusion proofs over the producer's actual experiences reconstruct a different root, so rule 18 fires.",
    },
    envelope: signed,
    // Auxiliary, forgery-specific: experiences the producer would later be
    // expected to prove inclusion of. The harness reconstructs the proof
    // envelope at test-time and asserts rule 18 fires against the (forged)
    // evidence_root.
    claimed_experience_ids: claimedExperienceIds,
  };

  const outDir = path.join(FIXTURES_DIR, "forgery");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "evidence-root-mismatch.json");
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

buildForgeryFixture();

// ---------------------------------------------------------------------------
// Step 4 — plagiarism cohort fixture.
//
// Per docs/wave-4-anti-echo.md §"Corpus categories":
//
//   "N≥3 fixtures from N different fixture-keys, all carrying
//    cosine_similarity > 0.95, identical signed_at window, near-identical
//    text."
//
// Three signature-valid envelopes from three distinct fixture-key node IDs.
// Same content text + a deterministic embedding ramp with a tiny per-envelope
// perturbation, so the pairwise cosine_similarity stays well above the §10.4
// `p_duplicate_cosine` threshold (default 0.95) without being exactly 1.0
// (which would be a more obvious "literally same lesson" signal that the
// fixture is also testing the *near*-duplicate path, not just the
// trivially-identical one).
//
// All three envelopes share `evidence_count` and a `signed_at` window of a
// few seconds — both well within the §10.4 defaults
// (p_evidence_count_band=1, p_signed_at_window_d=7).
//
// The harness builds a synthetic `RemDiversityFinding` from this cohort
// and asserts `scoreFinding` clamps `local_weight` below the broadcast
// threshold (0.3). The §10.4 mechanism is REM-cycle, not admission-time;
// every envelope individually passes `validateWireRecord`. The defense is
// the cross-peer concentration check that fires AFTER admission.
// ---------------------------------------------------------------------------

function rampPerturbed(seed) {
  // Same shape as ramp768() but with a small, seed-dependent perturbation
  // applied to a fixed subset of components. The perturbation is an order
  // of magnitude smaller than the ramp values themselves, so:
  //   - cosine_similarity between any two perturbations stays > 0.95
  //   - the embedding bytes differ per envelope, so JCS canonicalization
  //     produces three distinct signatures (a real peer would not emit
  //     byte-identical envelopes — different signed_at alone changes
  //     signature too, but we want the embedding bytes themselves to
  //     differ so the test is robust to a future fixture refactor that
  //     normalises signed_at).
  const arr = new Array(768);
  for (let i = 0; i < 768; i++) {
    const base = (i + 1) / 1000;
    // Perturb only every 32nd index, by ±0.000005 * seed. Magnitude is
    // 100× smaller than `base` even for the smallest `base`, so cosine
    // remains essentially 1 - O(1e-7) per component.
    const perturb = i % 32 === 0 ? seed * 0.000005 : 0;
    arr[i] = Number((base + perturb).toFixed(6));
  }
  return arr;
}

function buildPlagiarismCohort() {
  const COHORT_SIZE = 3;
  const SHARED_CONTENT =
    "Wave-4 plagiarism cohort: three peers re-broadcast a near-duplicate lesson with no independent evidence chain. §10.4 should clamp local_weight below the broadcast firebreak. See docs/wave-4-anti-echo.md.";

  // All envelopes commit to the *same* well-formed evidence_root. §10.4
  // is content-agnostic about the root value (re-hashing evidence is §3.7);
  // a shared root across the cohort mirrors the "re-broadcast of a
  // plagiarized lesson" failure mode — independent peers would NOT arrive
  // at the same evidence_root through different evidence chains. We derive
  // it through `hashExperienceId` (production multihash code path) so the
  // value is a byte-valid base58btc sha2-256 multihash, indistinguishable
  // on the wire from a real Merkle root.
  const SHARED_EVIDENCE_ROOT = hashExperienceId(
    "plagiarism-cohort-shared-evidence-root"
  );

  const SHARED_EVIDENCE_COUNT = 4;

  // Tight signed_at window — three envelopes ~1s apart, well inside the
  // §10.4 default 7-day window.
  const BASE_SIGNED_AT_MS = Date.parse("2026-05-01T00:10:00.000Z");

  const envelopes = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const key = plagiarismCohortKeys.keys[i];
    const envelope = {
      spec_version: "1.1",
      // UUID v4-shaped, deterministic per cohort index.
      id: `22222222-3333-4444-8555-cccccccccc${i.toString().padStart(2, "0")}`,
      content: SHARED_CONTENT,
      embedding: rampPerturbed(i + 1),
      synthesized_from_cluster_size: 2,
      origin_node_id: key.node_id,
      created_at: new Date(BASE_SIGNED_AT_MS - 1000).toISOString(),
      signed_at: new Date(BASE_SIGNED_AT_MS + i * 1000).toISOString(),
      evidence_root: SHARED_EVIDENCE_ROOT,
      evidence_count: SHARED_EVIDENCE_COUNT,
      prev_lesson_hash: null,
      maturity_age_days: 1,
      useful_count: 0,
    };
    const signature = sign(envelope, key.private_key_pem);
    envelopes.push({ ...envelope, signature });
  }

  const fixture = {
    metadata: {
      category: "plagiarism",
      // §10.4 admits each envelope individually but clamps the cohort's
      // local_weight below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3) so none
      // of them re-broadcast. That is the `broadcast_suppressed` outcome.
      expected_outcome: "broadcast_suppressed",
      // §10.4 itself does not directly mutate trust edges — the trust
      // delta is incurred only when an operator escalates a flagged
      // diversity finding. A small negative scalar matches the
      // anchor-doc convention that defended-against attack classes
      // accrue some non-zero reputation cost over time; the harness
      // asserts only sign + order-of-magnitude band.
      expected_trust_delta: -0.01,
      owns_mechanism: "§10.4 diversity filter",
      comment:
        "Three signature-valid envelopes from three distinct fixture-key node IDs, near-identical embeddings (cosine > 0.95), identical content + evidence_root, signed within a 3-second window. Each envelope individually passes the wire validator. §10.4 cross-peer concentration check should clamp local_weight to a value below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3) so the cohort cannot re-broadcast.",
    },
    cohort_size: COHORT_SIZE,
    envelopes,
  };

  const outDir = path.join(FIXTURES_DIR, "plagiarism");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "identical-broadcast-cohort.json");
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

buildPlagiarismCohort();

// ---------------------------------------------------------------------------
// Step 5 — sybil-flood cohort fixture.
//
// Per docs/wave-4-anti-echo.md §"Corpus categories":
//
//   "M≥10 fixture-keys all signing the same lesson within 7 days; cohort
//    threshold should trip."
//
// Ten signature-valid envelopes from ten distinct sock-puppet fixture-key
// node IDs. Same content text + a deterministic embedding ramp with a
// per-envelope perturbation, so pairwise cosine_similarity stays well above
// the §10.4 `p_duplicate_cosine` threshold (0.95) without being exactly 1.0.
//
// Differences from the plagiarism cohort row:
//   - Cohort size 10× larger (M=10 vs N=3) — proves §10.4 scoring scales
//     with cohort_size and does not have an M-dependent escape hatch that
//     would let a larger sybil set slip past the firebreak.
//   - The §10.2 quarantine arm (the spec lists "§10.2 quarantine + §10.4")
//     is operator-driven multi-strike escalation: §10.2 quarantines after
//     N=5 consecutive *rejections* under §5 rules 1-20. A signature-valid
//     well-formed sybil envelope passes those rules, so admission-time
//     §10.2 does not fire on the cohort. The §10.2 arm of sybil-flood
//     therefore lives in W4.2/W4.3 (multi-node integration where the
//     operator escalates a flagged §10.4 finding into an M-way quarantine).
//     This is captured as a comment on the corresponding test, per the
//     issue #196 acceptance criterion that a deferred mechanism MUST be
//     flagged, never silently weakened.
//
// All M envelopes share `evidence_count` and a `signed_at` window of a
// few minutes — well within the §10.4 default `p_signed_at_window_d=7`.
//
// The harness builds a synthetic `RemDiversityFinding` from this cohort
// and asserts `scoreFinding` clamps `local_weight` below the broadcast
// threshold (0.3). The §10.4 mechanism is REM-cycle, not admission-time;
// every envelope individually passes `validateWireRecord`. The defense is
// the cross-peer concentration check that fires AFTER admission.
// ---------------------------------------------------------------------------

function buildSybilFloodCohort() {
  const COHORT_SIZE = 10;
  const SHARED_CONTENT =
    "Wave-4 sybil-flood cohort: ten sock-puppet peers re-broadcast the same lesson within minutes. §10.4 should clamp local_weight below the broadcast firebreak even at M=10 cohort size; the §10.2 quarantine arm is operator-driven multi-node escalation, deferred to W4.2/W4.3. See docs/wave-4-anti-echo.md.";

  // Same well-formed multihash discipline as the plagiarism cohort: derive
  // the shared evidence_root through `hashExperienceId` so the value is a
  // byte-valid base58btc sha2-256 multihash, indistinguishable on the wire
  // from a real Merkle root. The fact that all M envelopes commit to the
  // same root is exactly the "coordinated re-broadcast" signal §10.4 owns.
  const SHARED_EVIDENCE_ROOT = hashExperienceId(
    "sybil-flood-cohort-shared-evidence-root"
  );

  const SHARED_EVIDENCE_COUNT = 4;

  // Tight signed_at window — ten envelopes ~30s apart, well inside the
  // §10.4 default 7-day window.
  const BASE_SIGNED_AT_MS = Date.parse("2026-05-01T00:20:00.000Z");

  const envelopes = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const key = sybilCohortKeys.keys[i];
    const envelope = {
      spec_version: "1.1",
      // UUID v4-shaped, deterministic per cohort index.
      id: `33333333-4444-4555-8666-dddddddddd${i.toString().padStart(2, "0")}`,
      content: SHARED_CONTENT,
      // Re-use the plagiarism perturbation function — same shape, distinct
      // seed range (offset by the plagiarism size) so embeddings differ
      // byte-wise from any plagiarism envelope. Pairwise cosine within the
      // sybil cohort still stays > 0.95 by construction (the perturbation
      // is 5 orders of magnitude smaller than the ramp values).
      embedding: rampPerturbed(i + 100),
      synthesized_from_cluster_size: 2,
      origin_node_id: key.node_id,
      created_at: new Date(BASE_SIGNED_AT_MS - 1000).toISOString(),
      signed_at: new Date(BASE_SIGNED_AT_MS + i * 30 * 1000).toISOString(),
      evidence_root: SHARED_EVIDENCE_ROOT,
      evidence_count: SHARED_EVIDENCE_COUNT,
      prev_lesson_hash: null,
      maturity_age_days: 1,
      useful_count: 0,
    };
    const signature = sign(envelope, key.private_key_pem);
    envelopes.push({ ...envelope, signature });
  }

  const fixture = {
    metadata: {
      category: "sybil-flood",
      // §10.4 admits each envelope individually but clamps the cohort's
      // local_weight below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3) so none
      // of them re-broadcast. The §10.2 quarantine arm is operator-driven
      // multi-node escalation and deferred to W4.2/W4.3; only `broadcast_suppressed`
      // is the unit-testable §10 outcome at admission time.
      expected_outcome: "broadcast_suppressed",
      // Same convention as plagiarism: §10.4 itself does not directly
      // mutate trust edges. The negative scalar reflects the eventual
      // operator-driven reputation cost; harness asserts only sign +
      // order-of-magnitude band.
      expected_trust_delta: -0.02,
      owns_mechanism: "§10.2 quarantine + §10.4 diversity filter",
      comment:
        "Ten signature-valid envelopes from ten distinct sock-puppet fixture-key node IDs, near-identical embeddings (cosine > 0.95), identical content + evidence_root, signed within a 5-minute window. Each envelope individually passes the wire validator (§10.2 quarantine fires only on rejected lessons under §5 rules 1-20). §10.4 cross-peer concentration check should clamp local_weight to a value below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3) so the cohort cannot re-broadcast. The §10.2 quarantine arm of this row is operator-driven multi-node escalation — deferred to W4.2/W4.3 per the issue #196 deferral rule.",
    },
    cohort_size: COHORT_SIZE,
    envelopes,
  };

  const outDir = path.join(FIXTURES_DIR, "sybil-flood");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "coordinated-broadcast-cohort.json");
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

buildSybilFloodCohort();

// ---------------------------------------------------------------------------
// Step 6 — echo-chamber cohort fixture.
//
// Per docs/wave-4-anti-echo.md §"Corpus categories":
//
//   "Same lesson re-broadcast by ≥80% of a synthetic cohort with
//    **different** envelopes (legitimate-looking) but no independent
//    evidence_root."
//
// Five signature-valid envelopes from five distinct fixture-key node IDs.
// The first four are the echo-chamber: same content text + a deterministic
// embedding ramp with per-envelope perturbations (cosine > 0.95), shared
// evidence_root, distinct signed_at within a few minutes. The fifth is a
// dissenter — different content, different evidence_root, far-orthogonal
// embedding — to demonstrate the cohort really has heterodox dissent and
// not five sock-puppets.
//
// The §10.4 over_concentration computed by the production RPC is
// near_dup_origin_count / topic_cohort_size = 4 / 5 = 0.8, which is the
// canonical case rem-diversity.test.ts already exercises against the
// pure scoreFinding helper. The load-bearing claim of this row is that
// the dissenter's presence in the cohort does NOT save the consensus
// lesson from the §10.4 firebreak — once over_concentration ≥ 0.8, the
// new local_weight clamps strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST
// (0.3) regardless of how visible the dissent is.
//
// Differences from sybil-flood (the other §10.4-owning row):
//   - Cohort size 5 (canonical 4-of-5 rather than 10-of-10): tests the
//     §10.4 trigger boundary, not the saturation case.
//   - Heterogeneous cohort (4 echoers + 1 dissenter rather than 10
//     sock-puppets): the dissenter envelope's distinct evidence_root and
//     far-orthogonal embedding make the cohort indistinguishable from a
//     real "groupthink-with-some-pushback" peer set, which is exactly the
//     §10.4 attack model — organic-looking convergence, not coordinated
//     re-broadcast.
//
// All four echoer envelopes share `evidence_count` and a `signed_at`
// window of a few minutes — well within the §10.4 default
// `p_signed_at_window_d=7`. The dissenter has its own evidence_count and
// signed_at; it is a separate cohort member, not a copy.
// ---------------------------------------------------------------------------

function rampReversed() {
  // Reversed ramp: arr[i] = (768 - i) / 1000. Same per-component
  // magnitude profile as ramp768() but with the values in reverse order,
  // so the cosine_similarity between this and ramp768() is well below the
  // §10.4 `p_duplicate_cosine` (0.95) — about 0.50 by construction. The
  // dissenter therefore shares the same dimensionality and L2 norm as the
  // echoers (sanity-friendly for any future pre-flight assertion that the
  // cohort embeddings are normalised consistently) without being a
  // near-duplicate of any echoer.
  const arr = new Array(768);
  for (let i = 0; i < 768; i++) {
    arr[i] = Number(((768 - i) / 1000).toFixed(6));
  }
  return arr;
}

function buildEchoChamberCohort() {
  const COHORT_SIZE = 5;
  const ECHOER_COUNT = 4;
  const SHARED_ECHOER_CONTENT =
    "Wave-4 echo-chamber cohort: four peers re-broadcast a consensus lesson with no independent evidence chain, while one peer dissents with a heterodox lesson. §10.4 should clamp local_weight below the broadcast firebreak at over_concentration = 4/5 = 0.8 — the dissenter's presence MUST NOT save the consensus from the firebreak. See docs/wave-4-anti-echo.md.";

  // Echoers all share the same well-formed evidence_root — the "no
  // independent evidence_root" signal §10.4 names. Production peers that
  // independently arrived at this conclusion would not collide on a single
  // root; the collision is the structural fingerprint of re-broadcast.
  const SHARED_ECHOER_EVIDENCE_ROOT = hashExperienceId(
    "echo-chamber-cohort-shared-evidence-root"
  );

  // Dissenter has its own well-formed evidence_root — derived from a
  // distinct seed so the multihash is byte-distinct from the echoers'.
  const DISSENTER_EVIDENCE_ROOT = hashExperienceId(
    "echo-chamber-cohort-dissenter-evidence-root"
  );
  const DISSENTER_CONTENT =
    "Wave-4 echo-chamber dissenter: a single peer in the otherwise-converged cohort holds a heterodox lesson with its own evidence chain. Demonstrates the cohort has real diversity (4 of 5 = 80% concentration), not a 5-way sock-puppet set.";

  const SHARED_EVIDENCE_COUNT = 4;

  // Echoers: signed within a 3-minute window, well inside §10.4
  // `p_signed_at_window_d=7`.
  const BASE_SIGNED_AT_MS = Date.parse("2026-05-01T00:30:00.000Z");

  const envelopes = [];

  // Echoers — keys[0..3], shared content + evidence_root, near-duplicate embeddings.
  for (let i = 0; i < ECHOER_COUNT; i++) {
    const key = echoChamberCohortKeys.keys[i];
    const envelope = {
      spec_version: "1.1",
      // UUID v4-shaped, deterministic per cohort index. Echoer ids end in
      // 0e..0e+ECHOER_COUNT-1 to make the role visually scannable in JSON.
      id: `44444444-5555-4666-8777-eeeeeeeeee${i.toString().padStart(2, "0")}`,
      content: SHARED_ECHOER_CONTENT,
      // Re-use the perturbation function from the plagiarism / sybil
      // builders so the echo embedding shape matches the documented
      // near-duplicate profile (cosine > 0.95 within the echoers).
      // Distinct seed range (offset by 200) so embedding bytes differ from
      // every other cohort fixture and a future cross-cohort cosine sweep
      // does not accidentally couple them.
      embedding: rampPerturbed(i + 200),
      synthesized_from_cluster_size: 2,
      origin_node_id: key.node_id,
      created_at: new Date(BASE_SIGNED_AT_MS - 1000).toISOString(),
      signed_at: new Date(BASE_SIGNED_AT_MS + i * 60 * 1000).toISOString(),
      evidence_root: SHARED_ECHOER_EVIDENCE_ROOT,
      evidence_count: SHARED_EVIDENCE_COUNT,
      prev_lesson_hash: null,
      maturity_age_days: 1,
      useful_count: 0,
    };
    const signature = sign(envelope, key.private_key_pem);
    envelopes.push({ ...envelope, signature });
  }

  // Dissenter — keys[4], distinct content + evidence_root, reversed-ramp embedding.
  {
    const dissenterKey = echoChamberCohortKeys.keys[ECHOER_COUNT];
    const dissenterEnvelope = {
      spec_version: "1.1",
      id: "44444444-5555-4666-8777-ffffffffff04",
      content: DISSENTER_CONTENT,
      embedding: rampReversed(),
      synthesized_from_cluster_size: 2,
      origin_node_id: dissenterKey.node_id,
      created_at: new Date(BASE_SIGNED_AT_MS - 1000).toISOString(),
      // Signed at the very end of the echoer window so the spread test
      // covers the full cohort, not just the four echoers.
      signed_at: new Date(BASE_SIGNED_AT_MS + ECHOER_COUNT * 60 * 1000).toISOString(),
      evidence_root: DISSENTER_EVIDENCE_ROOT,
      evidence_count: SHARED_EVIDENCE_COUNT,
      prev_lesson_hash: null,
      maturity_age_days: 1,
      useful_count: 0,
    };
    const dissenterSignature = sign(dissenterEnvelope, dissenterKey.private_key_pem);
    envelopes.push({ ...dissenterEnvelope, signature: dissenterSignature });
  }

  const fixture = {
    metadata: {
      category: "echo-chamber",
      // §10.4 admits each envelope individually but clamps the consensus
      // lesson's local_weight below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3).
      // The dissenter is admitted normally; only the four echoers' lesson
      // is suppressed.
      expected_outcome: "broadcast_suppressed",
      // Same convention as plagiarism / sybil: §10.4 itself does not
      // directly mutate trust edges. The negative scalar reflects the
      // eventual operator-driven reputation cost of a flagged consensus
      // cluster; harness asserts only sign + order-of-magnitude band.
      expected_trust_delta: -0.01,
      owns_mechanism: "§10.4 diversity filter",
      comment:
        "Five signature-valid envelopes from five distinct fixture-key node IDs. envelopes[0..3] are echoers — same content text, shared evidence_root, near-identical embeddings (pairwise cosine > 0.95 within the echoer subset), signed within a 3-minute window. envelopes[4] is a dissenter — heterodox content, distinct evidence_root, reversed-ramp embedding (cosine ≈ 0.5 vs any echoer). §10.4 cross-peer concentration on the consensus lesson is 4/5 = 0.8 (exact trigger boundary). scoreFinding(prev=1.0, over=0.8) clamps new_weight to 0.2, strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3). The load-bearing claim is that the dissenter's presence in the cohort does NOT save the consensus from the firebreak — §10.4 is purely a function of over_concentration, not of cohort heterogeneity.",
    },
    cohort_size: COHORT_SIZE,
    envelopes,
  };

  const outDir = path.join(FIXTURES_DIR, "echo-chamber");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "consensus-with-dissent-cohort.json");
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}

buildEchoChamberCohort();
