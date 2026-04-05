import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const updateSchema = z.object({
  id: z.string().uuid().describe("UUID of the memory to update"),
  content: z.string().optional().describe("New content (re-embeds automatically)"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("New category"),
  tags: z.array(z.string()).optional().describe("New tags"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("New metadata (replaces existing)"),
});

export async function update(
  service: MemoryService,
  input: z.infer<typeof updateSchema>
) {
  const memory = await service.update(input);
  return {
    content: [
      {
        type: "text" as const,
        text: `Updated memory ${memory.id}: "${memory.content.slice(0, 100)}${memory.content.length > 100 ? "..." : ""}" [${memory.category}]`,
      },
    ],
  };
}
