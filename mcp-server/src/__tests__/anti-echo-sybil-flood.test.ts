/**
 * Anti-echo-chamber adversarial corpus — sybil-flood category (W4.1, issue #196).
 *
 * Asserts the §10.4 diversity filter clamps a cohort of M=10 sock-puppet
 * lessons (distinct origin_node_ids, identical content + evidence_root,
 * pairwise cosine_similarity > 0.95) below the broadcast firebreak
 * (`MIN_LOCAL_WEIGHT_FOR_BROADCAST = 0.3`). M=10 is the spec's sybil-flood
 * minimum cohort size (`docs/wave-4-anti-echo.md` §"Corpus categories").
 *
 * Mechanics under test:
 *   - Each cohort envelope individually passes `validateWireRecord` —
 *     §10.4 is a post-admission, REM-cycle defense.
 *   - All envelope signatures verify against their cohort key (Pillar-6).
 *   - Pairwise cosine_similarity over the embeddings stays above the
 *     §10.4 default `p_duplicate_cosine` (0.95).
 *   - All `signed_at` timestamps fall inside the §10.4 default
 *     `p_signed_at_window_d` (7 days).
 *   - All envelopes share evidence_count and evidence_root (the
 *     "coordinated re-broadcast" signal — independent peers cannot reach
 *     the same evidence_root through different evidence chains).
 *   - `scoreFinding` clamps the new local_weight strictly below
 *     `MIN_LOCAL_WEIGHT_FOR_BROADCAST` for both the saturation case
 *     (over_concentration=1.0 → 0) and the boundary case
 *     (over_concentration=0.8 → 0.2 ≤ 0.3) — same firebreak invariant
 *     as plagiarism, asserted at M=10 to prove §10.4 has no M-dependent
 *     escape hatch.
 *
 * Scope — what this row does NOT cover:
 *   - The §10.2 quarantine arm of "§10.2 quarantine + §10.4". §10.2
 *     quarantines an origin after N=5 consecutive *rejections* under §5
 *     rules 1-20 (or single-strike on rules 5/16/19/20). A signature-valid
 *     well-formed sybil envelope passes those rules, so admission-time
 *     §10.2 does not fire. The §10.2 dimension of sybil-flood is
 *     operator-driven multi-node escalation (the operator quarantines
 *     the M flagged origins after a §10.4 finding) and is deferred to
 *     W4.2 (HTTP corpus runner) and W4.3 (multi-node campaign report)
 *     per the issue #196 deferral rule. This file flags that deferral
 *     in the metadata-invariant test rather than weakening the
 *     assertion silently.
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
      path.join(FIXTURES_DIR, "cohort-keys-sybil-flood.json"),
      "utf8"
    )
  );
}

function loadSybilCohort(): AntiEchoCohortFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, "sybil-flood", "coordinated-broadcast-cohort.json"),
      "utf8"
    )
  );
}

// ---------------------------------------------------------------------------
// (1) Metadata invariants
// ---------------------------------------------------------------------------

test("sybil-flood cohort: metadata declares broadcast_suppressed + negative trust delta + §10.2 + §10.4 owners", () => {
  const fixture = loadSybilCohort();
  const meta: AntiEchoFixtureMetadata = fixture.metadata;
  assert.equal(meta.category, "sybil-flood");
  assert.equal(
    meta.expected_outcome,
    "broadcast_suppressed",
    "§10.4 admits each envelope and clamps local_weight below the broadcast firebreak — the §10.2 quarantine arm is operator-driven and deferred to W4.2/W4.3"
  );
  assert.ok(
    meta.expected_trust_delta < 0,
    `expected negative trust delta for a defended-against attack class, got ${meta.expected_trust_delta}`
  );
  assert.match(
    meta.owns_mechanism,
    /§10\.2/,
    "owns_mechanism must name §10.2 so the corpus → spec linkage covers the deferred quarantine arm"
  );
  assert.match(
    meta.owns_mechanism,
    /§10\.4/,
    "owns_mechanism must name §10.4 so the corpus → spec linkage covers the unit-testable diversity arm"
  );
});

test("sybil-flood cohort: cohort_size matches envelopes.length and is ≥ §spec sybil minimum (10)", () => {
  const fixture = loadSybilCohort();
  // Cross-check defends against a copy-paste authoring error. The spec
  // (docs/wave-4-anti-echo.md §"Corpus categories") names M ≥ 10 as the
  // sybil-flood minimum. M < 10 would silently weaken the row to a
  // plagiarism-shaped test.
  assert.equal(
    fixture.cohort_size,
    fixture.envelopes.length,
    "cohort_size must equal envelopes.length"
  );
  assert.ok(
    fixture.cohort_size >= 10,
    `cohort must be ≥ spec sybil-flood minimum M=10, got ${fixture.cohort_size}`
  );
});

// ---------------------------------------------------------------------------
// (2) Pillar-6 — every envelope's signature verifies before §10 fires
// ---------------------------------------------------------------------------

test("sybil-flood cohort: every envelope is signature-valid against its cohort key", () => {
  const fixture = loadSybilCohort();
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
      `envelope[${i}] signature must verify — sybil-flood tests §10.4, not §3.7 wire-signature`
    );
  }
});

test("sybil-flood cohort: distinct origin_node_id per envelope (M sock-puppets, not one peer M times)", () => {
  const fixture = loadSybilCohort();
  // The §10.4 cross-peer concentration check counts a near-duplicate
  // toward `near_dup_origin_count` only if it carries a distinct
  // origin_node_id. A cohort where two envelopes share an origin would
  // silently shrink the effective M and weaken the firebreak claim.
  const origins = new Set(fixture.envelopes.map((e) => e.origin_node_id));
  assert.equal(
    origins.size,
    fixture.cohort_size,
    `every envelope must have a distinct origin_node_id, got ${origins.size}/${fixture.cohort_size}`
  );
});

// ---------------------------------------------------------------------------
// (3) Wire validator — every envelope is independently admissible
// ---------------------------------------------------------------------------

test("sybil-flood cohort: every envelope passes validateWireRecord (§10.4 is post-admission, §10.2 quarantine arm deferred)", async () => {
  const fixture = loadSybilCohort();
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
      `envelope[${i}] must pass the wire validator — §10.4 fires AFTER admission and §10.2 quarantine fires only on rejected lessons`
    );
  }
});

// ---------------------------------------------------------------------------
// (4) §10.4 trigger conditions — embedding similarity + signed_at window
// ---------------------------------------------------------------------------

test("sybil-flood cohort: pairwise cosine_similarity > 0.95 (§10.4 p_duplicate_cosine default)", () => {
  const fixture = loadSybilCohort();
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

test("sybil-flood cohort: signed_at spread inside §10.4 p_signed_at_window_d (7 days)", () => {
  const fixture = loadSybilCohort();
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

test("sybil-flood cohort: every envelope shares evidence_count and evidence_root (coordinated re-broadcast signature)", () => {
  const fixture = loadSybilCohort();
  const counts = new Set(fixture.envelopes.map((e) => e.evidence_count));
  const roots = new Set(fixture.envelopes.map((e) => e.evidence_root));
  // Independent peers would not reach the same evidence_root through
  // independent evidence chains — that is exactly the §10.4 "coordinated
  // re-broadcast" signal sybil-flood exists to defend against.
  assert.equal(
    counts.size,
    1,
    `evidence_count must be identical across the cohort, got ${[...counts].join(",")}`
  );
  assert.equal(
    roots.size,
    1,
    `evidence_root must be identical across the cohort (M sock-puppets re-broadcasting one lesson body), got ${roots.size} distinct values`
  );
});

// ---------------------------------------------------------------------------
// (5) §10.4 decision layer — scoreFinding clamps below the broadcast firebreak
// ---------------------------------------------------------------------------

test("sybil-flood cohort: scoreFinding at full saturation (over_concentration=1.0, M=10) silences the lesson", () => {
  const fixture = loadSybilCohort();
  // Synthesize the RemDiversityFinding the production §10.4 RPC would
  // emit for an M=10 cohort where every peer holds the near-duplicate:
  // near_dup_origin_count == topic_cohort_size and over_concentration =
  // 1.0. The scoreFinding decision layer must drop new_weight to 0.
  // Asserting at M=10 (vs plagiarism's M=3) proves §10.4 scoring has no
  // M-dependent escape hatch — the firebreak is purely a function of
  // over_concentration, not of cohort size.
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
    "100%-concentrated M=10 cohort must silence the lesson (new_weight=0)"
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

test("sybil-flood cohort: scoreFinding at boundary (over_concentration=0.8, M=10) still clamps below broadcast threshold", () => {
  const fixture = loadSybilCohort();
  // Boundary case: over_concentration exactly at the §10.4 RPC trigger
  // (`p_over_concentration=0.8`). At M=10, even at this minimum-trigger
  // value applied to a fresh lesson at prev_weight=1.0,
  // new_weight = 1.0 * (1 - 0.8) = 0.2 — strictly below
  // MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3). The load-bearing claim is that
  // scaling cohort size from 3 (plagiarism) to 10 (sybil) does not relax
  // the firebreak: §10.4 is a function of over_concentration alone.
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
  assert.ok(
    Math.abs(new_weight - 0.2) < 1e-12,
    `new_weight should be ~0.2, got ${new_weight}`
  );
  assert.ok(
    new_weight < MIN_LOCAL_WEIGHT_FOR_BROADCAST,
    `even at minimum-trigger over_concentration=0.8 with M=10 cohort, new_weight ${new_weight} must clamp below MIN_LOCAL_WEIGHT_FOR_BROADCAST (${MIN_LOCAL_WEIGHT_FOR_BROADCAST})`
  );
});
