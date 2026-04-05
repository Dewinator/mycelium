import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const recallSchema = z.object({
  query: z.string().describe("What to search for (semantic + keyword)"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("Filter by category"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Max results to return"),
  vector_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.7)
    .describe("Weight for vector vs full-text search (0.0-1.0)"),
});

export async function recall(
  service: MemoryService,
  input: z.infer<typeof recallSchema>
) {
  const results = await service.search(
    input.query,
    input.category,
    input.limit,
    input.vector_weight
  );

  if (results.length === 0) {
    return {
      content: [
        { type: "text" as const, text: "No matching memories found." },
      ],
    };
  }

  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. [${r.category}] (score: ${r.similarity.toFixed(3)}) ${r.content}\n   id: ${r.id} | tags: ${r.tags.join(", ") || "none"}`
    )
    .join("\n\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${results.length} memories:\n\n${formatted}`,
      },
    ],
  };
}
