/**
 * Anti-echo-chamber adversarial corpus — plagiarism category (W4.1, issue #196).
 *
 * Asserts the §10.4 diversity filter clamps a cohort of N=3 near-duplicate
 * lessons (distinct origin_node_ids, identical content + evidence_root,
 * pairwise cosine_similarity > 0.95) below the broadcast firebreak
 * (`MIN_LOCAL_WEIGHT_FOR_BROADCAST = 0.3`). Cross-peer near-duplicate
 * concentration is the inverse of true corroboration: §10.4 defines the
 * latter as different lessons reaching similar conclusions through
 * *different* evidence chains, and treats near-byte-identical re-broadcast
 * across peers as a re-broadcast of plagiarized content rather than as
 * independent corroboration.
 *
 * Mechanics under test:
 *   - Each cohort envelope individually passes `validateWireRecord` —
 *     §10.4 is a post-admission, REM-cycle defense, not an admission-time
 *     hard rule. The wire validator never sees the cohort as a unit.
 *   - All envelope signatures verify against their cohort key (Pillar-6
 *     must pass before §10 fires, same invariant as the forgery row).
 *   - Pairwise cosine_similarity over the embeddings stays above the
 *     §10.4 default `p_duplicate_cosine` (0.95) — without this the
 *     diversity RPC would not flag the cohort.
 *   - All `signed_at` timestamps fall inside the §10.4 default
 *     `p_signed_at_window_d` (7 days).
 *   - `scoreFinding(prevWeight, finding)` from rem-diversity.ts —
 *     the pure decision layer the production REM cycle calls — clamps
 *     the new local_weight strictly below `MIN_LOCAL_WEIGHT_FOR_BROADCAST`
 *     for both the saturation case (over_concentration=1.0 → 0) and the
 *     boundary case (over_concentration=0.8 → 0.2 ≤ 0.3).
 *
 * Scope: this test exercises §10.4 via the pure scoreFinding decision
 * layer. The full RPC + `lesson_diversity_log` + `swarm_lessons.local_weight`
 * UPDATE chain is asserted in `migration-082-swarm-lesson-diversity.test.ts`
 * and `rem-diversity.test.ts`; the anti-echo corpus row asserts only the
 * §10 mechanism that owns the suppression decision. The full multi-node
 * trust-edge delta is asserted in the W4.3 campaign report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { verify } from "../services/signature.js";
import { validateWireRecord } from "../services/wire-validator.js";
import { cosineSimilarity } from "../services/lesson-contradiction-gate.js";
import {
  scoreFinding,
  type RemDiversityFinding,
} from "../services/rem-diversity.js";
import { MIN_LOCAL_WEIGHT_FOR_BROADCAST } from "../swarm/endpoints/lesson-feed.js";
import type {
  AntiEchoCohortFixture,
  AntiEchoFixtureMetadata,
} from "./fixtures/anti-echo/corpus-types.js";

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "__tests__",
  "fixtures",
  "anti-echo"
);

interface FixtureCohortKey {
  node_id: string;
  pubkey_raw_b64: string;
  private_key_pem: string;
}

interface CohortKeysFile {
  comment: string;
  keys: FixtureCohortKey[];
}

function loadCohortKeys(): CohortKeysFile {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, "cohort-keys-plagiarism.json"),
      "utf8"
    )
  );
}

function loadPlagiarismCohort(): AntiEchoCohortFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, "plagiarism", "identical-broadcast-cohort.json"),
      "utf8"
    )
  );
}

// ---------------------------------------------------------------------------
// (1) Metadata invariants
// ---------------------------------------------------------------------------

test("plagiarism cohort: metadata declares broadcast_suppressed + negative trust delta + §10.4 owner", () => {
  const fixture = loadPlagiarismCohort();
  const meta: AntiEchoFixtureMetadata = fixture.metadata;
  assert.equal(meta.category, "plagiarism");
  assert.equal(
    meta.expected_outcome,
    "broadcast_suppressed",
    "§10.4 admits each envelope and clamps local_weight below the broadcast firebreak — the broadcast_suppressed enum value"
  );
  assert.ok(
    meta.expected_trust_delta < 0,
    `expected negative trust delta for a defended-against attack class, got ${meta.expected_trust_delta}`
  );
  assert.match(
    meta.owns_mechanism,
    /§10\.4/,
    "owns_mechanism must name §10.4 so the corpus → spec linkage is greppable"
  );
});

test("plagiarism cohort: cohort_size matches envelopes.length and is ≥ §10.4 p_min_cohort_size (3)", () => {
  const fixture = loadPlagiarismCohort();
  // Cross-check defends against a copy-paste authoring error (cohort_size=10
  // declared, envelopes.length=2 in the file). The production §10.4 RPC
  // applies p_min_cohort_size=3 by default; below that, no finding is
  // emitted at all and the test would be silently dead.
  assert.equal(
    fixture.cohort_size,
    fixture.envelopes.length,
    "cohort_size must equal envelopes.length"
  );
  assert.ok(
    fixture.cohort_size >= 3,
    `cohort must be ≥ §10.4 default p_min_cohort_size=3, got ${fixture.cohort_size}`
  );
});

// ---------------------------------------------------------------------------
// (2) Pillar-6 — every envelope's signature verifies before §10 fires
// ---------------------------------------------------------------------------

test("plagiarism cohort: every envelope is signature-valid against its cohort key", () => {
  const fixture = loadPlagiarismCohort();
  const cohortKeys = loadCohortKeys();
  assert.equal(
    cohortKeys.keys.length,
    fixture.cohort_size,
    "cohort_keys file must have one key per cohort envelope"
  );
  for (let i = 0; i < fixture.envelopes.length; i++) {
    const envelope = fixture.envelopes[i];
    const key = cohortKeys.keys[i];
    assert.equal(
      envelope.origin_node_id,
      key.node_id,
      `envelope[${i}].origin_node_id must match cohort_keys[${i}].node_id`
    );
    const pubkey = new Uint8Array(Buffer.from(key.pubkey_raw_b64, "base64"));
    const ok = verify(envelope, envelope.signature, pubkey);
    assert.equal(
      ok,
      true,
      `envelope[${i}] signature must verify — plagiarism tests §10.4, not §3.7 wire-signature`
    );
  }
});

// ---------------------------------------------------------------------------
// (3) Wire validator — every envelope is independently admissible
// ---------------------------------------------------------------------------

test("plagiarism cohort: every envelope passes validateWireRecord (§10.4 is post-admission)", async () => {
  const fixture = loadPlagiarismCohort();
  const cohortKeys = loadCohortKeys();
  const pubkeyByNode = new Map<string, Uint8Array>();
  for (const k of cohortKeys.keys) {
    pubkeyByNode.set(
      k.node_id,
      new Uint8Array(Buffer.from(k.pubkey_raw_b64, "base64"))
    );
  }
  for (let i = 0; i < fixture.envelopes.length; i++) {
    const envelope = fixture.envelopes[i];
    const result = await validateWireRecord(envelope, "lesson", {
      ourSpecMajor: 1,
      now: new Date("2026-05-02T00:00:00Z"),
      getPubkeyForNode: (id) => pubkeyByNode.get(id) ?? null,
    });
    assert.deepEqual(
      result,
      { ok: true },
      `envelope[${i}] must pass the wire validator — §10.4 fires AFTER admission, not on individual envelopes`
    );
  }
});

// ---------------------------------------------------------------------------
// (4) §10.4 trigger conditions — embedding similarity + signed_at window
// ---------------------------------------------------------------------------

test("plagiarism cohort: pairwise cosine_similarity > 0.95 (§10.4 p_duplicate_cosine default)", () => {
  const fixture = loadPlagiarismCohort();
  const DUPLICATE_COSINE_THRESHOLD = 0.95;
  for (let i = 0; i < fixture.envelopes.length; i++) {
    for (let j = i + 1; j < fixture.envelopes.length; j++) {
      const cos = cosineSimilarity(
        fixture.envelopes[i].embedding,
        fixture.envelopes[j].embedding
      );
      assert.ok(
        cos > DUPLICATE_COSINE_THRESHOLD,
        `cosine(envelopes[${i}], envelopes[${j}]) = ${cos} must exceed §10.4 duplicate threshold ${DUPLICATE_COSINE_THRESHOLD} — without this the diversity RPC would not flag the cohort`
      );
    }
  }
});

test("plagiarism cohort: signed_at spread inside §10.4 p_signed_at_window_d (7 days)", () => {
  const fixture = loadPlagiarismCohort();
  const SIGNED_AT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const timestamps = fixture.envelopes
    .map((e) => Date.parse(e.signed_at))
    .sort((a, b) => a - b);
  const spread = timestamps[timestamps.length - 1] - timestamps[0];
  assert.ok(
    spread <= SIGNED_AT_WINDOW_MS,
    `signed_at spread ${spread}ms must fit inside §10.4 7-day window ${SIGNED_AT_WINDOW_MS}ms`
  );
});

test("plagiarism cohort: every envelope shares evidence_count and evidence_root (re-broadcast signature)", () => {
  const fixture = loadPlagiarismCohort();
  const counts = new Set(fixture.envelopes.map((e) => e.evidence_count));
  const roots = new Set(fixture.envelopes.map((e) => e.evidence_root));
  // §10.4 default `p_evidence_count_band=1` only matches if the counts
  // line up. A shared evidence_root is the byte-level "same lesson"
  // signal independent peers cannot reasonably have arrived at through
  // independent evidence chains — that's exactly the §10.4 failure mode
  // this row exists to defend against.
  assert.equal(
    counts.size,
    1,
    `evidence_count must be identical across the cohort, got ${[...counts].join(",")}`
  );
  assert.equal(
    roots.size,
    1,
    `evidence_root must be identical across the cohort (re-broadcast of one lesson body), got ${roots.size} distinct values`
  );
});

// ---------------------------------------------------------------------------
// (5) §10.4 decision layer — scoreFinding clamps below the broadcast firebreak
// ---------------------------------------------------------------------------

test("plagiarism cohort: scoreFinding at full saturation (over_concentration=1.0) silences the lesson", () => {
  const fixture = loadPlagiarismCohort();
  // Synthesize the RemDiversityFinding the production §10.4 RPC would
  // emit for this cohort: every cohort peer holds the near-duplicate, so
  // near_dup_origin_count == topic_cohort_size and over_concentration =
  // 1.0. The scoreFinding decision layer must then drop new_weight to 0
  // — the §10.4 invariant that "a 100%-concentrated cohort silences the
  // lesson entirely" (rem-diversity.ts §10.4 weight formula docstring).
  const finding: RemDiversityFinding = {
    swarm_lesson_id: fixture.envelopes[0].id,
    origin_node_id: fixture.envelopes[0].origin_node_id,
    swarm_lesson_text: fixture.envelopes[0].content,
    topic_cohort_size: fixture.cohort_size,
    near_dup_origin_count: fixture.cohort_size,
    over_concentration: 1.0,
    near_dup_lesson_ids: fixture.envelopes.map((e) => e.id),
  };
  const { new_weight, reason } = scoreFinding(1.0, finding);
  assert.equal(
    new_weight,
    0,
    "100%-concentrated cohort must silence the lesson (new_weight=0)"
  );
  assert.ok(
    new_weight < MIN_LOCAL_WEIGHT_FOR_BROADCAST,
    `new_weight ${new_weight} must be strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST (${MIN_LOCAL_WEIGHT_FOR_BROADCAST})`
  );
  assert.match(
    reason,
    /§10\.4/,
    "audit reason must self-describe with the spec section"
  );
});

test("plagiarism cohort: scoreFinding at boundary (over_concentration=0.8) still clamps below broadcast threshold", () => {
  const fixture = loadPlagiarismCohort();
  // Boundary case: over_concentration exactly at the §10.4 RPC trigger
  // (`p_over_concentration=0.8`). Even at this minimum-trigger value,
  // applied to a fresh lesson at prev_weight=1.0, new_weight = 1.0 *
  // (1 - 0.8) = 0.2 — strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST
  // (0.3). This is the load-bearing claim of §10.4: any finding at all
  // (not just full saturation) is enough to firebreak the cohort.
  const finding: RemDiversityFinding = {
    swarm_lesson_id: fixture.envelopes[0].id,
    origin_node_id: fixture.envelopes[0].origin_node_id,
    swarm_lesson_text: fixture.envelopes[0].content,
    topic_cohort_size: fixture.cohort_size,
    near_dup_origin_count: fixture.cohort_size,
    over_concentration: 0.8,
    near_dup_lesson_ids: fixture.envelopes.map((e) => e.id),
  };
  const { new_weight } = scoreFinding(1.0, finding);
  // Use a tight tolerance because Number arithmetic on 1.0 - 0.8 yields
  // 0.19999999999999996; assert against the symbolic intent.
  assert.ok(
    Math.abs(new_weight - 0.2) < 1e-12,
    `new_weight should be ~0.2, got ${new_weight}`
  );
  assert.ok(
    new_weight < MIN_LOCAL_WEIGHT_FOR_BROADCAST,
    `even at minimum-trigger over_concentration=0.8, new_weight ${new_weight} must clamp below MIN_LOCAL_WEIGHT_FOR_BROADCAST (${MIN_LOCAL_WEIGHT_FOR_BROADCAST}) — this is the load-bearing claim of §10.4 firebreak`
  );
});
