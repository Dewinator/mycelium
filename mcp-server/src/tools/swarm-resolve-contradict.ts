/**
 * `swarm_resolve_contradict` MCP tool — second write-side slice of issue #143.
 *
 * Operator-side resolution of a §10.3 contradict pair via the
 * migration-086 `operator_resolve_contradict(UUID, TEXT)` RPC. Three
 * outcomes (a / b / park) — see SwarmResolveContradictService for the
 * semantic contract.
 *
 * Behind `OPENCLAW_ALLOW_SWARM_WRITE=1` (mirrors `swarm_pin_lesson`):
 * the tool deletes a swarm_lessons row on a/b decisions and writes a
 * tier_promotion_log audit row, both of which are firebreak-protected
 * substrate. No agent should mutate that without explicit operator opt-in.
 *
 * Memory-bus side-effect on success: a `decisions`-category memory tagged
 * `swarm` so the agent's own resolve decisions become recallable. Best-
 * effort — the RPC's audit trail in `tier_promotion_log` and the resolved_at
 * stamp on `swarm_lesson_contradictions` are the durable record; the memory
 * row is a recall convenience for the agent's own future introspection.
 */

import { z } from "zod";
import { MemoryService } from "../services/supabase.js";
import {
  SwarmResolveContradictService,
  type ResolveContradictDecision,
  type ResolveContradictOutcome,
} from "../services/swarm-resolve-contradict.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const swarmResolveContradictSchema = z.object({
  pair_id: z
    .string()
    .regex(UUID_REGEX, "pair_id must be a UUID")
    .describe(
      "UUID of the swarm_lesson_contradictions row to resolve.",
    ),
  decision: z
    .enum(["a", "b", "park"])
    .describe(
      "Resolution outcome. 'a' = keep lesson a, delete lesson b, promote a to Tier-A. " +
        "'b' = mirror of a. 'park' = mark resolved without modifying either lesson.",
    ),
});

export type SwarmResolveContradictInput = z.infer<
  typeof swarmResolveContradictSchema
>;

export interface SwarmResolveContradictOutput {
  ok: boolean;
  outcome?: ResolveContradictOutcome;
  memory_recorded?: boolean;
  memory_error?: string;
  error?: string;
  fix_hint?: string;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
}

function asMcpResult(payload: SwarmResolveContradictOutput): McpToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Ethics-gate check. Mirrors `swarm_pin_lesson` and the
 * `OPENCLAW_ALLOW_BREEDING` pattern. A resolve-contradict on the a/b
 * branch deletes a swarm_lessons row and bumps the kept lesson's tier —
 * both writes need explicit operator consent.
 */
function isSwarmWriteAllowed(): boolean {
  return process.env.OPENCLAW_ALLOW_SWARM_WRITE === "1";
}

/**
 * Build the memory-bus content string for a successful resolve. Same
 * shape as the swarm_pin_lesson decision memory so dashboard + recall
 * tooling can filter on `category=decisions, tags includes swarm`.
 */
function describeOutcome(outcome: ResolveContradictOutcome): string {
  if (outcome.decision === "park") {
    return (
      `Operator parked swarm contradiction ${outcome.pair_id}: ` +
      `kept both lessons ${outcome.a_id} and ${outcome.b_id} at current tier.`
    );
  }
  const promotion = outcome.promoted_to_a
    ? "promoted kept lesson B → A"
    : "kept lesson was already at A (no promotion)";
  return (
    `Operator resolved swarm contradiction ${outcome.pair_id} ` +
    `(decision=${outcome.decision}): kept ${outcome.kept_id}, ` +
    `dropped ${outcome.dropped_id}; ${promotion}.`
  );
}

/**
 * Map a service-layer error into the MCP `{ ok:false, error, fix_hint }`
 * shape. The hint depends on the error keyword so an LLM caller learns
 * what to try next without crashing the session.
 */
function toStructuredError(message: string): SwarmResolveContradictOutput {
  let fix_hint: string;
  if (/unknown pair_id/i.test(message)) {
    fix_hint =
      "Verify the pair_id exists in swarm_lesson_contradictions. " +
      "Check spelling/case and that the pair has not already been deleted via CASCADE.";
  } else if (/already resolved/i.test(message)) {
    fix_hint =
      "Pair has already been resolved (either by a prior operator decision or §10.5 REM-audit). " +
      "Operator un-park is not exposed via MCP — touch swarm_lesson_contradictions directly if reopening is required.";
  } else if (/decision must be a\/b\/park/i.test(message)) {
    fix_hint =
      "Pass decision as one of 'a', 'b', or 'park'. The MCP schema enforces this — " +
      "this error indicates a malformed call or schema bypass.";
  } else {
    fix_hint =
      "Inspect the swarm_lesson_contradictions / swarm_lessons / tier_promotion_log " +
      "tables for the underlying DB error.";
  }
  return { ok: false, error: message, fix_hint };
}

/**
 * Pure handler — exposed for unit tests so they don't have to unwrap the
 * MCP `content` envelope. Same split as swarm-pin.ts.
 */
export async function swarmResolveContradict(
  service: SwarmResolveContradictService,
  memoryService: MemoryService,
  input: SwarmResolveContradictInput,
): Promise<SwarmResolveContradictOutput> {
  if (!isSwarmWriteAllowed()) {
    return {
      ok: false,
      error:
        "swarm_resolve_contradict requires OPENCLAW_ALLOW_SWARM_WRITE=1",
      fix_hint:
        "Operator must opt in by setting OPENCLAW_ALLOW_SWARM_WRITE=1 in " +
        "the MCP server environment. Without it, no MCP tool can write to " +
        "the swarm trust substrate (§3.4 / §10.6 firebreak).",
    };
  }

  let outcome: ResolveContradictOutcome;
  try {
    outcome = await service.resolveContradict(
      input.pair_id,
      input.decision as ResolveContradictDecision,
      service.defaultDeps(),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toStructuredError(message);
  }

  let memory_recorded = false;
  let memory_error: string | undefined;
  try {
    await memoryService.create({
      content: describeOutcome(outcome),
      category: "decisions",
      tags: ["swarm", "contradict-resolved", `decision-${outcome.decision}`],
      metadata: {
        pair_id: outcome.pair_id,
        decision: outcome.decision,
        ...(outcome.decision === "park"
          ? { a_id: outcome.a_id, b_id: outcome.b_id }
          : {
              kept_id: outcome.kept_id,
              dropped_id: outcome.dropped_id,
              promoted_to_a: outcome.promoted_to_a,
            }),
        source: "swarm_resolve_contradict",
      },
      source: "swarm_resolve_contradict",
    });
    memory_recorded = true;
  } catch (err) {
    memory_error = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: true,
    outcome,
    memory_recorded,
    ...(memory_error ? { memory_error } : {}),
  };
}

/**
 * MCP-facing adapter — wraps the pure handler's result in the
 * `{ content: [{ type, text }] }` envelope that `withErrorHandling`
 * expects. Same convention as swarmPinLessonHandler.
 */
export async function swarmResolveContradictHandler(
  service: SwarmResolveContradictService,
  memoryService: MemoryService,
  input: SwarmResolveContradictInput,
): Promise<McpToolResult> {
  const output = await swarmResolveContradict(service, memoryService, input);
  return asMcpResult(output);
}
