import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AFFECT_TO_NEUROCHEM_EVENT_MAP,
  NEUROCHEM_RECOGNISED_EVENTS,
  type AffectEvent,
} from "../services/affect.js";

// ---------------------------------------------------------------------------
// affect_apply() event-mapping wire-literal contract
//
// `affect_apply(p_event, p_intensity)` (migration 042_neurochemistry.sql)
// translates legacy AffectEvent labels into neurochem-engine events before
// calling `neurochem_apply()`. The downstream `neurochem_apply()` rejects
// unknown event labels by silently mis-applying the delta — and
// compute_affect() (Issue #11) reads the same neurochem state as its
// arousal/valence ground truth. A drift between the TS AffectEvent union,
// the SQL CASE-statement mapping, and the neurochem enum would be
// invisible at compile time and at runtime, but would corrupt the affect
// engine.
//
// AFFECT_TO_NEUROCHEM_EVENT_MAP is the documented mirror of the SQL CASE.
// These guards keep both sides honest and surface any legacy AffectEvent
// that lacks a SQL counterpart (currently: recall_touch — by design,
// tracked as a Phase-2 follow-up alongside Issue #11).
// ---------------------------------------------------------------------------

const ALL_AFFECT_EVENTS: readonly AffectEvent[] = [
  "success",
  "failure",
  "unknown",
  "recall_empty",
  "recall_rich",
  "recall_touch",
  "novel_encoding",
];

test("AFFECT_TO_NEUROCHEM_EVENT_MAP has an entry for every AffectEvent", () => {
  for (const ev of ALL_AFFECT_EVENTS) {
    assert.ok(
      ev in AFFECT_TO_NEUROCHEM_EVENT_MAP,
      `AffectEvent '${ev}' has no mapping — neurochem_apply would receive a stale label`
    );
  }
  assert.equal(
    Object.keys(AFFECT_TO_NEUROCHEM_EVENT_MAP).length,
    ALL_AFFECT_EVENTS.length,
    "extra entries in AFFECT_TO_NEUROCHEM_EVENT_MAP — a legacy event was added without updating ALL_AFFECT_EVENTS pin"
  );
});

test("every mapped neurochem event is in NEUROCHEM_RECOGNISED_EVENTS", () => {
  const recognised = new Set<string>(NEUROCHEM_RECOGNISED_EVENTS);
  for (const [legacy, neurochem] of Object.entries(AFFECT_TO_NEUROCHEM_EVENT_MAP)) {
    if (neurochem === "__UNMAPPED__") continue; // documented gap (recall_touch)
    assert.ok(
      recognised.has(neurochem),
      `${legacy} maps to '${neurochem}', which neurochem_apply does not recognise`
    );
  }
});

test("recall_touch is the only documented unmapped AffectEvent", () => {
  // If you map recall_touch in SQL (and update AFFECT_TO_NEUROCHEM_EVENT_MAP),
  // delete this test. If a NEW unmapped event appears, fail loudly: it is
  // a silent drift waiting to corrupt compute_affect().
  const unmapped = Object.entries(AFFECT_TO_NEUROCHEM_EVENT_MAP)
    .filter(([, v]) => v === "__UNMAPPED__")
    .map(([k]) => k);
  assert.deepEqual(
    unmapped,
    ["recall_touch"],
    "unexpected set of unmapped AffectEvents — surface drift from affect_apply() SQL"
  );
});

test("NEUROCHEM_RECOGNISED_EVENTS pins the seven labels neurochemUpdateSchema enforces", () => {
  // Mirror of the enum in tools/neurochemistry.ts:neurochemUpdateSchema.event.
  // If neurochem_apply() ever accepts a new label, update both lists together.
  assert.deepEqual(
    [...NEUROCHEM_RECOGNISED_EVENTS],
    [
      "task_complete",
      "task_failed",
      "novel_stimulus",
      "familiar_task",
      "idle",
      "error",
      "teacher_consulted",
    ]
  );
});
