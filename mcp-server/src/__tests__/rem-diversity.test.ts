import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreFinding,
  formatReason,
  RemDiversityFinding,
  RemDiversityService,
  RemDiversityDeps,
  RemDiversityOutcome,
} from "../services/rem-diversity.js";

// ---------------------------------------------------------------------------
// REM diversity service unit tests — Swarm Phase 4i, sub-phase 4i.3 (#114).
//
// Two layers of coverage matching rem-audit / rem-promotion split:
//   * Pure helpers (`scoreFinding`, `formatReason`) tested against bare
//     object inputs — the deterministic decision boundary.
//   * Orchestrator (`runDiversityPass` via `applyFinding`) tested against
//     in-memory dep stubs — verifies side-effect order, no-op short-
//     circuit, partial-failure isolation, and the (new_weight <=
//     prev_weight) invariant at the application layer.
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<RemDiversityFinding> = {}): RemDiversityFinding {
  return {
    swarm_lesson_id: "11111111-1111-1111-1111-111111111111",
    origin_node_id:  "node-peer-x",
    swarm_lesson_text: "swarm-imported lesson body",
    topic_cohort_size: 5,
    near_dup_origin_count: 4,           // 4/5 = 0.8 — the §10.4 issue's
    over_concentration: 0.8,            // canonical "4 of 5 peers" case
    near_dup_lesson_ids: [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Pure decision layer — scoreFinding
// ---------------------------------------------------------------------------

test("scoreFinding multiplies prev_weight by (1 - over_concentration)", () => {
  // The §10.4 canonical case: 4/5 peers → over=0.8 → factor=0.2 → new
  // weight is 20% of prev. With prev=1.0 the new weight is 0.2.
  const r = scoreFinding(1.0, makeFinding({ over_concentration: 0.8 }));
  assert.ok(Math.abs(r.new_weight - 0.2) < 1e-9);
});

test("scoreFinding silences a 100%-concentrated lesson entirely", () => {
  // over=1.0 → factor=0 → new_weight=0. This is the "everyone holds the
  // same near-duplicate" edge: the lesson contributes nothing to local
  // recall until the cohort diversifies.
  const r = scoreFinding(1.0, makeFinding({ over_concentration: 1.0 }));
  assert.equal(r.new_weight, 0);
});

test("scoreFinding scales an already-decremented weight further (multiplicative)", () => {
  // Sub-phase 4i.3 leaves stacking up to the caller. If a lesson got
  // decremented to 0.5 in a prior cycle and a fresh diversity pass finds
  // over=0.8 again, the new weight is 0.5 * 0.2 = 0.1. The (new_weight <=
  // prev_weight) CHECK on lesson_diversity_log permits this (0.1 < 0.5).
  const r = scoreFinding(0.5, makeFinding({ over_concentration: 0.8 }));
  assert.ok(Math.abs(r.new_weight - 0.1) < 1e-9);
});

test("scoreFinding clamps over_concentration outside [0, 1] without throwing", () => {
  // Defensive: should never see these in practice (the SQL CHECK is 0..1)
  // but the formula must not blow up if a future RPC change lets a
  // pathological value through.
  const negative = scoreFinding(1.0, makeFinding({ over_concentration: -0.5 }));
  // over clamped to 0 → factor=1 → new_weight = prev * 1 = 1.0
  assert.equal(negative.new_weight, 1.0);

  const huge = scoreFinding(1.0, makeFinding({ over_concentration: 1.7 }));
  // over clamped to 1 → factor=0 → new_weight = 0
  assert.equal(huge.new_weight, 0);
});

test("scoreFinding never amplifies — new_weight <= prev_weight always", () => {
  // The application-layer guarantee that mirrors the SQL CHECK on
  // lesson_diversity_log.(new_weight <= prev_weight). Even if a future
  // edit accidentally inverts the formula, the min(prev, ...) clamp
  // prevents the orchestrator from emitting an amplifying log row.
  for (const over of [0.0, 0.3, 0.5, 0.8, 0.95, 1.0]) {
    const r = scoreFinding(0.7, makeFinding({ over_concentration: over }));
    assert.ok(r.new_weight <= 0.7, `over=${over} produced new_weight=${r.new_weight}`);
    assert.ok(r.new_weight >= 0,   `over=${over} produced negative new_weight=${r.new_weight}`);
  }
});

test("formatReason embeds spec section, cohort ratio, origin, and over value", () => {
  const reason = formatReason(makeFinding());
  assert.match(reason, /§10\.4/);
  assert.match(reason, /4\/5/);
  assert.match(reason, /node-peer-x/);
  assert.match(reason, /over_concentration=0\.80/);
  // Sanity: under 512 bytes (the lesson_diversity_log.reason CHECK).
  assert.ok(Buffer.byteLength(reason, "utf8") <= 512);
});

// ---------------------------------------------------------------------------
// (2) Orchestrator — runDiversityPass / applyFinding
// ---------------------------------------------------------------------------

interface StubLog {
  applyCalls: Array<{
    lessonId: string;
    prevWeight: number;
    newWeight: number;
    finding: RemDiversityFinding;
    reason: string;
  }>;
}

function makeService(): RemDiversityService {
  // We never hit the real RPC — runDiversityPass is exercised via a
  // monkey-patched findOverconcentrated below. Construct with throwaway
  // creds; SupabaseClient is lazily initialised and we won't make any
  // network calls in tests.
  return new RemDiversityService("http://test.invalid", "test-anon-key");
}

function makeDeps(
  initialWeights: Map<string, number>,
  log: StubLog,
  opts: { failApply?: string; failRead?: string } = {},
): RemDiversityDeps {
  return {
    async readLocalWeight(lessonId) {
      if (opts.failRead === lessonId) {
        throw new Error(`stub read fail for ${lessonId}`);
      }
      return initialWeights.get(lessonId) ?? 1.0;
    },
    async applyWeightChange(lessonId, prevWeight, newWeight, finding, reason) {
      if (opts.failApply === lessonId) {
        throw new Error(`stub apply fail for ${lessonId}`);
      }
      log.applyCalls.push({ lessonId, prevWeight, newWeight, finding, reason });
      initialWeights.set(lessonId, newWeight);
    },
  };
}

test("runDiversityPass applies the weight decrement for each finding", async () => {
  const svc = makeService();
  const finding = makeFinding({ swarm_lesson_id: "11111111-1111-1111-1111-111111111111" });
  // Stub the RPC layer.
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [finding];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map([[finding.swarm_lesson_id, 1.0]]);
  const deps = makeDeps(weights, log);

  const outcomes = await svc.runDiversityPass({}, deps);

  assert.equal(outcomes.length, 1);
  const o = outcomes[0];
  assert.equal(o.swarm_lesson_id, finding.swarm_lesson_id);
  assert.equal(o.applied, true);
  assert.equal(o.prev_weight, 1.0);
  assert.ok(Math.abs(o.new_weight - 0.2) < 1e-9);
  assert.equal(log.applyCalls.length, 1);
  // The audit-log call carried the full finding (the audit row needs all
  // four context columns: cohort size, dup count, over, dup ids).
  assert.equal(log.applyCalls[0].finding.near_dup_lesson_ids.length, 4);
});

test("runDiversityPass with empty findings returns empty outcomes (no DB writes)", async () => {
  const svc = makeService();
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map<string, number>();
  const deps = makeDeps(weights, log);

  const outcomes = await svc.runDiversityPass({}, deps);
  assert.deepEqual(outcomes, []);
  assert.equal(log.applyCalls.length, 0);
});

test("applyFinding short-circuits when new_weight === prev_weight (no audit spam)", async () => {
  // over=0 means factor=1 means new_weight = prev_weight. The orchestrator
  // must not emit a no-op audit log row in that case (the audit log would
  // grow without any actual transition to record). This is the application-
  // layer analogue of tier_promotion_log's (from_tier <> to_tier) CHECK.
  const svc = makeService();
  const finding = makeFinding({ over_concentration: 0.0 });
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [finding];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map([[finding.swarm_lesson_id, 1.0]]);
  const deps = makeDeps(weights, log);

  const outcomes = await svc.runDiversityPass({}, deps);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].applied, false);  // skipped
  assert.equal(outcomes[0].prev_weight, 1.0);
  assert.equal(outcomes[0].new_weight, 1.0);
  assert.equal(log.applyCalls.length, 0, "no audit row written for a no-op");
});

test("applyFinding skips no-op when prev_weight is already 0", async () => {
  // A previously-silenced lesson stays silenced. The formula computes
  // new_weight = 0 * factor = 0, which is === prev_weight, so the
  // short-circuit kicks in and avoids audit spam.
  const svc = makeService();
  const finding = makeFinding({ over_concentration: 0.95 });
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [finding];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map([[finding.swarm_lesson_id, 0.0]]);
  const deps = makeDeps(weights, log);

  const outcomes = await svc.runDiversityPass({}, deps);

  assert.equal(outcomes[0].applied, false);
  assert.equal(outcomes[0].new_weight, 0);
  assert.equal(log.applyCalls.length, 0);
});

test("runDiversityPass isolates per-finding errors — one failure does not block others", async () => {
  // Same digest-discipline as rem-audit: the diversity pass runs every
  // REM cycle and a transient apply failure on one lesson must not poison
  // the whole pass. Pin per-finding error isolation.
  const svc = makeService();
  const a = makeFinding({ swarm_lesson_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  const b = makeFinding({ swarm_lesson_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
  const c = makeFinding({ swarm_lesson_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" });
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [a, b, c];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map([
    [a.swarm_lesson_id, 1.0],
    [b.swarm_lesson_id, 1.0],
    [c.swarm_lesson_id, 1.0],
  ]);
  const deps = makeDeps(weights, log, { failApply: b.swarm_lesson_id });

  const outcomes = await svc.runDiversityPass({}, deps);

  assert.equal(outcomes.length, 3);
  assert.equal(outcomes[0].applied, true);
  assert.equal(outcomes[0].error, undefined);
  assert.equal(outcomes[1].applied, false);
  assert.match(outcomes[1].error ?? "", /stub apply fail/);
  assert.equal(outcomes[2].applied, true);
  assert.equal(outcomes[2].error, undefined);
  // Only A and C made it to the audit log.
  assert.equal(log.applyCalls.length, 2);
  assert.deepEqual(
    log.applyCalls.map((c) => c.lessonId).sort(),
    [a.swarm_lesson_id, c.swarm_lesson_id].sort(),
  );
});

test("runDiversityPass surfaces read errors as outcome.error without throwing", async () => {
  const svc = makeService();
  const finding = makeFinding();
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [finding];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map<string, number>();
  const deps = makeDeps(weights, log, { failRead: finding.swarm_lesson_id });

  const outcomes = await svc.runDiversityPass({}, deps);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].applied, false);
  assert.match(outcomes[0].error ?? "", /stub read fail/);
  assert.equal(log.applyCalls.length, 0);
});

test("runDiversityPass preserves SQL-layer invariant: outcome.new_weight <= outcome.prev_weight", async () => {
  // Cross-check the orchestrator output against the SQL CHECK on
  // lesson_diversity_log. Even if scoreFinding's clamp later regresses,
  // this end-to-end pin keeps the orchestrator from emitting audit rows
  // that the DB would reject.
  const svc = makeService();
  const findings = [
    makeFinding({ swarm_lesson_id: "11111111-1111-1111-1111-111111111111", over_concentration: 0.8 }),
    makeFinding({ swarm_lesson_id: "22222222-2222-2222-2222-222222222222", over_concentration: 0.95 }),
    makeFinding({ swarm_lesson_id: "33333333-3333-3333-3333-333333333333", over_concentration: 1.0 }),
  ];
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => findings;
  const log: StubLog = { applyCalls: [] };
  const weights = new Map(findings.map((f) => [f.swarm_lesson_id, 0.7] as [string, number]));
  const deps = makeDeps(weights, log);

  const outcomes = await svc.runDiversityPass({}, deps);

  for (const o of outcomes) {
    assert.ok(o.new_weight <= o.prev_weight, `${o.swarm_lesson_id}: new=${o.new_weight} prev=${o.prev_weight}`);
    assert.ok(o.new_weight >= 0, `${o.swarm_lesson_id}: negative new_weight ${o.new_weight}`);
  }
});

test("runDiversityPass outcome carries the finding's cohort + concentration metadata", async () => {
  // The 4i.4 wiring step (digest.ts step 3.7) needs the cohort ratio +
  // over value to print a meaningful summary. Pin that the orchestrator
  // forwards them from the finding to the outcome unchanged.
  const svc = makeService();
  const finding = makeFinding({
    topic_cohort_size: 7,
    near_dup_origin_count: 6,
    over_concentration: 6 / 7,
  });
  (svc as unknown as { findOverconcentrated: () => Promise<RemDiversityFinding[]> })
    .findOverconcentrated = async () => [finding];
  const log: StubLog = { applyCalls: [] };
  const weights = new Map([[finding.swarm_lesson_id, 1.0]]);
  const deps = makeDeps(weights, log);

  const [o] = await svc.runDiversityPass({}, deps);
  assert.equal(o.topic_cohort_size, 7);
  assert.equal(o.near_dup_origin_count, 6);
  assert.ok(Math.abs(o.over_concentration - 6 / 7) < 1e-9);
});
