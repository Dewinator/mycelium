import { test } from "node:test";
import assert from "node:assert/strict";
import {
  neurochemUpdateSchema,
  neurochemGetSchema,
  neurochemGetCompatSchema,
  neurochemRecallParamsSchema,
  neurochemHorizonSchema,
  neurochemHistorySchema,
  neurochemResetSchema,
} from "../tools/neurochemistry.js";
import { NEUROCHEM_RECOGNISED_EVENTS } from "../services/affect.js";

// ---------------------------------------------------------------------------
// neurochemistry tool-schema contract
//
// Pins the input shapes for the seven neurochem_* tools. The `event` enum
// in particular must mirror NEUROCHEM_RECOGNISED_EVENTS (services/affect.ts)
// — both are read by compute_affect() to assemble its observable inputs.
// ---------------------------------------------------------------------------

test("neurochemUpdateSchema.event enum = NEUROCHEM_RECOGNISED_EVENTS", () => {
  for (const ev of NEUROCHEM_RECOGNISED_EVENTS) {
    const r = neurochemUpdateSchema.safeParse({ event: ev });
    assert.ok(r.success, `event '${ev}' should be accepted`);
  }
  const bad = neurochemUpdateSchema.safeParse({ event: "not_a_real_event" });
  assert.ok(!bad.success, "unknown event must be rejected");
});

test("neurochemUpdateSchema clamps outcome to [0..1]", () => {
  assert.ok(neurochemUpdateSchema.safeParse({ event: "task_complete", outcome: 0 }).success);
  assert.ok(neurochemUpdateSchema.safeParse({ event: "task_complete", outcome: 1 }).success);
  assert.ok(!neurochemUpdateSchema.safeParse({ event: "task_complete", outcome: -0.01 }).success);
  assert.ok(!neurochemUpdateSchema.safeParse({ event: "task_complete", outcome: 1.01 }).success);
});

test("neurochemUpdateSchema.intensity defaults to 1.0 and clamps to [0..2]", () => {
  const parsed = neurochemUpdateSchema.parse({ event: "idle" });
  assert.equal(parsed.intensity, 1.0);
  assert.ok(neurochemUpdateSchema.safeParse({ event: "idle", intensity: 2.0 }).success);
  assert.ok(!neurochemUpdateSchema.safeParse({ event: "idle", intensity: 2.01 }).success);
  assert.ok(!neurochemUpdateSchema.safeParse({ event: "idle", intensity: -0.01 }).success);
});

test("neurochemUpdateSchema.outcome is optional (arousal-only events)", () => {
  // 'idle' and 'novel_stimulus' are arousal-only — outcome must not be required.
  const parsed = neurochemUpdateSchema.parse({ event: "idle" });
  assert.equal(parsed.outcome, undefined);
});

test("neurochem*Schema.label defaults to env or 'main' (single-agent default)", () => {
  // The DEFAULT_LABEL resolution already happens inside the schema definition —
  // a missing label must parse and fill in a non-empty string.
  for (const schema of [
    neurochemGetSchema,
    neurochemGetCompatSchema,
    neurochemRecallParamsSchema,
    neurochemHorizonSchema,
    neurochemHistorySchema,
    neurochemResetSchema,
  ]) {
    const parsed = schema.parse({});
    assert.ok(typeof parsed.label === "string" && parsed.label.length > 0);
  }
});

test("neurochemHistorySchema.limit defaults and clamps to [1..30]", () => {
  const parsed = neurochemHistorySchema.parse({});
  assert.ok(typeof parsed.limit === "number");
  assert.ok(parsed.limit >= 1 && parsed.limit <= 30);
  assert.ok(!neurochemHistorySchema.safeParse({ limit: 0 }).success);
  assert.ok(!neurochemHistorySchema.safeParse({ limit: 31 }).success);
});
