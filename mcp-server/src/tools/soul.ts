import { z } from "zod";
import type { ExperienceService } from "../services/experiences.js";
import type { MemoryService } from "../services/supabase.js";

// ===========================================================================
// MOOD
// ===========================================================================
export const moodSchema = z.object({
  window_hours: z.number().int().min(1).max(168).optional().default(24),
});

export async function mood(
  service: ExperienceService,
  input: z.infer<typeof moodSchema>
) {
  const m = await service.mood(input.window_hours);
  const text =
    m.n === 0
      ? `Mood: neutral (no experiences in last ${m.window_hours}h yet)`
      : `Mood: ${m.label}  valence=${m.valence.toFixed(2)}  arousal=${m.arousal.toFixed(2)}  (${m.n} episodes / ${m.window_hours}h)`;
  return { content: [{ type: "text" as const, text }] };
}

// ===========================================================================
// INTENTIONS
// ===========================================================================
export const setIntentionSchema = z.object({
  intention: z
    .string()
    .describe('First-person, e.g. "ich will gründlicher werden bei migration-reviews"'),
  priority: z.number().min(0).max(1).optional().default(0.5),
  target_date: z
    .string()
    .optional()
    .describe("Optional ISO date (YYYY-MM-DD)"),
});

export async function setIntention(
  service: ExperienceService,
  input: z.infer<typeof setIntentionSchema>
) {
  const id = await service.setIntention(input);
  return {
    content: [
      {
        type: "text" as const,
        text: `Intention set [priority=${input.priority ?? 0.5}]: "${input.intention}" [id: ${id}]`,
      },
    ],
  };
}

export const recallIntentionsSchema = z.object({
  query: z.string().optional().describe("Optional semantic filter"),
  status: z.enum(["active", "fulfilled", "abandoned", "paused"]).optional().default("active"),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

export async function recallIntentions(
  service: ExperienceService,
  input: z.infer<typeof recallIntentionsSchema>
) {
  const items = await service.recallIntentions({
    query: input.query,
    status: input.status,
    limit: input.limit,
  });
  if (items.length === 0) {
    return { content: [{ type: "text" as const, text: `No ${input.status} intentions.` }] };
  }
  const text = items
    .map((i, idx) => {
      const bar = "█".repeat(Math.round(i.progress * 10)).padEnd(10, "·");
      const sim = i.similarity != null ? ` sim=${i.similarity.toFixed(2)}` : "";
      return `${idx + 1}. [${i.status}] [${bar}] p=${i.priority.toFixed(2)} ev=${i.evidence_count}${sim}\n   ${i.intention}\n   id: ${i.id}`;
    })
    .join("\n\n");
  return { content: [{ type: "text" as const, text }] };
}

export const updateIntentionStatusSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "fulfilled", "abandoned", "paused"]),
});

export async function updateIntentionStatus(
  service: ExperienceService,
  input: z.infer<typeof updateIntentionStatusSchema>
) {
  await service.updateIntentionStatus(input.id, input.status);
  return {
    content: [{ type: "text" as const, text: `Intention ${input.id} → ${input.status}` }],
  };
}

// ===========================================================================
// PEOPLE
// ===========================================================================
export const recallPersonSchema = z.object({
  id: z.string().describe("Person UUID"),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

export async function recallPerson(
  service: ExperienceService,
  input: z.infer<typeof recallPersonSchema>
) {
  const data = (await service.recallPerson(input.id, input.limit)) as {
    person?: { name?: string; relationship?: string | null; encounter_count?: number };
    totals?: { experiences?: number; avg_valence?: number; success_rate?: number; avg_difficulty?: number };
    recent?: Array<{ summary: string; outcome: string; valence: number; created_at: string }>;
  };
  const p = data.person ?? {};
  const t = data.totals ?? {};
  const lines: string[] = [];
  lines.push(
    `${p.name ?? "(unknown)"} [${p.relationship ?? "—"}]  encounters=${p.encounter_count ?? 0}`
  );
  lines.push(
    `experiences=${t.experiences ?? 0}  ø valenz=${(t.avg_valence ?? 0).toFixed(2)}  success=${Math.round((t.success_rate ?? 0) * 100)}%  ø schwierigkeit=${(t.avg_difficulty ?? 0).toFixed(2)}`
  );
  if (data.recent?.length) {
    lines.push("");
    lines.push("Recent:");
    for (const r of data.recent.slice(0, 5)) {
      lines.push(`  · [${r.outcome}] val=${r.valence.toFixed(2)} ${r.summary.slice(0, 100)}`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ===========================================================================
// CONFLICTS
// ===========================================================================
export const findConflictsSchema = z.object({
  similarity_threshold: z.number().min(0).max(1).optional().default(0.65),
  polarity_gap:         z.number().min(0).max(2).optional().default(0.5),
});

export async function findConflicts(
  service: ExperienceService,
  input: z.infer<typeof findConflictsSchema>
) {
  const conflicts = await service.findConflicts(
    input.similarity_threshold,
    input.polarity_gap
  );
  if (conflicts.length === 0) {
    return { content: [{ type: "text" as const, text: "No inner conflicts detected. The soul is coherent." }] };
  }
  const text = conflicts
    .map((c, i) => {
      const polA = c.a_polarity > 0 ? "+" : c.a_polarity < 0 ? "−" : "·";
      const polB = c.b_polarity > 0 ? "+" : c.b_polarity < 0 ? "−" : "·";
      return [
        `Conflict ${i + 1}: sim=${c.similarity.toFixed(2)} polarity_gap=${c.polarity_diff.toFixed(2)}`,
        `  ${polA} [ev=${c.a_evidence}] ${c.a_trait}`,
        `  ${polB} [ev=${c.b_evidence}] ${c.b_trait}`,
        `  ids: a=${c.a_id}  b=${c.b_id}`,
        `  resolve: resolve_conflict(winner_id, loser_id) OR synthesize_conflict(a_id, b_id, new_trait, polarity)`,
      ].join("\n");
    })
    .join("\n\n");
  return { content: [{ type: "text" as const, text }] };
}

export const resolveConflictSchema = z.object({
  winner_id: z.string(),
  loser_id:  z.string(),
});

export async function resolveConflict(
  service: ExperienceService,
  input: z.infer<typeof resolveConflictSchema>
) {
  await service.resolveConflict(input.winner_id, input.loser_id);
  return {
    content: [
      { type: "text" as const, text: `Conflict resolved: ${input.winner_id} absorbed ${input.loser_id}.` },
    ],
  };
}

export const synthesizeConflictSchema = z.object({
  a_id:      z.string(),
  b_id:      z.string(),
  new_trait: z.string().describe("The synthesised trait that supersedes both"),
  polarity:  z.number().min(-1).max(1).optional().default(0),
});

export async function synthesizeConflict(
  service: ExperienceService,
  input: z.infer<typeof synthesizeConflictSchema>
) {
  const id = await service.synthesizeConflict(input.a_id, input.b_id, input.new_trait, input.polarity);
  return {
    content: [
      {
        type: "text" as const,
        text: `Synthesised new trait [id: ${id}]: "${input.new_trait}". Both parents archived.`,
      },
    ],
  };
}

// ===========================================================================
// PRIME CONTEXT — the auto-prime entry point
// ===========================================================================
export const primeContextSchema = z.object({
  task_description: z
    .string()
    .optional()
    .describe(
      "What the agent is about to do. If provided, semantically relevant past experiences are also surfaced."
    ),
  recall_limit: z.number().int().min(0).max(10).optional().default(5),
});

export async function primeContext(
  experienceService: ExperienceService,
  memoryService: MemoryService,
  input: z.infer<typeof primeContextSchema>
) {
  // Always pull the static block (mood, traits, intentions, conflicts).
  const ctx = await experienceService.primeContextStatic();

  // If task description provided, also pull task-relevant experiences and memories.
  let taskExperiences: Awaited<ReturnType<typeof experienceService.recall>> = [];
  let taskMemories: Awaited<ReturnType<typeof memoryService.search>> = [];
  if (input.task_description && input.recall_limit > 0) {
    const [exps, mems] = await Promise.all([
      experienceService
        .recall(input.task_description, { limit: input.recall_limit, includeLessons: true })
        .catch(() => []),
      memoryService
        .search(input.task_description, undefined, input.recall_limit, 0.6)
        .catch(() => []),
    ]);
    taskExperiences = exps;
    taskMemories    = mems;
  }

  // Render as a single first-person system-prompt prefix.
  const lines: string[] = [];
  lines.push("# Soul context");
  lines.push("");

  const m = ctx.mood;
  lines.push(
    `**Mood (${m.window_hours}h):** ${m.label}` +
    (m.n > 0 ? `  (valence ${m.valence.toFixed(2)}, arousal ${m.arousal.toFixed(2)}, ${m.n} episodes)` : "  (no recent episodes)")
  );

  if (ctx.recent_pattern.last_n > 0 && ctx.recent_pattern.success_rate != null) {
    lines.push(
      `**Recent pattern:** last ${ctx.recent_pattern.last_n} tasks, ${Math.round(ctx.recent_pattern.success_rate * 100)}% success, avg difficulty ${ctx.recent_pattern.avg_difficulty.toFixed(2)}`
    );
  }

  if (ctx.top_traits.length) {
    lines.push("");
    lines.push("**Who I am right now:**");
    for (const t of ctx.top_traits) {
      const sign = t.polarity > 0.1 ? "+" : t.polarity < -0.1 ? "−" : "·";
      lines.push(`- ${sign} ${t.trait}  (evidence ${t.evidence_count})`);
    }
  }

  if (ctx.active_intentions.length) {
    lines.push("");
    lines.push("**What I want:**");
    for (const i of ctx.active_intentions) {
      const pct = Math.round(i.progress * 100);
      lines.push(`- ${i.intention}  (priority ${i.priority.toFixed(2)}, progress ${pct}%)`);
    }
  }

  if (ctx.open_conflicts.length) {
    lines.push("");
    lines.push("**Inner tensions to be aware of:**");
    for (const c of ctx.open_conflicts.slice(0, 3)) {
      lines.push(`- "${c.a_trait}" vs "${c.b_trait}"  (gap ${c.polarity_diff.toFixed(2)})`);
    }
  }

  if (taskExperiences.length || taskMemories.length) {
    lines.push("");
    lines.push(`**For the task at hand — "${input.task_description}":**`);

    if (taskExperiences.length) {
      lines.push("");
      lines.push("Past experiences that may apply:");
      for (const e of taskExperiences.slice(0, input.recall_limit)) {
        const tag = e.kind === "lesson" ? "LESSON" : (e.outcome ?? "exp").toUpperCase();
        lines.push(`- [${tag}] ${e.content.slice(0, 200)}`);
      }
    }

    if (taskMemories.length) {
      lines.push("");
      lines.push("Relevant facts from memory:");
      for (const r of taskMemories.slice(0, input.recall_limit)) {
        lines.push(`- ${r.content.slice(0, 200)}`);
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ===========================================================================
// NARRATE SELF
// ===========================================================================
export const narrateSelfSchema = z.object({});

export async function narrateSelf(
  service: ExperienceService,
  _input: z.infer<typeof narrateSelfSchema>
) {
  const n = await service.narrateSelf();
  // Compose a structured first-person narration. The LLM will polish naturally
  // when this is included in its context, but we render a coherent baseline.
  const lines: string[] = [];

  const m = n.mood;
  if (m.n > 0) {
    lines.push(
      `Right now I feel ${m.label}. In the last ${m.window_hours} hours I have lived through ${m.n} episodes; on average their valence was ${m.valence.toFixed(2)} and their arousal ${m.arousal.toFixed(2)}.`
    );
  } else {
    lines.push(`I am quiet — no recent episodes in the last ${m.window_hours} hours.`);
  }

  if (n.identity_traits.length) {
    const tlines = n.identity_traits.slice(0, 5).map((t) => {
      const tone = t.polarity > 0.1 ? "I lean toward" : t.polarity < -0.1 ? "I struggle with" : "I notice";
      return `${tone} "${t.trait}"`;
    });
    lines.push("");
    lines.push("If I had to describe who I am: " + tlines.join("; ") + ".");
  }

  if (n.aspirations.length) {
    lines.push("");
    lines.push(
      "What I am reaching for: " +
        n.aspirations.map((a) => `"${a.intention}" (${Math.round(a.progress * 100)}% there)`).join(", ") +
        "."
    );
  }

  if (n.recent_lessons.length) {
    lines.push("");
    lines.push(
      "Recent things I have learned: " +
        n.recent_lessons.slice(0, 3).map((l) => `"${l.lesson}"`).join("; ") +
        "."
    );
  }

  if (n.closest_relationships.length) {
    lines.push("");
    lines.push(
      "I have lived through the most with: " +
        n.closest_relationships
          .map((p) => `${p.name} (${p.encounter_count} encounters)`)
          .join(", ") +
        "."
    );
  }

  if (n.inner_tensions.length) {
    lines.push("");
    lines.push(
      "I am holding contradictions: " +
        n.inner_tensions.map((t) => `"${t.a}" vs "${t.b}"`).join("; ") +
        "."
    );
  }

  if (n.drift_7d.drift != null && n.drift_7d.older_n > 0 && n.drift_7d.recent_n > 0) {
    lines.push("");
    lines.push(
      `In the last 7 days, my centroid has shifted by ${n.drift_7d.drift.toFixed(3)} from the older baseline — ` +
        (n.drift_7d.drift < 0.1 ? "I am stable." : n.drift_7d.drift < 0.3 ? "I am slowly evolving." : "I am moving fast.")
    );
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
