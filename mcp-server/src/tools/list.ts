import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const listSchema = z.object({
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("Filter by category (omit for all)"),
  limit: z
    .number()
    .optional()
    .default(20)
    .describe("Max results to return"),
});

export async function list(
  service: MemoryService,
  input: z.infer<typeof listSchema>
) {
  const memories = await service.list(input.category, input.limit);

  if (memories.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: input.category
            ? `No memories in category "${input.category}".`
            : "No memories stored yet.",
        },
      ],
    };
  }

  const formatted = memories
    .map(
      (m, i) =>
        `${i + 1}. [${m.category}] ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}\n   id: ${m.id} | tags: ${m.tags.join(", ") || "none"} | ${m.created_at}`
    )
    .join("\n\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `${memories.length} memories${input.category ? ` in "${input.category}"` : ""}:\n\n${formatted}`,
      },
    ],
  };
}
