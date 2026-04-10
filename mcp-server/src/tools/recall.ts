import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

export const recallSchema = z.object({
  query: z.string().describe("What to search for (semantic + keyword)"),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("Filter by category"),
  limit: z.number().optional().default(10).describe("Max results to return"),
  vector_weight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.6)
    .describe("Weight for vector vs full-text search (0..1). Used inside relevance only."),
  spread: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include associated memories via spreading activation"),
  with_experiences: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "For each top hit, also surface up to 2 linked past experiences (lived knowledge: 'how did it go last time?')"
    ),
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
    return { content: [{ type: "text" as const, text: "No matching memories found." }] };
  }

  // Rehearsal (testing effect) + Hebbian co-activation of the top results.
  const topIds = results.map((r) => r.id);
  await Promise.all([
    service.touch(topIds),
    service.coactivate(topIds.slice(0, Math.min(5, topIds.length))),
  ]);

  // Spreading activation: surface neighbors that weren't in the direct hits.
  const neighbors = input.spread ? await service.spread(topIds.slice(0, 5), 5) : [];

  // Cross-layer lived-knowledge overlay: pull linked experiences for the
  // top results in parallel. Non-fatal if migration 016 isn't applied.
  const topForOverlay = results.slice(0, Math.min(5, results.length));
  const experiencesByMemory = new Map<string, Array<{
    id: string; summary: string; outcome: string;
    difficulty: number; valence: number; weight: number; created_at: string;
  }>>();
  if (input.with_experiences) {
    const overlays = await Promise.all(
      topForOverlay.map((r) => service.experiencesForMemory(r.id, 2))
    );
    topForOverlay.forEach((r, i) => {
      if (overlays[i].length > 0) experiencesByMemory.set(r.id, overlays[i]);
    });
  }

  const formatted = results
    .map((r, i) => {
      const stageMark = r.pinned ? "*" : r.stage === "semantic" ? "S" : "e";
      const head = `${i + 1}. [${r.category}/${stageMark}] score=${r.effective_score.toFixed(3)} (rel=${r.relevance.toFixed(2)} str=${r.strength_now.toFixed(2)} sal=${r.salience.toFixed(2)} ax=${r.access_count})\n   ${r.content}\n   id: ${r.id}${r.tags.length ? " | tags: " + r.tags.join(", ") : ""}`;
      const exps = experiencesByMemory.get(r.id);
      if (!exps || exps.length === 0) return head;
      const lived = exps
        .map(
          (e) =>
            `     ↳ [${e.outcome}] val=${e.valence.toFixed(2)} diff=${e.difficulty.toFixed(2)}: ${e.summary.slice(0, 140)}`
        )
        .join("\n");
      return `${head}\n   lived experience:\n${lived}`;
    })
    .join("\n\n");

  let text = `Found ${results.length} memories:\n\n${formatted}`;

  if (neighbors.length > 0) {
    const assoc = neighbors
      .map(
        (n, i) =>
          `${i + 1}. [${n.category}] link=${n.link_strength.toFixed(2)} ${n.content.slice(0, 120)}\n   id: ${n.id}`
      )
      .join("\n\n");
    text += `\n\nAssociated (spreading activation):\n\n${assoc}`;
  }

  return { content: [{ type: "text" as const, text }] };
}
