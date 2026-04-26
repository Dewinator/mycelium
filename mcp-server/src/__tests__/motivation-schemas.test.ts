import { test } from "node:test";
import assert from "node:assert/strict";
import {
  motivationStatusSchema,
  listStimuliSchema,
  listGeneratedTasksSchema,
  approveGeneratedTaskSchema,
  dismissGeneratedTaskSchema,
  updateGeneratedTaskStatusSchema,
  triggerMotivationCycleSchema,
  driftScanSchema,
} from "../tools/motivation.js";

// ---------------------------------------------------------------------------
// motivation tool-schema contract
//
// Stimulus statuses are read by compute_affect() §arousal — the 'new'
// literal there must match what listStimuliSchema accepts. The other
// schemas pin the lifecycle of generated tasks (approve / dismiss /
// status-update) so any new state is a deliberate edit.
// ---------------------------------------------------------------------------

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

test("motivationStatusSchema and driftScanSchema accept empty input", () => {
  assert.ok(motivationStatusSchema.safeParse({}).success);
  assert.ok(driftScanSchema.safeParse({}).success);
});

test("listStimuliSchema.status enum is exactly the 5 stimulus lifecycle values", () => {
  const ok = ["new", "scored", "task_generated", "dismissed", "acted"];
  for (const s of ok) {
    assert.ok(listStimuliSchema.safeParse({ status: s }).success, `'${s}' should pass`);
  }
  assert.ok(!listStimuliSchema.safeParse({ status: "pending" }).success);
});

test("listStimuliSchema.band enum covers the 5 affect-bands", () => {
  for (const b of ["ignore", "log", "explore", "act", "urgent"]) {
    assert.ok(listStimuliSchema.safeParse({ band: b }).success, `'${b}' should pass`);
  }
  assert.ok(!listStimuliSchema.safeParse({ band: "panic" }).success);
});

test("listStimuliSchema applies safe defaults (since_hours=168, limit=25)", () => {
  const parsed = listStimuliSchema.parse({});
  assert.equal(parsed.since_hours, 168);
  assert.equal(parsed.limit, 25);
});

test("approveGeneratedTaskSchema requires a UUID task_id", () => {
  assert.ok(approveGeneratedTaskSchema.safeParse({ task_id: VALID_UUID }).success);
  assert.ok(!approveGeneratedTaskSchema.safeParse({ task_id: "not-a-uuid" }).success);
  assert.ok(!approveGeneratedTaskSchema.safeParse({}).success);
});

test("dismissGeneratedTaskSchema requires UUID task_id only", () => {
  assert.ok(dismissGeneratedTaskSchema.safeParse({ task_id: VALID_UUID }).success);
  assert.ok(!dismissGeneratedTaskSchema.safeParse({}).success);
});

test("updateGeneratedTaskStatusSchema enforces the 6-state machine", () => {
  const states = ["proposed", "approved", "dismissed", "in_progress", "done", "abandoned"];
  for (const s of states) {
    assert.ok(
      updateGeneratedTaskStatusSchema.safeParse({ task_id: VALID_UUID, status: s }).success,
      `state '${s}' should be valid`
    );
  }
  assert.ok(
    !updateGeneratedTaskStatusSchema.safeParse({ task_id: VALID_UUID, status: "rejected" }).success,
    "unknown state must be rejected"
  );
});

test("triggerMotivationCycleSchema.force defaults to false (idempotent unless overridden)", () => {
  const parsed = triggerMotivationCycleSchema.parse({});
  assert.equal(parsed.force, false);
  assert.equal(triggerMotivationCycleSchema.parse({ force: true }).force, true);
});

test("listGeneratedTasksSchema.status enum is consistent with updateGeneratedTaskStatusSchema", () => {
  const states = ["proposed", "approved", "dismissed", "in_progress", "done", "abandoned"];
  for (const s of states) {
    assert.ok(
      listGeneratedTasksSchema.safeParse({ status: s }).success,
      `'${s}' must be filterable since it's a real state`
    );
  }
});
