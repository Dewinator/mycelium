import { z } from "zod";
import type { AffectService, AffectEvent } from "../services/affect.js";
import { AffectService as AffectServiceClass } from "../services/affect.js";

// ===========================================================================
// get_affect
// ===========================================================================
export const getAffectSchema = z.object({});

function formatState(title: string, state: {
  curiosity: number; frustration: number; satisfaction: number; confidence: number;
  last_event?: string | null; hours_since?: number;
}): string {
  const bar = (v: number) => "█".repeat(Math.round(v * 10)).padEnd(10, "·");
  const since = state.hours_since != null ? ` (${state.hours_since.toFixed(1)}h since last event)` : "";
  const last = state.last_event ? ` — last: ${state.last_event}` : "";
  return (
    `${title}${last}${since}\n` +
    `  curiosity    [${bar(state.curiosity)}]  ${state.curiosity.toFixed(2)}\n` +
    `  frustration  [${bar(state.frustration)}]  ${state.frustration.toFixed(2)}\n` +
    `  satisfaction [${bar(state.satisfaction)}]  ${state.satisfaction.toFixed(2)}\n` +
    `  confidence   [${bar(state.confidence)}]  ${state.confidence.toFixed(2)}`
  );
}

export async function getAffect(service: AffectService, _input: z.infer<typeof getAffectSchema>) {
  const state = await service.get();
  const bias = AffectServiceClass.biasFromState(state);
  const text =
    formatState("Affective state", state) +
    `\n  → recall bias: ${bias.reason} (Δk=${bias.k_delta}${bias.score_threshold != null ? `, threshold=${bias.score_threshold.toFixed(2)}` : ""})`;
  return { content: [{ type: "text" as const, text }] };
}

// ===========================================================================
// update_affect
// ===========================================================================
export const updateAffectSchema = z.object({
  event: z
    .enum([
      "success",
      "failure",
      "unknown",
      "recall_empty",
      "recall_rich",
      "recall_touch",
      "novel_encoding",
    ])
    .describe(
      "Which affective trigger fired. 'success' after a completed task; 'failure' after error; 'unknown' when no prior knowledge existed; 'recall_empty' when a recall returned nothing; 'recall_rich' when recall returned many strong hits; 'novel_encoding' after a non-duplicate remember/absorb."
    ),
  intensity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.5)
    .describe("How strong the event was (0..1). Default 0.5."),
});

export async function updateAffect(
  service: AffectService,
  input: z.infer<typeof updateAffectSchema>
) {
  const newState = await service.apply(input.event as AffectEvent, input.intensity);
  if (!newState) {
    return {
      content: [{ type: "text" as const, text: `Affect update (${input.event}) failed silently — state unchanged.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: formatState(`Affect after '${input.event}' (i=${input.intensity.toFixed(2)})`, newState) }],
  };
}

// ===========================================================================
// reset_affect (Notbremse — für Dev/Tests)
// ===========================================================================
export const resetAffectSchema = z.object({});

export async function resetAffect(service: AffectService, _input: z.infer<typeof resetAffectSchema>) {
  const s = await service.reset();
  return {
    content: [{ type: "text" as const, text: formatState("Affect reset to defaults", s) }],
  };
}
