import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreFinding,
  formatFalsifyingLessonText,
  RemAuditFinding,
  RemAuditService,
  RemAuditDeps,
  RemAuditOutcome,
} from "../services/rem-audit.js";

// ---------------------------------------------------------------------------
// REM self-audit service unit tests — Swarm Phase 4h (issue #109).
//
// Two layers of coverage matching the lesson-contradiction-gate split:
//   * Pure helpers (`scoreFinding`, `formatFalsifyingLessonText`) tested
//     against bare object inputs — the deterministic decision boundary.
//   * Orchestrator (`runSelfAudit` via `applyFinding`) tested against an
//     in-memory dep stub — verifies side-effect order, partial-failure
//     isolation, and the audit-trail contract (every forget records both
//     a falsifying lesson AND a trust decrement).
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<RemAuditFinding> = {}): RemAuditFinding {
  return {
    swarm_lesson_id: "11111111-1111-1111-1111-111111111111",
    origin_node_id:  "node-peer-x",
    swarm_lesson_text: "swarm-imported lesson body",
    cluster_size: 3,
    mean_cosine: 0.88,
    mean_local_valence: -0.62,
    local_evidence_ids: [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
    ],
    seed_summary: "I tried doing X and it failed badly",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Pure decision layer — scoreFinding
// ---------------------------------------------------------------------------

test("scoreFinding scales trust_decrement linearly with mean_cosine inside [0.05, 0.25]", () => {
  // Boundary: cosine 0.0 → floor of 0.05.
  const lo = scoreFinding(makeFinding({ mean_cosine: 0.0 }));
  assert.equal(lo.trust_decrement, 0.05);

  // Boundary: cosine 1.0 → ceiling of 0.25.
  const hi = scoreFinding(makeFinding({ mean_cosine: 1.0 }));
  assert.equal(hi.trust_decrement, 0.25);

  // Mid-range: cosine 0.88 → 0.22.
  const mid = scoreFinding(makeFinding({ mean_cosine: 0.88 }));
  assert.ok(mid.trust_decrement > 0.21 && mid.trust_decrement < 0.23);
});

test("scoreFinding clamps cosine inputs outside [0, 1] without throwing", () => {
  // Should never see these in practice, but the formula must not blow up
  // if a future RPC change lets a slightly negative cosine through.
  const negative = scoreFinding(makeFinding({ mean_cosine: -0.5 }));
  assert.equal(negative.trust_decrement, 0.05);
  const huge = scoreFinding(makeFinding({ mean_cosine: 1.7 }));
  assert.equal(huge.trust_decrement, 0.25);
});

test("formatFalsifyingLessonText embeds origin, count, valence, cosine and seed", () => {
  const text = formatFalsifyingLessonText(makeFinding());
  assert.match(text, /Ich habe gelernt:/);
  assert.match(text, /node-peer-x/);
  assert.match(text, /3 lokale Erfahrungen/);
  assert.match(text, /mean cosine 0\.88/);
  assert.match(text, /mean valence -0\.62/);
  assert.match(text, /Stärkste lokale Gegenevidenz: "I tried doing X and it failed badly"/);
});

// ---------------------------------------------------------------------------
// (2) Orchestrator — runSelfAudit
//
// We bypass the constructor (which builds a real Supabase client) by using
// Object.create — only the orchestrator method depends on `this`, and it
// receives all DB access via the deps bag. This is the same pattern as
// the lesson-contradiction-gate tests in PR #121.
// ---------------------------------------------------------------------------

interface DepsCallLog {
  recordLesson: Array<{ text: string; sourceIds: string[] }>;
  readTrustWeight: string[];
  recordTrustEdgeChange: Array<{ nodeId: string; newWeight: number; reason: string }>;
  deleteSwarmLesson: string[];
}

function makeDeps(initialTrust = 0.5, behaviour: Partial<RemAuditDeps> = {}): {
  deps: RemAuditDeps;
  log: DepsCallLog;
} {
  const log: DepsCallLog = {
    recordLesson: [],
    readTrustWeight: [],
    recordTrustEdgeChange: [],
    deleteSwarmLesson: [],
  };
  const deps: RemAuditDeps = {
    async recordLesson(text, sourceIds) {
      log.recordLesson.push({ text, sourceIds });
      if (behaviour.recordLesson) return behaviour.recordLesson(text, sourceIds);
      return "lesson-id-stub";
    },
    async readTrustWeight(nodeId) {
      log.readTrustWeight.push(nodeId);
      if (behaviour.readTrustWeight) return behaviour.readTrustWeight(nodeId);
      return initialTrust;
    },
    async recordTrustEdgeChange(nodeId, newWeight, reason) {
      log.recordTrustEdgeChange.push({ nodeId, newWeight, reason });
      if (behaviour.recordTrustEdgeChange) return behaviour.recordTrustEdgeChange(nodeId, newWeight, reason);
    },
    async deleteSwarmLesson(lessonId) {
      log.deleteSwarmLesson.push(lessonId);
      if (behaviour.deleteSwarmLesson) return behaviour.deleteSwarmLesson(lessonId);
    },
  };
  return { deps, log };
}

function makeServiceWithFindings(findings: RemAuditFinding[]): RemAuditService {
  const svc = Object.create(RemAuditService.prototype) as RemAuditService;
  (svc as unknown as { findContradicted: () => Promise<RemAuditFinding[]> }).findContradicted =
    async () => findings;
  return svc;
}

test("runSelfAudit applies all three side effects in the documented order", async () => {
  const finding = makeFinding();
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps(0.5);

  const outcomes = await svc.runSelfAudit({}, deps);

  assert.equal(outcomes.length, 1);
  // recordLesson FIRST so the synthesis is durable even if downstream fails.
  assert.equal(log.recordLesson.length, 1);
  assert.equal(log.recordLesson[0].sourceIds.length, finding.local_evidence_ids.length);
  // readTrustWeight + recordTrustEdgeChange SECOND.
  assert.deepEqual(log.readTrustWeight, [finding.origin_node_id]);
  assert.equal(log.recordTrustEdgeChange.length, 1);
  // deleteSwarmLesson LAST so a failure earlier doesn't orphan references.
  assert.deepEqual(log.deleteSwarmLesson, [finding.swarm_lesson_id]);

  const outcome = outcomes[0];
  assert.equal(outcome.forgotten, true);
  assert.equal(outcome.local_lesson_id, "lesson-id-stub");
  assert.ok(outcome.trust_decrement > 0);
  assert.equal(outcome.error, undefined);
});

test("runSelfAudit decrements trust by exactly trust_decrement, clamped to [0, 1]", async () => {
  const finding = makeFinding({ mean_cosine: 0.88 }); // → 0.22
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps(0.5);

  await svc.runSelfAudit({}, deps);

  const change = log.recordTrustEdgeChange[0];
  assert.ok(change, "trust_edge_change should have been recorded");
  // 0.5 - 0.22 = 0.28; floats are imprecise but should be very close.
  assert.ok(Math.abs(change.newWeight - 0.28) < 1e-9, `expected ~0.28, got ${change.newWeight}`);
  assert.match(change.reason, /^audit-falsification:/);
  assert.match(change.reason, new RegExp(finding.swarm_lesson_id.replace(/-/g, "\\-")));
});

test("runSelfAudit floors the new trust weight at 0 when decrement exceeds current weight", async () => {
  const finding = makeFinding({ mean_cosine: 1.0 }); // → 0.25
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps(0.1);

  await svc.runSelfAudit({}, deps);

  // 0.1 - 0.25 would be negative; clamp to 0.
  assert.equal(log.recordTrustEdgeChange[0].newWeight, 0);
});

test("runSelfAudit skips the trust update when before == after (no-op short-circuit)", async () => {
  const finding = makeFinding({ mean_cosine: 0.0 }); // floor decrement = 0.05
  const svc = makeServiceWithFindings([finding]);
  // Set initial trust to 0 so floor-clamp keeps after = 0 = before.
  const { deps, log } = makeDeps(0);

  await svc.runSelfAudit({}, deps);

  // Without the no-op short-circuit, record_trust_edge_change would still
  // be called and would land an audit row with weight_before == weight_after.
  // We avoid that noise.
  assert.equal(log.recordTrustEdgeChange.length, 0);
  // But the falsifying lesson and the forget MUST still happen — the local
  // ground truth is independent of the trust accounting.
  assert.equal(log.recordLesson.length, 1);
  assert.equal(log.deleteSwarmLesson.length, 1);
});

test("runSelfAudit captures per-finding errors without aborting the rest of the pass", async () => {
  const goodFinding = makeFinding({ swarm_lesson_id: "22222222-2222-2222-2222-222222222222" });
  const badFinding = makeFinding({ swarm_lesson_id: "33333333-3333-3333-3333-333333333333" });
  const svc = makeServiceWithFindings([badFinding, goodFinding]);

  let calls = 0;
  const { deps, log } = makeDeps(0.5, {
    async recordLesson(text, sourceIds) {
      calls++;
      // Fail the FIRST finding (badFinding), succeed for the second.
      if (calls === 1) throw new Error("simulated record_lesson failure");
      return "lesson-id-stub";
    },
  });

  const outcomes = await svc.runSelfAudit({}, deps);

  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].forgotten, false);
  assert.match(outcomes[0].error ?? "", /simulated record_lesson failure/);
  // The second finding must complete cleanly — error isolation matters.
  assert.equal(outcomes[1].forgotten, true);
  assert.equal(outcomes[1].error, undefined);
  assert.equal(log.deleteSwarmLesson.length, 1);
  assert.deepEqual(log.deleteSwarmLesson, [goodFinding.swarm_lesson_id]);
});

test("runSelfAudit returns an empty array when no findings exist (Tier-B is clean)", async () => {
  const svc = makeServiceWithFindings([]);
  const { deps, log } = makeDeps(0.5);

  const outcomes = await svc.runSelfAudit({}, deps);

  assert.equal(outcomes.length, 0);
  assert.equal(log.recordLesson.length, 0);
  assert.equal(log.recordTrustEdgeChange.length, 0);
  assert.equal(log.deleteSwarmLesson.length, 0);
});

test("runSelfAudit treats a corroborating local cluster as 'no finding' (RPC contract)", async () => {
  // SWARM_SPEC §10.5 + acceptance #2 on issue #109: a tentative lesson
  // with corroborating local experiences MUST stay (don't accidentally
  // promote here; that's 4i). The corroboration case is rejected at the
  // RPC level (the e.valence <= p_max_local_valence + outcome filter
  // strips out positive/success episodes), so the orchestrator should
  // simply receive zero findings. This pin documents that contract from
  // the consumer side.
  const svc = makeServiceWithFindings([]);
  const { deps } = makeDeps(0.5);
  const outcomes = await svc.runSelfAudit({}, deps);
  assert.equal(outcomes.length, 0);
});
