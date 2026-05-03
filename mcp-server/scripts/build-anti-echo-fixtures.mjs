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
