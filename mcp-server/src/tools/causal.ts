import { z } from "zod";
import type { CausalService, CausalRelation } from "../services/causal.js";

// ===========================================================================
// suggest_causes
// ===========================================================================
export const suggestCausesSchema = z.object({
  experience_id: z.string().uuid().describe("The 'effect' experience — what we're looking for the cause of"),
  window_hours: z.number().min(1).max(720).optional().default(48)
    .describe("How far back to look (default 48h)"),
  min_similarity: z.number().min(0).max(1).optional().default(0.55)
    .describe("Minimum semantic similarity to be considered a candidate"),
  max: z.number().int().min(1).max(20).optional().default(5),
});

export async function suggestCauses(
  service: CausalService,
  input: z.infer<typeof suggestCausesSchema>
) {
  const results = await service.suggestCauses(
    input.experience_id,
    input.window_hours,
    input.min_similarity,
    input.max
  );

  if (results.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No plausible causes found in the given window." }],
    };
  }

  const text = results
    .map((r, i) =>
      `${i + 1}. [${r.outcome}] sim=${r.similarity.toFixed(2)} age=${r.age_hours.toFixed(1)}h hint=${r.confidence_hint.toFixed(2)}\n   "${r.summary}"\n   id: ${r.cause_id}`
    )
    .join("\n\n");
  return { content: [{ type: "text" as const, text: `Plausible causes:\n\n${text}\n\nConfirm with record_cause(cause_id, effect_id) to turn a candidate into a recorded edge.` }] };
}

// ===========================================================================
// record_cause
// ===========================================================================
export const recordCauseSchema = z.object({
  cause_id: z.string().uuid().describe("The experience that caused something"),
  effect_id: z.string().uuid().describe("The experience that was caused"),
  relation: z
    .enum(["caused", "enabled", "prevented", "contributed"])
    .optional()
    .default("caused")
    .describe("Kind of causal link. 'caused' = direct, 'enabled' = made possible, 'prevented' = blocked, 'contributed' = partial"),
  confidence: z.number().min(0).max(1).optional().default(0.6),
  note: z.string().optional().describe("Why do you think this cause→effect link holds?"),
});

export async function recordCause(
  service: CausalService,
  input: z.infer<typeof recordCauseSchema>
) {
  const id = await service.recordCause(
    input.cause_id,
    input.effect_id,
    input.relation as CausalRelation,
    input.confidence,
    "explicit",
    input.note
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `Recorded: ${input.cause_id.slice(0, 8)} --${input.relation}--> ${input.effect_id.slice(0, 8)} [edge id: ${id.slice(0, 8)}, confidence=${input.confidence}]`,
      },
    ],
  };
}

// ===========================================================================
// causal_chain
// ===========================================================================
export const causalChainSchema = z.object({
  experience_id: z.string().uuid().describe("Root experience to trace from"),
  direction: z
    .enum(["causes", "effects"])
    .optional()
    .default("causes")
    .describe("'causes' = what led to this (backwards), 'effects' = what came from this (forwards)"),
  max_depth: z.number().int().min(1).max(6).optional().default(3),
});

export async function causalChain(
  service: CausalService,
  input: z.infer<typeof causalChainSchema>
) {
  const chain = await service.causalChain(
    input.experience_id,
    input.direction,
    input.max_depth
  );
  if (chain.length <= 1) {
    return {
      content: [{ type: "text" as const, text: `No ${input.direction} recorded for this experience yet.` }],
    };
  }

  const arrow = input.direction === "causes" ? "←" : "→";
  const text = chain
    .map((n) => {
      const indent = "  ".repeat(n.depth);
      const edge = n.depth === 0
        ? "ROOT"
        : `${arrow} [${n.relation ?? "?"}] conf=${n.edge_confidence.toFixed(2)} path=${n.path_confidence.toFixed(2)}`;
      return `${indent}${edge}  [${n.outcome}] ${n.summary}  (id: ${n.experience_id.slice(0, 8)})`;
    })
    .join("\n");
  return {
    content: [{ type: "text" as const, text: `Causal chain (${input.direction}, depth≤${input.max_depth}):\n\n${text}` }],
  };
}
