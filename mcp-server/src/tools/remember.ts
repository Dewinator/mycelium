import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";
import type { ProjectService } from "../services/projects.js";

export const rememberSchema = z.object({
  content: z.string().describe("The information to remember"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .default("general")
    .describe("Category for the memory"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for filtering"),
  source: z.string().optional().describe("Where this information came from"),
  importance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Encoding strength 0..1. Higher = decays slower. Default 0.5."),
  valence: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe("Emotional valence -1..1 (negative..positive). Boosts salience."),
  arousal: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Emotional arousal 0..1. High arousal slows decay (amygdala effect)."),
  pinned: z
    .boolean()
    .optional()
    .describe("Pin this memory — it will never be forgotten and gets a salience bonus."),
  project: z
    .string()
    .nullable()
    .optional()
    .describe("Project slug to scope this memory to. Omit to use the agent's active project (if any). Pass null to force global (no project)."),
});

export async function remember(
  service: MemoryService,
  projects: ProjectService,
  agentLabel: string,
  input: z.infer<typeof rememberSchema>
) {
  const project_id = await projects.resolveScope(input.project, agentLabel);
  const memory = await service.create({ ...input, project_id });
  const preview = memory.content.slice(0, 100) + (memory.content.length > 100 ? "..." : "");

  return {
    content: [
      {
        type: "text" as const,
        text: `Remembered (${memory.category}, importance=${memory.importance}${memory.pinned ? ", pinned" : ""}${project_id ? ", project-scoped" : ""}): "${preview}" [id: ${memory.id}]`,
      },
    ],
  };
}
