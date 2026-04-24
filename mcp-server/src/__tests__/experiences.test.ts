import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeToEventType } from "../services/experiences.js";

// These tests pin the mapping used by ExperienceService.record() to emit
// `agent_completed` / `agent_error` memory_events after each episode. The
// mapping is a compute_affect() input — see docs/affect-observables.md
// §frustration (retry_rate = agent_error / agent_completed).
// Breaking the mapping silently would skew the frustration dimension; this
// test is the guard.

test("outcomeToEventType: 'failure' → agent_error", () => {
  assert.equal(outcomeToEventType("failure"), "agent_error");
});

test("outcomeToEventType: 'success' → agent_completed", () => {
  assert.equal(outcomeToEventType("success"), "agent_completed");
});

test("outcomeToEventType: 'partial' → agent_completed", () => {
  assert.equal(outcomeToEventType("partial"), "agent_completed");
});

test("outcomeToEventType: 'unknown' → null (no event emitted)", () => {
  assert.equal(outcomeToEventType("unknown"), null);
});

test("outcomeToEventType: null/undefined → null", () => {
  assert.equal(outcomeToEventType(null), null);
  assert.equal(outcomeToEventType(undefined), null);
});

test("outcomeToEventType: unrecognized string → null", () => {
  assert.equal(outcomeToEventType("in_progress"), null);
  assert.equal(outcomeToEventType(""), null);
});
