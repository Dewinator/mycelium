/**
 * MCP tools for the Motivation Engine (Ebene 4 der Cognitive Architecture).
 *
 *   motivation_status       — sidecar health + last cycle + counts
 *   list_stimuli            — recent reizstrom, band-/status-gefiltert
 *   list_generated_tasks    — vom Agenten selbst formulierte Tasks
 *   approve_generated_task  — einen proposed Task in die Pipeline heben
 *   dismiss_generated_task  — nein danke
 *   update_generated_task_status — allgemeiner Status-Wechsel
 *   trigger_motivation_cycle— Sidecar-Zyklus manuell ausloesen
 *   drift_scan              — dormant proposed Tasks neu scoren
 */
import { z } from "zod";
import type { MotivationService } from "../services/motivation.js";

export const motivationStatusSchema = z.object({});

export async function motivationStatus(
  m: MotivationService,
  _input: z.infer<typeof motivationStatusSchema>
) {
  const [health, status, stats] = await Promise.all([
    m.sidecarHealth(),
    m.sidecarStatus(),
    m.stats().catch((e) => ({ error: String(e) })),
  ]);
  const lines: string[] = [];
  lines.push(
    `Sidecar: ${health.ok ? "✓ up" : `✗ ${health.detail ?? "down"}`} ` +
      `(http://127.0.0.1:18792)`
  );
  if (status) {
    lines.push(
      `Last cycle: ${status.last_cycle_finished ?? "—"} ` +
        `(ok=${status.cycles_completed} fail=${status.cycles_failed})`
    );
  }
  if (stats && typeof stats === "object" && "stimuli_by_band_7d" in stats) {
    const s = stats as unknown as {
      stimuli_by_band_7d?: Record<string, number>;
      stimuli_by_status_total?: Record<string, number>;
      tasks_by_status?: Record<string, number>;
    };
    lines.push(`Stimuli by band (7d): ${JSON.stringify(s.stimuli_by_band_7d ?? {})}`);
    lines.push(`Stimuli by status:    ${JSON.stringify(s.stimuli_by_status_total ?? {})}`);
    lines.push(`Tasks by status:      ${JSON.stringify(s.tasks_by_status ?? {})}`);
  } else {
    lines.push(`Stats: ${JSON.stringify(stats)}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---- list_stimuli ----------------------------------------------------------
export const listStimuliSchema = z.object({
  status: z
    .enum(["new", "scored", "task_generated", "dismissed", "acted"])
    .optional(),
  band: z.enum(["ignore", "log", "explore", "act", "urgent"]).optional(),
  since_hours: z.number().int().min(1).max(24 * 30).optional().default(168),
  limit: z.number().int().min(1).max(200).optional().default(25),
});

export async function listStimuli(
  m: MotivationService,
  input: z.infer<typeof listStimuliSchema>
) {
  const rows = await m.listStimuli({
    status: input.status,
    band: input.band,
    sinceHours: input.since_hours,
    limit: input.limit,
  });
  if (!rows.length) {
    return { content: [{ type: "text" as const, text: "No stimuli matching filter." }] };
  }
  const lines = rows.map((r) => {
    const rel = r.relevance != null ? r.relevance.toFixed(2) : "—";
    const band = r.band ?? "—";
    return (
      `[${r.band ?? "??"}|${r.status}] rel=${rel} ${r.source_type} · ` +
      `${r.title ?? "(untitled)"}${r.url ? ` → ${r.url}` : ""}`
    );
  });
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---- list_generated_tasks --------------------------------------------------
export const listGeneratedTasksSchema = z.object({
  status: z
    .enum(["proposed", "approved", "dismissed", "in_progress", "done", "abandoned"])
    .optional(),
  limit: z.number().int().min(1).max(200).optional().default(25),
});

export async function listGeneratedTasks(
  m: MotivationService,
  input: z.infer<typeof listGeneratedTasksSchema>
) {
  const rows = await m.listTasks({ status: input.status, limit: input.limit });
  if (!rows.length) {
    return {
      content: [{ type: "text" as const, text: "No generated tasks matching filter." }],
    };
  }
  const lines = rows.map((r) => {
    const rel = r.relevance != null ? r.relevance.toFixed(2) : "—";
    const drift = (r.drift_score ?? 0).toFixed(2);
    return (
      `${r.id.slice(0, 8)} [${r.status}] rel=${rel} drift=${drift} · ${r.task_text}` +
      (r.rationale ? `\n    ↳ ${r.rationale}` : "")
    );
  });
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---- approve_generated_task ------------------------------------------------
export const approveGeneratedTaskSchema = z.object({
  task_id: z.string().uuid(),
  approved_by: z.string().optional(),
});

export async function approveGeneratedTask(
  m: MotivationService,
  input: z.infer<typeof approveGeneratedTaskSchema>
) {
  const row = await m.updateTaskStatus(input.task_id, "approved", input.approved_by ?? "user");
  return {
    content: [
      {
        type: "text" as const,
        text: `Approved: ${row.id.slice(0, 8)} · ${row.task_text}`,
      },
    ],
  };
}

// ---- dismiss_generated_task ------------------------------------------------
export const dismissGeneratedTaskSchema = z.object({
  task_id: z.string().uuid(),
});

export async function dismissGeneratedTask(
  m: MotivationService,
  input: z.infer<typeof dismissGeneratedTaskSchema>
) {
  const row = await m.updateTaskStatus(input.task_id, "dismissed");
  return {
    content: [
      { type: "text" as const, text: `Dismissed: ${row.id.slice(0, 8)} · ${row.task_text}` },
    ],
  };
}

// ---- update_generated_task_status -----------------------------------------
export const updateGeneratedTaskStatusSchema = z.object({
  task_id: z.string().uuid(),
  status: z.enum([
    "proposed",
    "approved",
    "dismissed",
    "in_progress",
    "done",
    "abandoned",
  ]),
  approved_by: z.string().optional(),
});

export async function updateGeneratedTaskStatus(
  m: MotivationService,
  input: z.infer<typeof updateGeneratedTaskStatusSchema>
) {
  const row = await m.updateTaskStatus(input.task_id, input.status, input.approved_by ?? null);
  return {
    content: [
      {
        type: "text" as const,
        text: `${row.id.slice(0, 8)} → ${row.status} · ${row.task_text}`,
      },
    ],
  };
}

// ---- trigger_motivation_cycle ---------------------------------------------
export const triggerMotivationCycleSchema = z.object({
  force: z.boolean().optional().default(false),
});

export async function triggerMotivationCycle(
  m: MotivationService,
  input: z.infer<typeof triggerMotivationCycleSchema>
) {
  const out = await m.triggerCycle(input.force);
  if (!out) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "Sidecar unreachable — cycle not triggered. Run " +
            "`launchctl kickstart -k gui/$(id -u)/ai.openclaw.motivation` first.",
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Cycle triggered:\n${JSON.stringify(out.result ?? out, null, 2)}`,
      },
    ],
  };
}

// ---- drift_scan -----------------------------------------------------------
export const driftScanSchema = z.object({});

export async function driftScan(
  m: MotivationService,
  _input: z.infer<typeof driftScanSchema>
) {
  const out = await m.driftScan();
  return {
    content: [
      { type: "text" as const, text: `Drift scan: ${JSON.stringify(out)}` },
    ],
  };
}
