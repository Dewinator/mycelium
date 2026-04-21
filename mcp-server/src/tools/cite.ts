import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { RelationsService } from "../services/relations.js";

// ===========================================================================
// mark_used_in_response
// ===========================================================================
//
// Emit one `used_in_response` event per memory_id, all sharing a single
// trace_id. The CoactivationAgent (agents/coactivation-agent.ts) listens
// for these and pairwise bumps memory_links weights + coactivation_count
// after a 30s debounce — so "these memories appeared in the same response"
// becomes a Hebbian signal without the client having to know about it.
//
// This is the WEAKER sibling of mark_useful:
//   mark_useful         → strength-boost + useful_count++ (strong signal)
//   mark_used_in_response → coactivation-only (cheap signal)
// Call both when a memory was DIRECTLY cited; call only this one when a
// memory was part of the retrieval set that informed the response.

export const markUsedInResponseSchema = z.object({
  memory_ids: z.array(z.string().uuid()).min(1).max(50)
    .describe("Memory UUIDs that appeared together in one response"),
  trace_id: z.string().uuid().optional()
    .describe("Shared trace identifier — pass the SAME id for all memories you want coactivated together. If omitted a fresh UUID is generated (which still emits events but won't pair with other calls)."),
  note: z.string().optional()
    .describe("Optional free-text context, stored in the event's context JSONB"),
});

export async function markUsedInResponse(
  service: RelationsService,
  input: z.infer<typeof markUsedInResponseSchema>,
) {
  const trace = input.trace_id ?? randomUUID();

  // Use the shared postgrest client on RelationsService (same pattern as patterns.ts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (service as any).db;

  const errors: string[] = [];
  for (const id of input.memory_ids) {
    const { error } = await db.rpc("log_memory_event", {
      p_memory_id:  id,
      p_event_type: "used_in_response",
      p_source:     "mcp:mark_used_in_response",
      p_context:    input.note ? { note: input.note } : {},
      p_trace_id:   trace,
      p_created_by: null,
    });
    if (error) errors.push(`${id.slice(0, 8)}: ${error.message ?? JSON.stringify(error)}`);
  }

  if (errors.length === input.memory_ids.length) {
    return {
      content: [{ type: "text" as const, text: `All emits failed:\n${errors.join("\n")}` }],
      isError: true,
    };
  }

  const ok = input.memory_ids.length - errors.length;
  const pairs = (ok * (ok - 1)) / 2;
  return {
    content: [{
      type: "text" as const,
      text: `Emitted ${ok} used_in_response event(s), trace=${trace.slice(0, 8)}. CoactivationAgent will pairwise link ${pairs} pair(s) after 30s debounce.${errors.length ? `\n\nErrors:\n${errors.join("\n")}` : ""}`,
    }],
  };
}
