import { z } from "zod";
import type { RelationsService } from "../services/relations.js";

// memory_patterns wraps the RPC of the same name. We stash it on
// RelationsService so we don't need a dedicated service class for one RPC.
export const patternsSchema = z.object({
  min_support: z.number().min(0.001).max(0.5).optional().default(0.02)
    .describe("Minimum fraction of memories that must contain both tags (default 0.02 = 2%)"),
  limit:       z.number().int().min(1).max(100).optional().default(25),
  project_id:  z.string().uuid().optional().describe("Restrict to memories in this project"),
});

export async function patterns(
  service: RelationsService,
  input: z.infer<typeof patternsSchema>,
) {
  // Thin RPC call via the shared postgrest client on RelationsService
  // (avoid creating a second client instance for a single RPC).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (service as any).db;
  const { data, error } = await db.rpc("memory_patterns", {
    p_min_support: input.min_support,
    p_limit:       input.limit,
    p_project_id:  input.project_id ?? null,
  });
  if (error) {
    return {
      content: [{ type: "text" as const, text: `memory_patterns failed: ${error.message ?? JSON.stringify(error)}` }],
      isError: true,
    };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  const list = (r.patterns ?? []) as Array<Record<string, unknown>>;
  if (list.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: r.note
          ? String(r.note)
          : `No tag patterns above min_support=${input.min_support} (${r.total_memories} live memories).`,
      }],
    };
  }
  const lines = list.map((p) =>
    `  ${String(p.tag_a)} × ${String(p.tag_b)}  n=${p.n_ab}  support=${Number(p.support).toFixed(3)}  lift=${Number(p.lift).toFixed(2)}`
  ).join("\n");
  return {
    content: [{
      type: "text" as const,
      text: `Tag co-occurrence patterns (${r.total_memories} live memories, sorted by lift):\n${lines}`,
    }],
  };
}
