import { z } from "zod";
import type { NeurochemistryService } from "../services/neurochemistry.js";

const DEFAULT_LABEL = process.env.MYCELIUM_GENOME_LABEL ?? "main";

export const neurochemUpdateSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL).describe("Genome label (default = this agent's genome)"),
  event: z.enum(["task_complete", "task_failed", "novel_stimulus", "familiar_task", "idle", "error", "teacher_consulted"]),
  outcome: z.number().min(0).max(1).optional().describe("Actual outcome in [0..1]; omit for arousal-only events"),
  intensity: z.number().min(0).max(2).optional().default(1.0),
});

export async function neurochemUpdate(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemUpdateSchema>
) {
  const s = await svc.apply(input.label, input.event, input.outcome ?? null, input.intensity);
  const lines = [
    `Neurochemistry updated for '${s.label}' (event=${input.event}, outcome=${input.outcome ?? "—"})`,
    `  DA=${s.dopamine.current.toFixed(3)} (pred ${s.dopamine.prediction.toFixed(3)}, δ ${(s.dopamine.current - s.dopamine.baseline).toFixed(3)})`,
    `  5-HT=${s.serotonin.current.toFixed(3)}`,
    `  NE=${s.noradrenaline.current.toFixed(3)} (optimal ${s.noradrenaline.optimal.toFixed(2)})`,
    `  consecutive_failures=${s.consecutive_failures}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemGetSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
});

export async function neurochemGet(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemGetSchema>
) {
  const s = await svc.get(input.label);
  if (!s.exists) return { content: [{ type: "text" as const, text: `no neurochemistry row for ${input.label}` }] };
  const lines = [
    `Neurochemistry of '${s.label}' (last event: ${s.last_event ?? "—"})`,
    `  Dopamin   current=${s.dopamine.current.toFixed(3)} baseline=${s.dopamine.baseline.toFixed(3)} prediction=${s.dopamine.prediction.toFixed(3)} lr=${s.dopamine.lr}`,
    `  Serotonin current=${s.serotonin.current.toFixed(3)} decay_rate=${s.serotonin.decay_rate}`,
    `  Noradren. current=${s.noradrenaline.current.toFixed(3)} optimal=${s.noradrenaline.optimal.toFixed(3)}`,
    `  consecutive_failures=${s.consecutive_failures}, history entries=${s.history_n}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemGetCompatSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
});

export async function neurochemGetCompat(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemGetCompatSchema>
) {
  const c = await svc.getCompat(input.label);
  if (!c.exists) return { content: [{ type: "text" as const, text: `no neurochemistry row for ${input.label}` }] };
  const lines = [
    `Compat variables for '${c.label}':`,
    `  curiosity    ${c.curiosity.toFixed(3)}`,
    `  frustration  ${c.frustration.toFixed(3)}`,
    `  satisfaction ${c.satisfaction.toFixed(3)}`,
    `  confidence   ${c.confidence.toFixed(3)}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemRecallParamsSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
});

export async function neurochemRecallParams(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemRecallParamsSchema>
) {
  const p = await svc.getRecallParams(input.label);
  if (!p.exists) return { content: [{ type: "text" as const, text: `no neurochemistry row for ${input.label}` }] };
  const lines = [
    `Recall params for '${p.label}' (Yerkes-Dodson performance=${p.performance.toFixed(3)}):`,
    `  k               ${p.k}`,
    `  score_threshold ${p.score_threshold.toFixed(3)}`,
    `  include_adjacent ${p.include_adjacent}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemHorizonSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
});

export async function neurochemHorizon(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemHorizonSchema>
) {
  const h = await svc.getHorizon(input.label);
  if (!h.exists) return { content: [{ type: "text" as const, text: `no neurochemistry row for ${input.label}` }] };
  const lines = [
    `Planning horizon for '${h.label}':`,
    `  days                ${h.days.toFixed(2)}`,
    `  patience_threshold  ${h.patience_threshold.toFixed(3)}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemHistorySchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
  limit: z.number().int().min(1).max(30).optional().default(10),
});

export async function neurochemHistory(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemHistorySchema>
) {
  const rows = await svc.history(input.label, input.limit);
  if (rows.length === 0) return { content: [{ type: "text" as const, text: "no history yet" }] };
  const lines = rows.map((r) =>
    `${String(r.t).slice(0, 19)}  ${String(r.e).padEnd(18)} o=${r.o ?? "—"} δ=${r.d} DA=${r.da} 5HT=${r.se} NE=${r.na}`
  );
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const neurochemResetSchema = z.object({
  label: z.string().optional().default(DEFAULT_LABEL),
});

export async function neurochemReset(
  svc: NeurochemistryService,
  input: z.infer<typeof neurochemResetSchema>
) {
  const s = await svc.reset(input.label);
  return { content: [{ type: "text" as const, text: `Reset '${s.label}' — all systems back to defaults.` }] };
}
