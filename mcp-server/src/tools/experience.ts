import { z } from "zod";
import type { ExperienceService } from "../services/experiences.js";

// ---------------------------------------------------------------------------
// record_experience
// ---------------------------------------------------------------------------
export const recordExperienceSchema = z.object({
  summary: z
    .string()
    .describe(
      "Short narrative of the episode — what happened, in your own voice. This is what gets embedded."
    ),
  task_type: z
    .string()
    .optional()
    .describe("e.g. refactor, debug, explain, implement, research, chat"),
  outcome: z
    .enum(["success", "partial", "failure", "unknown"])
    .optional()
    .default("unknown"),
  difficulty: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("How hard this felt for you, 0..1"),
  confidence_before: z.number().min(0).max(1).optional(),
  confidence_after: z.number().min(0).max(1).optional(),
  user_sentiment: z
    .enum(["frustrated", "neutral", "pleased", "delighted", "angry"])
    .optional()
    .describe("How the user seemed to feel"),
  valence: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe("Emotional tone of the episode for you, -1..1"),
  arousal: z.number().min(0).max(1).optional(),
  what_worked: z.string().optional(),
  what_failed: z.string().optional(),
  tools_used: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  details: z.string().optional().describe("Optional longer body"),
  session_id: z.string().optional(),
  person_name: z
    .string()
    .optional()
    .describe("Person involved in this episode (auto-resolved or created)"),
  person_description: z.string().optional(),
  person_relationship: z
    .string()
    .optional()
    .describe('e.g. "user", "collaborator", "self"'),
});

export async function recordExperience(
  service: ExperienceService,
  input: z.infer<typeof recordExperienceSchema>
) {
  const { id, cross_links, intentions_touched, person_id } = await service.record(input);
  const notes: string[] = [];
  if (cross_links > 0)        notes.push(`↔ ${cross_links} memory link(s)`);
  if (intentions_touched > 0) notes.push(`→ advanced ${intentions_touched} intention(s)`);
  if (person_id)              notes.push(`with person`);
  const noteStr = notes.length ? "  " + notes.join("  ") : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Experience recorded [${input.outcome ?? "unknown"}/${input.task_type ?? "?"}]: "${input.summary.slice(0, 100)}"${noteStr} [id: ${id}]`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// recall_experiences
// ---------------------------------------------------------------------------
export const recallExperiencesSchema = z.object({
  query: z.string().describe("What kind of past situation are you looking for?"),
  limit: z.number().int().min(1).max(50).optional().default(8),
  outcome: z.enum(["success", "partial", "failure", "unknown"]).optional(),
  include_lessons: z.boolean().optional().default(true),
});

export async function recallExperiences(
  service: ExperienceService,
  input: z.infer<typeof recallExperiencesSchema>
) {
  const results = await service.recall(input.query, {
    limit: input.limit,
    outcome: input.outcome,
    includeLessons: input.include_lessons,
  });
  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: "No matching experiences." }] };
  }
  const text = results
    .map((r, i) => {
      const tag = r.kind === "lesson" ? "LESSON" : (r.outcome ?? "exp").toUpperCase();
      const score = `sim=${r.similarity.toFixed(2)}`;
      const evi = r.evidence_count > 1 ? ` ev=${r.evidence_count}` : "";
      return `${i + 1}. [${tag}] ${score} val=${r.valence.toFixed(2)}${evi}\n   ${r.content}\n   id: ${r.id}`;
    })
    .join("\n\n");
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// reflect — find clusters of unreflected episodes (REM-sleep step 1).
// The actual synthesis is done by the LLM client; this tool returns the
// raw clusters so the caller can write a `record_lesson` for each one.
// ---------------------------------------------------------------------------
export const reflectSchema = z.object({
  similarity_threshold: z.number().min(0).max(1).optional().default(0.85),
  min_cluster_size: z.number().int().min(2).optional().default(2),
  max_age_days: z.number().int().min(1).optional().default(30),
});

export async function reflect(
  service: ExperienceService,
  input: z.infer<typeof reflectSchema>
) {
  const clusters = await service.findClusters(
    input.similarity_threshold,
    input.min_cluster_size,
    input.max_age_days
  );
  if (clusters.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "No clusters of unreflected experiences found. Either there's nothing new, or the existing episodes are too dissimilar to group. Lower similarity_threshold or min_cluster_size to broaden the search.",
        },
      ],
    };
  }
  const text =
    `Found ${clusters.length} cluster(s) of unreflected experiences.\n` +
    `For each cluster: if a 'matches existing lesson' is shown, call ` +
    `reinforce_lesson(lesson_id, source_ids). Otherwise synthesise a new ` +
    `lesson and call record_lesson with the source_ids.\n\n` +
    clusters
      .map((c, i) => {
        const lines = [
          `Cluster ${i + 1}: ${c.member_count} episodes`,
          `  outcomes:       ${c.outcomes.join(", ")}`,
          `  avg_difficulty: ${c.avg_difficulty.toFixed(2)}`,
          `  avg_valence:    ${c.avg_valence.toFixed(2)}`,
          `  seed:           ${c.seed_summary}`,
          `  source_ids:     [${c.member_ids.join(", ")}]`,
        ];
        if (c.matched_lesson_id) {
          lines.push(
            `  → matches existing lesson (sim=${(c.matched_similarity ?? 0).toFixed(2)}):`,
            `      id:     ${c.matched_lesson_id}`,
            `      lesson: ${c.matched_lesson_text}`,
            `      action: reinforce_lesson(${c.matched_lesson_id}, [...source_ids])`
          );
        } else {
          lines.push(`  → no matching existing lesson — synthesise a new one with record_lesson`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// mark_experience_useful — strongest learning signal for the experience layer
// ---------------------------------------------------------------------------
export const markExperienceUsefulSchema = z.object({
  id: z.string().describe("Experience UUID that actually informed a decision"),
});

export async function markExperienceUseful(
  service: ExperienceService,
  input: z.infer<typeof markExperienceUsefulSchema>
) {
  await service.markUseful(input.id);
  return {
    content: [
      { type: "text" as const, text: `Marked useful: ${input.id} (useful_count++)` },
    ],
  };
}

// ---------------------------------------------------------------------------
// dedup_lessons — merge near-identical lessons
// ---------------------------------------------------------------------------
export const dedupLessonsSchema = z.object({
  similarity_threshold: z.number().min(0).max(1).optional().default(0.92),
});

export async function dedupLessons(
  service: ExperienceService,
  input: z.infer<typeof dedupLessonsSchema>
) {
  const merged = await service.dedupLessons(input.similarity_threshold);
  return {
    content: [
      { type: "text" as const, text: `Merged ${merged} near-identical lesson(s).` },
    ],
  };
}

// ---------------------------------------------------------------------------
// promotion_candidates — lessons ripe for trait graduation
// ---------------------------------------------------------------------------
export const promotionCandidatesSchema = z.object({
  min_evidence:   z.number().int().min(1).optional().default(4),
  min_confidence: z.number().min(0).max(1).optional().default(0.7),
});

export async function promotionCandidates(
  service: ExperienceService,
  input: z.infer<typeof promotionCandidatesSchema>
) {
  const candidates = await service.promotionCandidates(
    input.min_evidence,
    input.min_confidence
  );
  if (candidates.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No lessons currently meet the promotion threshold (evidence ≥ ${input.min_evidence}, confidence ≥ ${input.min_confidence}).`,
        },
      ],
    };
  }
  const text =
    `${candidates.length} lesson(s) ready for promotion to trait. ` +
    `For each, decide a stable self-description and call promote_lesson_to_trait.\n\n` +
    candidates
      .map(
        (c, i) =>
          `${i + 1}. [ev=${c.evidence_count}, conf=${c.confidence.toFixed(2)}] ${c.lesson}\n   id: ${c.id}`
      )
      .join("\n\n");
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// record_lesson — store a synthesised pattern
// ---------------------------------------------------------------------------
export const recordLessonSchema = z.object({
  lesson: z.string().describe("The distilled pattern, written in first person"),
  source_ids: z
    .array(z.string())
    .min(1)
    .describe("UUIDs of the experiences this lesson summarises"),
  category: z
    .enum(["skill", "preference", "warning", "insight", "general"])
    .optional()
    .default("general"),
  confidence: z.number().min(0).max(1).optional().default(0.6),
});

export async function recordLesson(
  service: ExperienceService,
  input: z.infer<typeof recordLessonSchema>
) {
  const id = await service.recordLesson(input.lesson, input.source_ids, {
    category: input.category,
    confidence: input.confidence,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Lesson recorded (${input.source_ids.length} source episodes marked reflected): "${input.lesson.slice(0, 120)}" [id: ${id}]`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// reinforce_lesson — when new episodes match an existing lesson
// ---------------------------------------------------------------------------
export const reinforceLessonSchema = z.object({
  lesson_id: z.string(),
  source_ids: z.array(z.string()).min(1),
});

export async function reinforceLesson(
  service: ExperienceService,
  input: z.infer<typeof reinforceLessonSchema>
) {
  await service.reinforceLesson(input.lesson_id, input.source_ids);
  return {
    content: [
      {
        type: "text" as const,
        text: `Reinforced lesson ${input.lesson_id} with ${input.source_ids.length} additional episode(s).`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// promote_lesson_to_trait — graduate a well-evidenced lesson into identity
// ---------------------------------------------------------------------------
export const promoteTraitSchema = z.object({
  lesson_id: z.string(),
  trait: z.string().describe('Stable self-description, e.g. "tends toward over-caution on DB migrations"'),
  polarity: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .default(0)
    .describe("-1 = weakness, +1 = strength, 0 = neutral"),
});

export async function promoteTrait(
  service: ExperienceService,
  input: z.infer<typeof promoteTraitSchema>
) {
  const id = await service.promoteToTrait(input.lesson_id, input.trait, input.polarity);
  return {
    content: [
      {
        type: "text" as const,
        text: `Trait recorded [polarity=${input.polarity}]: "${input.trait}" [id: ${id}]`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// soul_state — render the current "soul" snapshot as text
// ---------------------------------------------------------------------------
export const soulStateSchema = z.object({});

export async function soulState(
  service: ExperienceService,
  _input: z.infer<typeof soulStateSchema>
) {
  const stats = (await service.stats()) as {
    totals?: Record<string, number>;
    drift?: { drift: number | null; recent_n: number; older_n: number };
    outcomes?: Record<string, number>;
    sentiment?: Record<string, number>;
    task_types?: Array<{ name: string; count: number; success_rate: number | null; avg_difficulty: number }>;
    top_lessons?: Array<{ lesson: string; evidence_count: number; confidence: number }>;
    traits?: Array<{ trait: string; polarity: number; evidence_count: number }>;
    promotion_candidates?: Array<{ lesson: string; evidence_count: number; confidence: number }>;
  };

  const t = stats.totals ?? {};
  const d = stats.drift;
  const lines: string[] = [];
  lines.push(`SOUL STATE`);
  lines.push(
    `experiences=${t.experiences ?? 0}  lessons=${t.lessons ?? 0}  traits=${t.traits ?? 0}  unreflected=${t.unreflected ?? 0}  cross_links=${t.cross_links ?? 0}`
  );
  lines.push(
    `avg_difficulty=${(t.avg_difficulty ?? 0).toFixed(2)}  avg_valence=${(t.avg_valence ?? 0).toFixed(2)}  success_rate=${((t.success_rate ?? 0) * 100).toFixed(0)}%  useful=${t.useful_total ?? 0}`
  );
  if (d && d.drift !== null && d.older_n > 0 && d.recent_n > 0) {
    lines.push(`drift(7d): ${d.drift.toFixed(3)}  (recent_n=${d.recent_n}, older_n=${d.older_n})`);
  }

  if (stats.outcomes && Object.keys(stats.outcomes).length) {
    lines.push("");
    lines.push("outcomes: " + Object.entries(stats.outcomes).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  if (stats.sentiment && Object.keys(stats.sentiment).length) {
    lines.push("user_sentiment: " + Object.entries(stats.sentiment).map(([k, v]) => `${k}=${v}`).join(" "));
  }

  if (stats.top_lessons?.length) {
    lines.push("");
    lines.push("Top lessons:");
    for (const l of stats.top_lessons.slice(0, 8)) {
      lines.push(`  - [ev=${l.evidence_count}, conf=${l.confidence.toFixed(2)}] ${l.lesson}`);
    }
  }
  if (stats.promotion_candidates?.length) {
    lines.push("");
    lines.push(`Ready for promotion to trait (${stats.promotion_candidates.length}):`);
    for (const c of stats.promotion_candidates.slice(0, 5)) {
      lines.push(`  · [ev=${c.evidence_count}, conf=${c.confidence.toFixed(2)}] ${c.lesson}`);
    }
  }
  if (stats.traits?.length) {
    lines.push("");
    lines.push("Traits:");
    for (const tr of stats.traits.slice(0, 10)) {
      const sign = tr.polarity > 0.1 ? "+" : tr.polarity < -0.1 ? "-" : "·";
      lines.push(`  ${sign} [ev=${tr.evidence_count}] ${tr.trait}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
