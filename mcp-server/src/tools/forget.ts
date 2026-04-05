import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const forgetSchema = z.object({
  id: z.string().uuid().describe("UUID of the memory to delete"),
});

export async function forget(
  service: MemoryService,
  input: z.infer<typeof forgetSchema>
) {
  const existing = await service.get(input.id);
  if (!existing) {
    return {
      content: [
        { type: "text" as const, text: `Memory ${input.id} not found.` },
      ],
    };
  }

  await service.delete(input.id);
  return {
    content: [
      {
        type: "text" as const,
        text: `Deleted memory: "${existing.content.slice(0, 100)}${existing.content.length > 100 ? "..." : ""}" [${existing.category}]`,
      },
    ],
  };
}
