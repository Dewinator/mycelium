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
// preview_affect — read-only compute_affect() reference implementation
// ===========================================================================
export const previewAffectSchema = z.object({});

export async function previewAffect(
  service: AffectService,
  _input: z.infer<typeof previewAffectSchema>,
) {
  const preview = await service.previewCompute();
  const c = preview.computed;
  const bar = (v: number) => "█".repeat(Math.round(v * 10)).padEnd(10, "·");
  const signBar = (v: number) => {
    const n = Math.round(v * 5);
    return n >= 0 ? "·····".padStart(5, "·") + "█".repeat(n).padEnd(5, "·")
                  : "·".repeat(5) + "█".repeat(-n).padStart(5, "·").padEnd(5, "·");
  };
  const lines = [
    `compute_affect() preview — per ${preview.spec}`,
    `  valence      [${signBar(c.valence)}]  ${c.valence.toFixed(2).padStart(5)}   (72h recency-weighted outcome)`,
    `  arousal      [${bar(c.arousal)}]  ${c.arousal.toFixed(2)}   (event rate + tool diversity + novel stimuli)`,
    `  curiosity    [${bar(c.curiosity)}]  ${c.curiosity.toFixed(2)}   (empty/low-conf recalls + unreflected ratio)`,
    `  satisfaction [${bar(c.satisfaction)}]  ${c.satisfaction.toFixed(2)}   (success rate + pleased ratio + useful delta)`,
    `  frustration  [${bar(c.frustration)}]  ${c.frustration.toFixed(2)}   (retry rate + zero-hit ratio + open conflicts)`,
    c.confidence == null
      ? `  confidence   [·····.....]   n/a    (no skill_outcomes activity in 48h)`
      : `  confidence   [${bar(c.confidence)}]  ${c.confidence.toFixed(2)}   (weighted skill success rate)`,
    "",
    "inputs:",
    `  experiences:  24h=${preview.inputs.experiences_24h_total} (✓${preview.inputs.successes_24h} ✗${preview.inputs.failures_24h})  72h=${preview.inputs.experiences_72h_total}  48h unreflected=${preview.inputs.experiences_48h_unreflected}`,
    `  events:       15min=${preview.inputs.events_last_15min}  recalled24h=${preview.inputs.recalled_24h} (hits=0: ${preview.inputs.recalled_24h_hits_0}, low-conf: ${preview.inputs.recalled_24h_low_conf})`,
    `                agent_error24h=${preview.inputs.agent_error_24h}  agent_completed24h=${preview.inputs.agent_completed_24h}  contradiction48h=${preview.inputs.contradiction_detected_48h}`,
    `                mark_useful 0-6h=${preview.inputs.mark_useful_6h}  6-12h=${preview.inputs.mark_useful_6_to_12h}`,
    `  tool_div 60m: ${preview.inputs.tool_diversity_60min}   novel stimuli 6h: ${preview.inputs.novel_stimuli_6h}   skill rows 48h: ${preview.inputs.skill_rows_48h}`,
    "",
    ...preview.notes.map(n => `• ${n}`),
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
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
