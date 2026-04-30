import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LessonContradictionRunner,
  parseEmbedding,
  type RunDeps,
} from "../services/lesson-contradiction-runner.js";
import type {
  ApplyDeps,
  SwarmLessonRow,
} from "../services/lesson-contradiction-gate.js";

// ---------------------------------------------------------------------------
// lesson-contradiction-runner — Swarm Phase 4g.2 substrate (issue #137)
//
// The runner is a thin orchestrator over `applyContradictionGate`. The
// gate's own contracts are pinned in `lesson-contradiction-gate.test.ts`.
// These tests only cover the runner's added behaviour:
//
//   1. parseEmbedding: accept pgvector text "[a,b,c]", number[], and the
//      degenerate inputs the loader can plausibly hand it.
//   2. runContradictionPass: load + iterate the recent window, exclude
//      newcomers from the prior pool, scan earlier-newcomers as an
//      additional candidate set, and never throw across newcomers.
//   3. defaultDeps is purely DB-glue — exercised in the integration test
//      that the issue-#137 acceptance follow-up will add. Out of scope
//      for the substrate-only PR.
// ---------------------------------------------------------------------------

function unitAxis(i: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[i % 768] = 1;
  return v;
}

function makeRow(
  id: string,
  content: string,
  embeddingAxis: number,
): SwarmLessonRow {
  return { id, content, embedding: unitAxis(embeddingAxis) };
}

// ---------------------------------------------------------------------------
// (1) parseEmbedding
// ---------------------------------------------------------------------------

test("parseEmbedding parses the pgvector text representation", () => {
  assert.deepEqual(parseEmbedding("[1, 2, 3.5]"),     [1, 2, 3.5]);
  assert.deepEqual(parseEmbedding("[1,2,3]"),         [1, 2, 3]);
  assert.deepEqual(parseEmbedding("[ -1.0 ,0,1.0 ]"), [-1, 0, 1]);
});

test("parseEmbedding returns [] on degenerate inputs (no NaN, no throw)", () => {
  // Every degenerate-input path returns [] so the gate's own
  // `if embedding.length === 0` short-circuit fires cleanly without a
  // special-case branch in the runner.
  assert.deepEqual(parseEmbedding(null),       []);
  assert.deepEqual(parseEmbedding(undefined),  []);
  assert.deepEqual(parseEmbedding(""),         []);
  assert.deepEqual(parseEmbedding("[]"),       []);
  assert.deepEqual(parseEmbedding("not json"), []);
  // Mixed strings: keep only the finite numbers, skip the garbage.
  assert.deepEqual(parseEmbedding("[1, x, 2]"), [1, 2]);
});

test("parseEmbedding passes number[] through and coerces stringy numbers", () => {
  assert.deepEqual(parseEmbedding([1, 2, 3]),         [1, 2, 3]);
  // Some PostgREST adapters hand back stringy numbers — coerce so the
  // gate's cosine math sees real Number values, not type-coerced NaNs.
  assert.deepEqual(parseEmbedding(["1", "2", "3.5"]), [1, 2, 3.5]);
  // Filter NaNs that result from coercion failure rather than poison
  // the cosine compare. A cleaner upstream would catch this, but the
  // runner is the last line of defense before the gate.
  assert.deepEqual(parseEmbedding([1, "bad", 2]),     [1, 2]);
});

// ---------------------------------------------------------------------------
// (2) runContradictionPass — orchestration
// ---------------------------------------------------------------------------

function makeRecorder() {
  const calls: Array<{ a_id: string; b_id: string; cosine: number; confidence: number; reason: string }> = [];
  const fn: ApplyDeps["recordContradiction"] = async (args) => {
    calls.push(args);
    return { ok: true, id: "edge-" + (calls.length), ...args };
  };
  return { calls, fn };
}

function makeRunnerWithFakeDeps(
  recent: SwarmLessonRow[],
  priors: SwarmLessonRow[],
  recorder: ApplyDeps["recordContradiction"],
  recordExperience?: ApplyDeps["recordExperience"],
): { runner: LessonContradictionRunner; deps: RunDeps; loaderCalls: { recent: number; priors: number } } {
  const runner = new LessonContradictionRunner(
    "http://stub-supabase",
    "stub-key",
  );
  const loaderCalls = { recent: 0, priors: 0 };
  const deps: RunDeps = {
    async loadRecent() {
      loaderCalls.recent += 1;
      return recent;
    },
    async loadPriors() {
      loaderCalls.priors += 1;
      return priors;
    },
    gateDeps: {
      recordContradiction: recorder,
      recordExperience,
    },
  };
  return { runner, deps, loaderCalls };
}

test("runContradictionPass loads recent + priors exactly once each", async () => {
  // The runner's load discipline matters: a per-newcomer reload would
  // turn an O(N) sweep into O(N²) DB round-trips. Pin that the loaders
  // are called exactly once per pass regardless of the recent set size.
  const recent: SwarmLessonRow[] = [
    makeRow("11111111-1111-1111-1111-111111111111", "Sign Lesson records before broadcast.", 7),
    makeRow("22222222-2222-2222-2222-222222222222", "Sign Lesson records before broadcast.", 8),
    makeRow("33333333-3333-3333-3333-333333333333", "Sign Lesson records before broadcast.", 9),
  ];
  const rec = makeRecorder();
  const { runner, deps, loaderCalls } = makeRunnerWithFakeDeps(recent, [], rec.fn);
  await runner.runContradictionPass({}, deps);
  assert.equal(loaderCalls.recent, 1);
  assert.equal(loaderCalls.priors, 1);
});

test("runContradictionPass detects newcomer ↔ prior contradictions and persists them", async () => {
  const newcomerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const priorId    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const recent: SwarmLessonRow[] = [
    { id: newcomerId, content: "Sign Lesson records before broadcast.",     embedding: unitAxis(0) },
  ];
  const priors: SwarmLessonRow[] = [
    { id: priorId,    content: "Do not sign Lesson records before broadcast.", embedding: unitAxis(0) },
  ];
  const rec = makeRecorder();
  const { runner, deps } = makeRunnerWithFakeDeps(recent, priors, rec.fn);

  const summary = await runner.runContradictionPass({}, deps);

  assert.equal(summary.newcomers_scanned,    1);
  assert.equal(summary.priors_loaded,        1);
  assert.equal(summary.total_findings,       1);
  assert.equal(summary.total_edges_recorded, 1);
  assert.equal(rec.calls.length,             1);
  assert.equal(rec.calls[0].a_id, newcomerId);
  assert.equal(rec.calls[0].b_id, priorId);
});

test("runContradictionPass excludes newcomers from the prior pool", async () => {
  // Suppose the loader (incorrectly) returned the same row in both
  // recent and priors. The runner must strip it from the prior pool so
  // a row is not compared against itself via the prior path. The gate
  // also has a self-pair guard, but that only catches `id === id`; an
  // overzealous prior-pool query could return TWO copies of the same
  // logical row that DO have different ids and we'd double-count.
  const newcomer = makeRow("11111111-1111-1111-1111-111111111111", "Sign always.", 0);
  const recent: SwarmLessonRow[] = [newcomer];
  // The priors loader returned the newcomer itself plus one real prior.
  const priorReal: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Do not sign ever.",
    embedding: unitAxis(0),
  };
  const priors: SwarmLessonRow[] = [newcomer, priorReal];
  const rec = makeRecorder();
  const { runner, deps } = makeRunnerWithFakeDeps(recent, priors, rec.fn);

  const summary = await runner.runContradictionPass({}, deps);
  // priors_loaded reflects the FILTERED prior count (newcomer stripped).
  assert.equal(summary.priors_loaded, 1);
  // Exactly one finding — newcomer ↔ priorReal, not newcomer ↔ newcomer.
  assert.equal(summary.total_findings, 1);
  assert.equal(rec.calls[0].b_id,      priorReal.id);
});

test("runContradictionPass detects contradictions WITHIN the recent batch (newcomer ↔ earlier newcomer)", async () => {
  // Two contradicting lessons that arrived in the SAME cycle MUST be
  // detected — otherwise a peer can dodge the gate by clustering its
  // self-contradicting broadcast inside one digest window. The runner
  // hands earlier-newcomers as additional candidates for each later
  // newcomer.
  const a: SwarmLessonRow = { id: "11111111-1111-1111-1111-111111111111", content: "Sign Lesson records before broadcast.",     embedding: unitAxis(0) };
  const b: SwarmLessonRow = { id: "22222222-2222-2222-2222-222222222222", content: "Do not sign Lesson records before broadcast.", embedding: unitAxis(0) };
  const recent: SwarmLessonRow[] = [a, b];
  const rec = makeRecorder();
  const { runner, deps } = makeRunnerWithFakeDeps(recent, [], rec.fn);

  const summary = await runner.runContradictionPass({}, deps);
  // Only one direction is checked (b against earlier-newcomer a). The
  // canonical-ordering inside the RPC collapses the b→a check that
  // would otherwise reach the same edge from the a→b direction next
  // cycle, so we don't double-record here.
  assert.equal(summary.total_findings,       1);
  assert.equal(summary.total_edges_recorded, 1);
  assert.equal(rec.calls.length,             1);
  // The runner reports the LATER newcomer as `new_lesson_id` so the
  // edge identity is (later, earlier) — the RPC will canonicalise.
  assert.equal(rec.calls[0].a_id, b.id);
  assert.equal(rec.calls[0].b_id, a.id);
});

test("runContradictionPass returns a per-newcomer outcome row even when there are no findings", async () => {
  const newcomer = makeRow("11111111-1111-1111-1111-111111111111", "Sign always.", 0);
  // High-cosine but SAME polarity → corroboration, not contradiction.
  const prior:    SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Sign always (same lesson, different wording).",
    embedding: unitAxis(0),
  };
  const rec = makeRecorder();
  const { runner, deps } = makeRunnerWithFakeDeps([newcomer], [prior], rec.fn);

  const summary = await runner.runContradictionPass({}, deps);
  assert.equal(summary.outcomes.length, 1);
  assert.equal(summary.outcomes[0].new_lesson_id, newcomer.id);
  assert.equal(summary.outcomes[0].findings.length, 0);
  assert.equal(summary.outcomes[0].edges_recorded,  0);
  assert.equal(summary.total_findings,              0);
  assert.equal(rec.calls.length,                    0);
});

test("runContradictionPass isolates per-newcomer failures (one bad row doesn't poison the rest)", async () => {
  // Two newcomers, both with a contradicting prior. The first newcomer's
  // recordContradiction throws; the second's must still complete.
  const aNew: SwarmLessonRow = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", content: "Sign Lesson records.",     embedding: unitAxis(0) };
  const bNew: SwarmLessonRow = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", content: "Sign Lesson records.",     embedding: unitAxis(0) };
  const aPri: SwarmLessonRow = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", content: "Do not sign Lesson records.", embedding: unitAxis(0) };
  const bPri: SwarmLessonRow = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2", content: "Do not sign Lesson records.", embedding: unitAxis(0) };

  let recordCalls = 0;
  const recorder: ApplyDeps["recordContradiction"] = async (args) => {
    recordCalls += 1;
    if (args.a_id === aNew.id) throw new Error("simulated DB transient");
    return { ok: true, ...args };
  };

  const runner = new LessonContradictionRunner("http://stub", "stub");
  // Two newcomers, two distinct priors (one per newcomer to keep the
  // counting clean — the gate's per-finding boundary is already covered
  // in lesson-contradiction-gate.test.ts).
  const recent = [aNew, bNew];
  // bNew sees aPri AND bPri AND earlier newcomer aNew. Same content +
  // same axis means bNew↔aNew is a finding too — but aNew is itself
  // a newcomer and was passed through the gate already (and its
  // recorder threw). The runner should not double-count; aNew is a
  // valid earlier-newcomer candidate for bNew regardless.
  const priors = [aPri, bPri];
  const deps: RunDeps = {
    async loadRecent() { return recent; },
    async loadPriors() { return priors; },
    gateDeps: { recordContradiction: recorder },
  };
  const summary = await runner.runContradictionPass({}, deps);
  // aNew: 1 finding (vs aPri AND vs bPri = 2 findings, but the recorder
  //        throws on a_id === aNew.id so 0 edges). gate's own per-
  //        finding boundary swallows the throw.
  // bNew: priors aPri + bPri + earlier-newcomer aNew. But aNew is same
  //        polarity as bNew → no contradiction. bNew vs aPri/bPri are
  //        opposite polarity → 2 findings, both persist (recorder no
  //        longer throws).
  assert.equal(summary.outcomes.length,    2);
  assert.equal(summary.outcomes[0].error,  undefined,
    "gate's per-finding boundary swallows individual recorder throws — no per-newcomer error surfaces here");
  assert.equal(summary.outcomes[0].edges_recorded, 0,
    "all of aNew's recorder calls threw");
  assert.equal(summary.outcomes[1].edges_recorded, 2,
    "bNew's recorder calls all succeed");
  // sanity: recordCalls counts every attempt, including the throws.
  assert.ok(recordCalls >= 4);
});

test("runContradictionPass forwards both gate deps (recordContradiction + recordExperience)", async () => {
  // The runner is the integration point that hands the gate's optional
  // recordExperience through. Pin that an injected recorder receives
  // one call per persisted edge.
  const newcomer = makeRow("11111111-1111-1111-1111-111111111111", "Sign always.", 0);
  const prior:    SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Do not sign ever.",
    embedding: unitAxis(0),
  };
  const rec = makeRecorder();
  const expCalls: Array<{ summary: string; tags: string[] }> = [];
  const recordExperience: ApplyDeps["recordExperience"] = async (args) => {
    expCalls.push({ summary: args.summary, tags: args.tags });
  };
  const { runner, deps } = makeRunnerWithFakeDeps([newcomer], [prior], rec.fn, recordExperience);

  const summary = await runner.runContradictionPass({}, deps);
  assert.equal(summary.total_experiences_logged, 1);
  assert.equal(expCalls.length,                  1);
  assert.ok(expCalls[0].tags.includes("phase-4g"),
    "gate-injected experiences carry the phase-4g breadcrumb 4h's REM self-audit looks for");
});

test("runContradictionPass propagates options to the loaders", async () => {
  const seenRecent: Array<{ recentWindowHours: number; newcomerLimit: number }> = [];
  const seenPriors: Array<{ priorWindowDays: number; priorLimit: number }> = [];
  const runner = new LessonContradictionRunner("http://stub", "stub");
  const deps: RunDeps = {
    async loadRecent(opts) { seenRecent.push(opts); return []; },
    async loadPriors(opts) { seenPriors.push(opts); return []; },
    gateDeps: { recordContradiction: async () => ({}) },
  };
  await runner.runContradictionPass({
    recentWindowHours: 6,
    priorWindowDays:   30,
    newcomerLimit:     50,
    priorLimit:        500,
  }, deps);
  assert.deepEqual(seenRecent[0], { recentWindowHours: 6,  newcomerLimit: 50 });
  assert.deepEqual(seenPriors[0], { priorWindowDays:   30, priorLimit:    500 });
});

test("runContradictionPass uses sensible defaults when opts is empty", async () => {
  // Pin defaults so a future change to e.g. the 24h window is a
  // deliberate, reviewable diff rather than a silent magic-number drift.
  const seenRecent: Array<{ recentWindowHours: number; newcomerLimit: number }> = [];
  const seenPriors: Array<{ priorWindowDays: number; priorLimit: number }> = [];
  const runner = new LessonContradictionRunner("http://stub", "stub");
  const deps: RunDeps = {
    async loadRecent(opts) { seenRecent.push(opts); return []; },
    async loadPriors(opts) { seenPriors.push(opts); return []; },
    gateDeps: { recordContradiction: async () => ({}) },
  };
  await runner.runContradictionPass({}, deps);
  assert.deepEqual(seenRecent[0], { recentWindowHours: 24,  newcomerLimit: 200 });
  assert.deepEqual(seenPriors[0], { priorWindowDays:   14,  priorLimit:    2000 });
});
