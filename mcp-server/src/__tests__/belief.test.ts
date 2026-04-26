import { test } from "node:test";
import assert from "node:assert/strict";
import { inferAction } from "../tools/belief.js";
import type { BeliefService } from "../services/belief.js";
import type { MemoryService } from "../services/supabase.js";
import type { NeurochemistryService } from "../services/neurochemistry.js";
import type { MemorySearchResult } from "../types/memory.js";

// ---------------------------------------------------------------------------
// `recalled` memory_event emission from infer_action.
//
// Why these tests matter: infer_action runs a recall probe to gauge task
// familiarity, and that probe is the *second* source of `recalled` events
// (after the recall tool itself, guarded in handlers.test.ts). Both feed
// compute_affect()'s curiosity / frustration terms — see
// docs/affect-observables.md §curiosity (`empty_recalls`, `low_conf_recalls`)
// and §frustration (`zero_hit_ratio`).
//
// The events from the two sources differ only in the `source` field
// (`mcp:recall` vs `mcp:infer_action`); compute_affect() does not split by
// source, so a regression that flipped the constant would silently double-
// count or under-count one branch. These tests pin the payload shape.
// ---------------------------------------------------------------------------

const UUID = "11111111-2222-3333-4444-555555555555";
const GENOME = "test-genome";

// Belief sidecar always unreachable in tests — fallback path is deterministic
// and exercises the same emission code regardless of which action it returns.
class FakeBeliefService implements Partial<BeliefService> {
  async infer(): Promise<null> { return null; }
}
const fakeBelief = new FakeBeliefService() as unknown as BeliefService;

// Neurochem.get throws → serotonin stays undefined, infer_action degrades
// to static action costs. Important: the error must be swallowed by the tool
// (it is, see belief.ts §"sidecar down or row missing"), so the recalled
// emission still has to fire.
class FakeNeurochemistryService implements Partial<NeurochemistryService> {
  async get(): Promise<never> { throw new Error("neurochem unreachable"); }
}
const fakeNeurochem = new FakeNeurochemistryService() as unknown as NeurochemistryService;

class FakeMemoryService implements Partial<MemoryService> {
  recalledEvents: Array<{ hits: number; topScore: number; queryLength: number; source: string }> = [];

  constructor(private opts: { searchResults?: MemorySearchResult[] } = {}) {}

  async search(): Promise<MemorySearchResult[]> {
    return this.opts.searchResults ?? [];
  }

  async emitRecalled(hits: number, topScore: number, queryLength: number, source: string): Promise<void> {
    this.recalledEvents.push({ hits, topScore, queryLength, source });
  }
}

function makeHit(id: string, score: number): MemorySearchResult {
  return {
    id,
    content: `content ${id.slice(0, 4)}`,
    category: "topics",
    tags: [],
    metadata: {},
    stage: "episodic",
    strength: 1.0,
    importance: 0.5,
    access_count: 0,
    pinned: false,
    relevance: 0.9,
    strength_now: 1.0,
    salience: 1.0,
    effective_score: score,
    created_at: "2026-04-25T00:00:00Z",
  };
}

test("infer_action emits recalled with hits=0, topScore=0 on empty probe", async () => {
  const svc = new FakeMemoryService({ searchResults: [] });
  const task = "what should I do about the broken trigger?";
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: task,
    limit: 5,
  });
  assert.equal(svc.recalledEvents.length, 1);
  const ev = svc.recalledEvents[0];
  assert.equal(ev.hits, 0);
  assert.equal(ev.topScore, 0);
  assert.equal(ev.queryLength, task.length);
});

test("infer_action emits recalled with hit count and top score", async () => {
  const id2 = "22222222-2222-3333-4444-555555555555";
  const svc = new FakeMemoryService({
    searchResults: [makeHit(UUID, 0.842), makeHit(id2, 0.612)],
  });
  const task = "two probe hits";
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: task,
    limit: 5,
  });
  assert.equal(svc.recalledEvents.length, 1);
  const ev = svc.recalledEvents[0];
  assert.equal(ev.hits, 2);
  assert.equal(ev.topScore, 0.842);
  assert.equal(ev.queryLength, task.length);
});

test("infer_action recalled event uses source=mcp:infer_action (not mcp:recall)", async () => {
  // Disambiguates the two recall sources. compute_affect() doesn't split by
  // source, so flipping the constant would silently double-count via the
  // recall tool's emission. The test pins the value so a future refactor
  // can't accidentally collapse the two channels.
  const svc = new FakeMemoryService({ searchResults: [makeHit(UUID, 0.5)] });
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: "anything",
    limit: 5,
  });
  assert.equal(svc.recalledEvents.length, 1);
  assert.equal(svc.recalledEvents[0].source, "mcp:infer_action");
});

test("infer_action emits exactly one recalled event per call", async () => {
  // Guards against accidental re-emission if inferAction grows additional
  // recall probes. compute_affect()'s `empty_recalls` / `zero_hit_ratio`
  // assume one event per inference call.
  const svc = new FakeMemoryService({ searchResults: [] });
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: "single probe",
    limit: 5,
  });
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: "another single probe",
    limit: 5,
  });
  assert.equal(svc.recalledEvents.length, 2);
});

test("infer_action queryLength reflects task_description length, not content", async () => {
  // queryLength is read by compute_affect() as a proxy for query specificity
  // (long tasks → narrow probes). It must follow the input string length, not
  // the content of any returned hit.
  const svc = new FakeMemoryService({
    searchResults: [makeHit(UUID, 0.7)],
  });
  const task = "x".repeat(123);
  await inferAction(svc as unknown as MemoryService, fakeBelief, fakeNeurochem, GENOME, {
    task_description: task,
    limit: 5,
  });
  assert.equal(svc.recalledEvents[0].queryLength, 123);
});
