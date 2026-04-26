import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService } from "../services/affect.js";
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
  affect: AffectService,
  projects: ProjectService,
  agentLabel: string,
  input: z.infer<typeof rememberSchema>
) {
  const project_id = await projects.resolveScope(input.project, agentLabel);
  const memory = await service.create({ ...input, project_id });
  const preview = memory.content.slice(0, 100) + (memory.content.length > 100 ? "..." : "");

  // Auto-bump curiosity when genuinely new info lands. We can't cheaply detect
  // the duplicate case here (service.create returns the existing memory in that
  // case without signaling it), so we key off the memory's own updated_at vs
  // created_at — an identical fresh row has them nanoseconds apart; a touched
  // duplicate has updated_at advanced past created_at.
  const wasDuplicate =
    memory.created_at &&
    memory.updated_at &&
    new Date(memory.updated_at).getTime() - new Date(memory.created_at).getTime() > 1000;
  if (!wasDuplicate) {
    // Fire-and-forget: affect.apply already swallows errors internally, but
    // a tail-catch keeps a future refactor that throws from becoming an
    // unhandled rejection. See AFFECT_TO_NEUROCHEM_EVENT_MAP for the wire.
    affect.apply("novel_encoding", 0.3).catch((err) => {
      console.error("[remember] affect.apply tail-failed:", err);
    });
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Remembered (${memory.category}, importance=${memory.importance}${memory.pinned ? ", pinned" : ""}${project_id ? ", project-scoped" : ""}): "${preview}" [id: ${memory.id}]`,
      },
    ],
  };
}
