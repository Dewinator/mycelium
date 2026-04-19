import { z } from "zod";
import type { SkillsService } from "../services/skills.js";

// ===========================================================================
// recommend_skill
// ===========================================================================
export const recommendSkillSchema = z.object({
  task_type: z
    .string()
    .optional()
    .describe("Task type to recommend for (e.g. 'refactor', 'debug', 'implement', 'research', 'planning'). Omit → overall top skills."),
  min_evidence: z.number().int().min(1).max(100).optional().default(2),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export async function recommendSkill(
  service: SkillsService,
  input: z.infer<typeof recommendSkillSchema>
) {
  const recs = await service.recommend(input.task_type ?? null, input.min_evidence, input.limit);
  if (recs.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: input.task_type
          ? `No skills with ≥${input.min_evidence} evidence for task_type='${input.task_type}' yet. Use the skill a few times via digest so skill_outcomes can accumulate.`
          : `No skill outcomes recorded yet. Call digest with tools_used to start populating.`,
      }],
    };
  }

  const text = recs
    .map((r, i) => {
      const sr = r.success_rate != null ? `${Math.round(r.success_rate * 100)}%` : "—";
      return `${i + 1}. ${r.skill}  success=${sr}  (${r.n_success}/${r.n_total}, ${r.n_failure} fail)  score=${r.score.toFixed(2)}`;
    })
    .join("\n");
  const header = input.task_type ? `Skills for task_type='${input.task_type}':` : "Top skills (all task types):";
  return { content: [{ type: "text" as const, text: `${header}\n\n${text}` }] };
}

// ===========================================================================
// skill_stats
// ===========================================================================
export const skillStatsSchema = z.object({});

export async function skillStats(
  service: SkillsService,
  _input: z.infer<typeof skillStatsSchema>
) {
  const stats = await service.stats();
  if (!stats || stats.skills.length === 0) {
    return { content: [{ type: "text" as const, text: "No skill_outcomes yet." }] };
  }
  const rows = stats.skills
    .slice(0, 15)
    .map((s) => {
      const sr = s.success_rate != null ? `${Math.round(s.success_rate * 100)}%` : "—";
      return `- ${s.skill.padEnd(20)}  n=${String(s.n_total).padStart(3)}  success=${sr.padStart(4)}  diff=${s.avg_difficulty.toFixed(2)}  last=${s.last_at.slice(0, 10)}`;
    })
    .join("\n");
  return {
    content: [{ type: "text" as const, text: `Skill stats (${stats.skills.length} skills):\n${rows}` }],
  };
}
