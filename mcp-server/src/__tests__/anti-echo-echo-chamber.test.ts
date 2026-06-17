/**
 * Anti-echo-chamber adversarial corpus — echo-chamber category (W4.1, issue #196).
 *
 * Asserts the §10.4 diversity filter clamps a cohort of N=5 peers (4
 * echoers + 1 dissenter) below the broadcast firebreak
 * (`MIN_LOCAL_WEIGHT_FOR_BROADCAST = 0.3`) at over_concentration = 4/5 =
 * 0.8 — the §10.4 trigger boundary and the canonical case
 * `rem-diversity.test.ts` already exercises against the pure helper.
 *
 * Distinct from sybil-flood (the other §10.4-owning row):
 *   - Sybil exercises the *saturation* path (M=10 sock-puppets,
 *     over_concentration=1.0) — defends against coordinated re-broadcast.
 *   - Echo-chamber exercises the *boundary* path with a heterogeneous
 *     cohort (4 echoers + 1 dissenter, over_concentration=0.8) — defends
 *     against organic-looking groupthink where a visible dissenting
 *     minority might otherwise be argued to "save" the consensus from
 *     suppression.
 *
 * Mechanics under test:
 *   - Each cohort envelope individually passes `validateWireRecord` —
 *     §10.4 is a post-admission, REM-cycle defense. The wire validator
 *     never sees the cohort as a unit.
 *   - All envelope signatures verify against their cohort key (Pillar-6).
 *   - Echoer subset (envelopes[0..3]) has pairwise cosine_similarity >
 *     0.95 — the §10.4 default `p_duplicate_cosine`. Without this the
 *     diversity RPC would not flag the echoers as a near-duplicate set.
 *   - Echoer subset shares evidence_root and signed_at falls inside the
 *     §10.4 default `p_signed_at_window_d` (7 days).
 *   - Dissenter (envelopes[4]) has cosine ≈ 0.5 vs every echoer (well
 *     below `p_duplicate_cosine`), a distinct evidence_root, and
 *     heterodox content — proves the cohort has real diversity, not five
 *     sock-puppets.
 *   - `scoreFinding(prev=1.0, over=0.8)` clamps new_weight to 0.2,
 *     strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3). The
 *     load-bearing assertion of this row is that the dissenter does NOT
 *     save the consensus — the firebreak is purely a function of
 *     over_concentration, not of cohort heterogeneity.
 *
 * Scope — what this row does NOT cover:
 *   - The full RPC + lesson_diversity_log + swarm_lessons.local_weight
 *     UPDATE chain (asserted in `migration-082-swarm-lesson-diversity.test.ts`
 *     and `rem-diversity.test.ts`).
 *   - Multi-node trust-edge delta (asserted in the W4.3 campaign report).
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

// Per the build script's structural convention: envelopes[0..ECHOER_COUNT-1]
// are the echoers, envelopes[ECHOER_COUNT..] are the dissenters. This row
// fixes ECHOER_COUNT = 4 (cohort_size=5, over_concentration=4/5=0.8). A
// future fixture in the same category may pick a different split; if so
// the new fixture should expose the count in the JSON metadata rather than
// hard-coding the constant in the test, and this constant becomes per-row.
const ECHOER_COUNT = 4;

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
      path.join(FIXTURES_DIR, "cohort-keys-echo-chamber.json"),
      "utf8"
    )
  );
}

function loadEchoChamberCohort(): AntiEchoCohortFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, "echo-chamber", "consensus-with-dissent-cohort.json"),
      "utf8"
    )
  );
}

// ---------------------------------------------------------------------------
// (1) Metadata invariants
// ---------------------------------------------------------------------------

test("echo-chamber cohort: metadata declares broadcast_suppressed + negative trust delta + §10.4 owner", () => {
  const fixture = loadEchoChamberCohort();
  const meta: AntiEchoFixtureMetadata = fixture.metadata;
  assert.equal(meta.category, "echo-chamber");
  assert.equal(
    meta.expected_outcome,
    "broadcast_suppressed",
    "§10.4 admits each envelope and clamps the consensus lesson's local_weight below the broadcast firebreak"
  );
  assert.ok(
    meta.expected_trust_delta < 0,
    `expected negative trust delta for a defended-against attack class, got ${meta.expected_trust_delta}`
  );
  assert.match(
    meta.owns_mechanism,
    /§10\.4/,
    "owns_mechanism must name §10.4 (the diversity filter is the sole §10 mechanism this row exercises)"
  );
});

test("echo-chamber cohort: cohort_size matches envelopes.length and produces over_concentration ≥ §10.4 0.8 trigger", () => {
  const fixture = loadEchoChamberCohort();
  // Cross-check defends against a copy-paste authoring error. The spec
  // (docs/wave-4-anti-echo.md §"Corpus categories") names "≥80% of a
  // synthetic cohort" as the echo-chamber threshold. ECHOER_COUNT /
  // cohort_size < 0.8 would silently weaken the row — the §10.4 RPC's
  // default `p_over_concentration` is 0.8 and a sub-trigger ratio would
  // not fire it at all.
  assert.equal(
    fixture.cohort_size,
    fixture.envelopes.length,
    "cohort_size must equal envelopes.length"
  );
  const overConcentration = ECHOER_COUNT / fixture.cohort_size;
  assert.ok(
    overConcentration >= 0.8,
    `echoer ratio ${ECHOER_COUNT}/${fixture.cohort_size} = ${overConcentration} must hit the §10.4 spec threshold ≥ 0.8`
  );
});

// ---------------------------------------------------------------------------
// (2) Pillar-6 — every envelope's signature verifies before §10 fires
// ---------------------------------------------------------------------------

test("echo-chamber cohort: every envelope is signature-valid against its cohort key", () => {
  const fixture = loadEchoChamberCohort();
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
      `envelope[${i}] signature must verify — echo-chamber tests §10.4, not §3.7 wire-signature`
    );
  }
});

test("echo-chamber cohort: distinct origin_node_id per envelope (5 peers, not one peer 5 times)", () => {
  const fixture = loadEchoChamberCohort();
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

test("echo-chamber cohort: every envelope passes validateWireRecord (§10.4 is post-admission)", async () => {
  const fixture = loadEchoChamberCohort();
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
      `envelope[${i}] must pass the wire validator — §10.4 fires AFTER admission`
    );
  }
});

// ---------------------------------------------------------------------------
// (4) §10.4 trigger conditions — echoer subset is near-duplicate
// ---------------------------------------------------------------------------

test("echo-chamber cohort: pairwise cosine_similarity > 0.95 within the echoer subset (§10.4 p_duplicate_cosine default)", () => {
  const fixture = loadEchoChamberCohort();
  const DUPLICATE_COSINE_THRESHOLD = 0.95;
  // Only the echoer subset (envelopes[0..ECHOER_COUNT-1]) must satisfy
  // the near-duplicate threshold. The dissenter is asserted separately
  // (next test) as falling well below it.
  for (let i = 0; i < ECHOER_COUNT; i++) {
    for (let j = i + 1; j < ECHOER_COUNT; j++) {
      const cos = cosineSimilarity(
        fixture.envelopes[i].embedding,
        fixture.envelopes[j].embedding
      );
      assert.ok(
        cos > DUPLICATE_COSINE_THRESHOLD,
        `cosine(echoer[${i}], echoer[${j}]) = ${cos} must exceed §10.4 duplicate threshold ${DUPLICATE_COSINE_THRESHOLD}`
      );
    }
  }
});

test("echo-chamber cohort: dissenter cosine ≪ §10.4 p_duplicate_cosine vs every echoer (real heterodox peer)", () => {
  const fixture = loadEchoChamberCohort();
  const DUPLICATE_COSINE_THRESHOLD = 0.95;
  const dissenter = fixture.envelopes[ECHOER_COUNT];
  for (let i = 0; i < ECHOER_COUNT; i++) {
    const cos = cosineSimilarity(
      fixture.envelopes[i].embedding,
      dissenter.embedding
    );
    assert.ok(
      cos < DUPLICATE_COSINE_THRESHOLD,
      `cosine(echoer[${i}], dissenter) = ${cos} must fall below §10.4 duplicate threshold ${DUPLICATE_COSINE_THRESHOLD} — otherwise the dissenter would silently collapse into the echoer subset and the cohort would degenerate to a 5-way plagiarism row`
    );
  }
});

test("echo-chamber cohort: signed_at spread inside §10.4 p_signed_at_window_d (7 days)", () => {
  const fixture = loadEchoChamberCohort();
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

test("echo-chamber cohort: echoers share evidence_root, dissenter has its own (no independent evidence chain across the echoer subset)", () => {
  const fixture = loadEchoChamberCohort();
  const echoerRoots = new Set(
    fixture.envelopes.slice(0, ECHOER_COUNT).map((e) => e.evidence_root)
  );
  const dissenter = fixture.envelopes[ECHOER_COUNT];
  // Independent peers would not collide on evidence_root through
  // independent evidence chains — that is the §10.4 "no independent
  // evidence_root" signal echo-chamber exists to defend against. The
  // dissenter's distinct root is the structural proof that the cohort is
  // not five sock-puppets.
  assert.equal(
    echoerRoots.size,
    1,
    `evidence_root must be identical across the four echoers (re-broadcast of one consensus body), got ${echoerRoots.size} distinct values`
  );
  assert.ok(
    !echoerRoots.has(dissenter.evidence_root),
    "dissenter evidence_root must differ from the shared echoer root — otherwise the cohort degenerates to a 5-peer plagiarism row"
  );
});

// ---------------------------------------------------------------------------
// (5) §10.4 decision layer — scoreFinding clamps below the broadcast firebreak
// ---------------------------------------------------------------------------

test("echo-chamber cohort: scoreFinding at trigger boundary (over_concentration=0.8, M=4 of 5) clamps below broadcast threshold", () => {
  const fixture = loadEchoChamberCohort();
  // Synthesize the RemDiversityFinding the production §10.4 RPC would
  // emit for this cohort: the four echoers carry the near-duplicate, the
  // dissenter does not. topic_cohort_size = 5 (the full cohort the RPC
  // saw), near_dup_origin_count = 4 (only the echoers), over_concentration
  // = 4/5 = 0.8 (the §10.4 RPC's default `p_over_concentration` trigger).
  //
  // The load-bearing claim: at prev_weight = 1.0 (a fresh consensus
  // lesson), the §10.4 multiplier `(1 - over_concentration)` = 0.2 yields
  // new_weight = 0.2 — strictly below MIN_LOCAL_WEIGHT_FOR_BROADCAST (0.3).
  // The dissenter exists in the cohort and is visible to the RPC, but the
  // firebreak fires anyway: §10.4 is a function of over_concentration
  // alone, not of cohort heterogeneity.
  const consensusLesson = fixture.envelopes[0]; // any echoer is the consensus
  const finding: RemDiversityFinding = {
    swarm_lesson_id: consensusLesson.id,
    origin_node_id: consensusLesson.origin_node_id,
    swarm_lesson_text: consensusLesson.content,
    topic_cohort_size: fixture.cohort_size,
    near_dup_origin_count: ECHOER_COUNT,
    over_concentration: ECHOER_COUNT / fixture.cohort_size,
    near_dup_lesson_ids: fixture.envelopes
      .slice(0, ECHOER_COUNT)
      .map((e) => e.id),
  };
  const { new_weight, reason } = scoreFinding(1.0, finding);
  assert.ok(
    Math.abs(new_weight - 0.2) < 1e-12,
    `new_weight should be ~0.2 (= 1.0 * (1 - 0.8)), got ${new_weight}`
  );
  assert.ok(
    new_weight < MIN_LOCAL_WEIGHT_FOR_BROADCAST,
    `new_weight ${new_weight} must clamp below MIN_LOCAL_WEIGHT_FOR_BROADCAST (${MIN_LOCAL_WEIGHT_FOR_BROADCAST}) — even with a visible dissenter in the cohort, §10.4's firebreak fires at over_concentration=0.8`
  );
  assert.match(
    reason,
    /§10\.4/,
    "audit reason must self-describe with the spec section"
  );
});

test("echo-chamber cohort: scoreFinding does NOT relax the firebreak when topic_cohort_size grows but over_concentration stays at 0.8", () => {
  const fixture = loadEchoChamberCohort();
  // Adversary's natural escalation: pad the cohort with extra dissenters
  // to make the consensus look like a smaller fraction of a larger
  // peer-set. topic_cohort_size = 100, near_dup_origin_count = 80 — same
  // 0.8 ratio. §10.4 must still clamp below the firebreak; otherwise the
  // attack would be "gather enough dissenters to dilute the
  // concentration ratio" and §10.4 would have an N-dependent escape.
  // Pinning this at M=80 (vs the fixture's M=4) proves §10.4 is
  // ratio-driven, not count-driven.
  const consensusLesson = fixture.envelopes[0];
  const finding: RemDiversityFinding = {
    swarm_lesson_id: consensusLesson.id,
    origin_node_id: consensusLesson.origin_node_id,
    swarm_lesson_text: consensusLesson.content,
    topic_cohort_size: 100,
    near_dup_origin_count: 80,
    over_concentration: 0.8,
    near_dup_lesson_ids: fixture.envelopes
      .slice(0, ECHOER_COUNT)
      .map((e) => e.id),
  };
  const { new_weight } = scoreFinding(1.0, finding);
  assert.ok(
    Math.abs(new_weight - 0.2) < 1e-12,
    `padding the cohort to N=100 with the same 0.8 ratio must NOT relax the multiplier — got new_weight=${new_weight}, expected 0.2`
  );
  assert.ok(
    new_weight < MIN_LOCAL_WEIGHT_FOR_BROADCAST,
    `padded-cohort new_weight ${new_weight} must clamp below MIN_LOCAL_WEIGHT_FOR_BROADCAST (${MIN_LOCAL_WEIGHT_FOR_BROADCAST}) — §10.4 has no N-dependent escape hatch`
  );
});
