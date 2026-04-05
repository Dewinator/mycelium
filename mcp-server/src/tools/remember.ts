import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const rememberSchema = z.object({
  content: z.string().describe("The information to remember"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .default("general")
    .describe("Category for the memory"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Tags for filtering"),
  source: z
    .string()
    .optional()
    .describe("Where this information came from"),
});

export async function remember(
  service: MemoryService,
  input: z.infer<typeof rememberSchema>
) {
  const memory = await service.create(input);
  return {
    content: [
      {
        type: "text" as const,
        text: `Remembered (${memory.category}): "${memory.content.slice(0, 100)}${memory.content.length > 100 ? "..." : ""}" [id: ${memory.id}]`,
      },
    ],
  };
}
