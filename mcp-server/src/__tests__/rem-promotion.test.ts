import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreFinding,
  RemPromotionFinding,
  RemPromotionService,
  RemPromotionDeps,
} from "../services/rem-promotion.js";

// ---------------------------------------------------------------------------
// REM promotion-audit service unit tests — Swarm Phase 4i, sub-phase 4i.2.
//
// Two layers of coverage matching the rem-audit / lesson-contradiction-gate
// split:
//   * Pure helper (`scoreFinding`) tested against bare object inputs — the
//     deterministic decision boundary (here, the audit-log reason text).
//   * Orchestrator (`runPromotionPass` via `applyFinding`) tested against
//     an in-memory dep stub — verifies side-effect order, partial-failure
//     isolation, and the audit-trail contract (every promotion records a
//     tier_promotion_log row BEFORE flipping the swarm_lessons row).
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<RemPromotionFinding> = {}): RemPromotionFinding {
  return {
    swarm_lesson_id: "11111111-1111-1111-1111-111111111111",
    origin_node_id:  "node-peer-y",
    swarm_lesson_text: "swarm-imported lesson body",
    cluster_size: 3,
    mean_cosine: 0.91,
    mean_local_valence: 0.62,
    local_evidence_ids: [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
    ],
    seed_summary: "I tried doing X and it worked beautifully",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Pure decision layer — scoreFinding
// ---------------------------------------------------------------------------

test("scoreFinding embeds cluster size, cosine, valence and seed in the log_reason", () => {
  const { log_reason } = scoreFinding(makeFinding());
  assert.match(log_reason, /§10\.6 corroborated:/);
  assert.match(log_reason, /3 local experience\(s\)/);
  assert.match(log_reason, /mean cosine 0\.91/);
  assert.match(log_reason, /mean valence 0\.62/);
  assert.match(log_reason, /Strongest: "I tried doing X and it worked beautifully"/);
});

test("scoreFinding truncates an oversized seed_summary to keep the reason under the 512-byte CHECK", () => {
  // Migration 078's tier_promotion_log.reason is CHECKed against
  // octet_length(reason) <= 512. A free-text seed summary can blow past
  // that easily — pin the truncation behaviour so the orchestrator never
  // hits the DB-level CHECK at runtime.
  const longSeed = "a".repeat(2000);
  const { log_reason } = scoreFinding(makeFinding({ seed_summary: longSeed }));
  // Must include the truncation marker rather than the raw 2000-char body.
  assert.ok(log_reason.includes("…"), "expected truncation ellipsis");
  // 512-byte budget with margin for the surrounding template — be strict.
  assert.ok(
    log_reason.length < 512,
    `expected log_reason < 512 chars, got ${log_reason.length}`,
  );
});

test("scoreFinding leaves a short seed_summary untouched (no spurious truncation)", () => {
  const { log_reason } = scoreFinding(makeFinding({ seed_summary: "tiny" }));
  assert.ok(!log_reason.includes("…"));
  assert.match(log_reason, /Strongest: "tiny"/);
});

// ---------------------------------------------------------------------------
// (2) Orchestrator — runPromotionPass
//
// We bypass the constructor (which builds a real Supabase client) by using
// Object.create — only the orchestrator method depends on `this`, and it
// receives all DB access via the deps bag. Same pattern as rem-audit.test.ts
// and lesson-contradiction-gate.test.ts.
// ---------------------------------------------------------------------------

interface DepsCallLog {
  recordTierPromotion: Array<{ lessonId: string; reason: string; evidenceIds: string[] }>;
  promoteSwarmLessonTier: string[];
}

function makeDeps(behaviour: Partial<RemPromotionDeps> = {}): {
  deps: RemPromotionDeps;
  log: DepsCallLog;
} {
  const log: DepsCallLog = {
    recordTierPromotion: [],
    promoteSwarmLessonTier: [],
  };
  const deps: RemPromotionDeps = {
    async recordTierPromotion(lessonId, reason, evidenceIds) {
      log.recordTierPromotion.push({ lessonId, reason, evidenceIds });
      if (behaviour.recordTierPromotion) {
        return behaviour.recordTierPromotion(lessonId, reason, evidenceIds);
      }
    },
    async promoteSwarmLessonTier(lessonId) {
      log.promoteSwarmLessonTier.push(lessonId);
      if (behaviour.promoteSwarmLessonTier) {
        return behaviour.promoteSwarmLessonTier(lessonId);
      }
    },
  };
  return { deps, log };
}

function makeServiceWithFindings(findings: RemPromotionFinding[]): RemPromotionService {
  const svc = Object.create(RemPromotionService.prototype) as RemPromotionService;
  (svc as unknown as { findCorroborated: () => Promise<RemPromotionFinding[]> }).findCorroborated =
    async () => findings;
  return svc;
}

test("runPromotionPass applies both side effects in the documented order", async () => {
  const finding = makeFinding();
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps();

  const outcomes = await svc.runPromotionPass({}, deps);

  assert.equal(outcomes.length, 1);
  // recordTierPromotion FIRST — append-only audit must be durable before
  // we touch the broadcast-eligibility surface. If the tier flip fails, the
  // log row remains and the next REM cycle retries with full context.
  assert.equal(log.recordTierPromotion.length, 1);
  const logRow = log.recordTierPromotion[0];
  assert.equal(logRow.lessonId, finding.swarm_lesson_id);
  assert.deepEqual(logRow.evidenceIds, finding.local_evidence_ids);
  assert.match(logRow.reason, /§10\.6 corroborated:/);
  // promoteSwarmLessonTier SECOND — the actual visibility flip.
  assert.deepEqual(log.promoteSwarmLessonTier, [finding.swarm_lesson_id]);

  const outcome = outcomes[0];
  assert.equal(outcome.promoted, true);
  assert.equal(outcome.error, undefined);
});

test("runPromotionPass aborts the tier flip if the audit-log insert fails", async () => {
  // Order invariant: a Tier-A row without a matching tier_promotion_log
  // entry breaks §10.6 traceability. If the log INSERT fails, we MUST
  // leave the swarm_lessons row at Tier-B and let the next REM cycle retry.
  const finding = makeFinding();
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps({
    async recordTierPromotion() {
      throw new Error("simulated tier_promotion_log INSERT failure");
    },
  });

  const outcomes = await svc.runPromotionPass({}, deps);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].promoted, false);
  assert.match(outcomes[0].error ?? "", /tier_promotion_log INSERT failure/);
  // Critical: tier flip MUST NOT have happened — the firewall stays closed.
  assert.equal(log.promoteSwarmLessonTier.length, 0);
});

test("runPromotionPass leaves the audit log in place if the tier flip fails (retry-safe)", async () => {
  // The dual: log row written, swarm_lessons UPDATE fails. The log entry
  // is now slightly ahead of reality, but the next REM cycle will see
  // lesson_tier='B' again and re-run; the second log entry will be the
  // legitimate one. Append-only means we accept a stray-but-honest log
  // row over a silent failure.
  const finding = makeFinding();
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps({
    async promoteSwarmLessonTier() {
      throw new Error("simulated swarm_lessons UPDATE failure");
    },
  });

  const outcomes = await svc.runPromotionPass({}, deps);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].promoted, false);
  assert.match(outcomes[0].error ?? "", /swarm_lessons UPDATE failure/);
  // Log row was written before the failure — that's the documented contract.
  assert.equal(log.recordTierPromotion.length, 1);
});

test("runPromotionPass captures per-finding errors without aborting the rest of the pass", async () => {
  const goodFinding = makeFinding({ swarm_lesson_id: "22222222-2222-2222-2222-222222222222" });
  const badFinding  = makeFinding({ swarm_lesson_id: "33333333-3333-3333-3333-333333333333" });
  const svc = makeServiceWithFindings([badFinding, goodFinding]);

  let calls = 0;
  const { deps, log } = makeDeps({
    async recordTierPromotion() {
      calls++;
      if (calls === 1) throw new Error("simulated audit insert failure");
    },
  });

  const outcomes = await svc.runPromotionPass({}, deps);

  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].promoted, false);
  assert.match(outcomes[0].error ?? "", /simulated audit insert failure/);
  // The second finding must complete cleanly — error isolation matters.
  assert.equal(outcomes[1].promoted, true);
  assert.equal(outcomes[1].error, undefined);
  // Only the good finding's tier got flipped.
  assert.deepEqual(log.promoteSwarmLessonTier, [goodFinding.swarm_lesson_id]);
});

test("runPromotionPass returns an empty array when no findings exist (Tier-B is clean of corroboration)", async () => {
  const svc = makeServiceWithFindings([]);
  const { deps, log } = makeDeps();

  const outcomes = await svc.runPromotionPass({}, deps);

  assert.equal(outcomes.length, 0);
  assert.equal(log.recordTierPromotion.length, 0);
  assert.equal(log.promoteSwarmLessonTier.length, 0);
});

test("runPromotionPass passes the local_evidence_ids to the audit log unchanged", async () => {
  // §10.6 acceptance: "Tier-B lesson promoted to Tier-A records the local
  // evidence that justified the promotion." The orchestrator MUST forward
  // every UUID from the RPC's local_evidence_ids to the log row — no
  // truncation, no reordering, no de-duplication. Any of those would
  // destroy the audit trail an operator needs to review the promotion.
  const finding = makeFinding({
    local_evidence_ids: [
      "11111111-aaaa-bbbb-cccc-111111111111",
      "22222222-aaaa-bbbb-cccc-222222222222",
      "33333333-aaaa-bbbb-cccc-333333333333",
      "44444444-aaaa-bbbb-cccc-444444444444",
    ],
  });
  const svc = makeServiceWithFindings([finding]);
  const { deps, log } = makeDeps();

  await svc.runPromotionPass({}, deps);

  assert.deepEqual(log.recordTierPromotion[0].evidenceIds, finding.local_evidence_ids);
});

test("runPromotionPass tags the promotion log with §10.6 in the reason text", async () => {
  // The audit log carries a free-text reason. Pin that the spec section
  // appears in it: an operator scanning tier_promotion_log for "§10.6"
  // must be able to find every promotion driven by this code path.
  const svc = makeServiceWithFindings([makeFinding()]);
  const { deps, log } = makeDeps();

  await svc.runPromotionPass({}, deps);

  assert.match(log.recordTierPromotion[0].reason, /§10\.6 corroborated:/);
});
