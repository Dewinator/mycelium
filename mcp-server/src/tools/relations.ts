import { z } from "zod";
import type { RelationsService, RelationType } from "../services/relations.js";
import { RELATION_TYPES } from "../services/relations.js";

// ===========================================================================
// chain — explicit typed edge between two memories
// ===========================================================================
export const chainSchema = z.object({
  a_id:   z.string().uuid().describe("The source memory (where the edge starts)"),
  b_id:   z.string().uuid().describe("The target memory (where the edge points to)"),
  type:   z.enum(RELATION_TYPES as [RelationType, ...RelationType[]])
            .describe("Kind of relation. 'supersedes' / 'contradicts' / 'caused_by' / 'led_to' etc. — one of 13 labels."),
  reason: z.string().optional().default("").describe("Short rationale — why this edge holds"),
  weight: z.number().min(0).max(1).optional().default(0.5).describe("Confidence in [0,1]"),
});

export async function chain(
  service: RelationsService,
  input: z.infer<typeof chainSchema>,
) {
  const r = await service.chain(input.a_id, input.b_id, input.type, input.reason, input.weight);
  if (r.ok === false) {
    return { content: [{ type: "text" as const, text: `Error: ${String(r.error)}` }], isError: true };
  }
  return {
    content: [{
      type: "text" as const,
      text: `chained ${input.type} (${r.a_id} → ${r.b_id})  weight=${Number(r.weight).toFixed(2)}  evidence=${r.evidence_count}`,
    }],
  };
}

// ===========================================================================
// why — causes + consequences for one memory
// ===========================================================================
export const whySchema = z.object({
  memory_id: z.string().uuid().describe("The memory to explain"),
});

export async function why(
  service: RelationsService,
  input: z.infer<typeof whySchema>,
) {
  const r = await service.why(input.memory_id);
  if (r.exists === false) {
    return { content: [{ type: "text" as const, text: `Memory not found: ${input.memory_id}` }], isError: true };
  }
  const m = r.memory as Record<string, unknown>;
  const causes = r.causes as Array<Record<string, unknown>>;
  const consequences = r.consequences as Array<Record<string, unknown>>;

  const head = `[${String(m.category)}] stage=${String(m.stage)} strength=${Number(m.strength ?? 0).toFixed(2)}\n${String(m.content)}`;

  const fmtEdge = (e: Record<string, unknown>): string =>
    `  - ${String(e.type)} (w=${Number(e.weight ?? 0).toFixed(2)}, ev=${e.evidence_count}): ${String(e.other_content ?? "").slice(0, 140)}${e.reason ? `  // ${String(e.reason).slice(0, 120)}` : ""}`;

  const causesBlock = causes.length
    ? causes.map(fmtEdge).join("\n")
    : "  (none)";
  const consBlock = consequences.length
    ? consequences.map(fmtEdge).join("\n")
    : "  (none)";

  return {
    content: [{
      type: "text" as const,
      text: `${head}\n\nCauses (what feeds into this memory):\n${causesBlock}\n\nConsequences (what this memory feeds into):\n${consBlock}`,
    }],
  };
}

// ===========================================================================
// memory_history — event log + current metadata for one memory
// ===========================================================================
export const historySchema = z.object({
  memory_id: z.string().uuid().describe("The memory whose history to retrieve"),
  limit:     z.number().int().min(1).max(200).optional().default(50)
              .describe("Max events to return (default 50)"),
});

export async function history(
  service: RelationsService,
  input: z.infer<typeof historySchema>,
) {
  const r = await service.history(input.memory_id, input.limit);
  if (r.exists === false) {
    return { content: [{ type: "text" as const, text: `Memory not found: ${input.memory_id}` }], isError: true };
  }
  const m = r.memory as Record<string, unknown>;
  const counts = r.event_counts as Record<string, number>;
  const events = r.recent_events as Array<Record<string, unknown>>;

  const countsLine = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  const evLines = events.map((e) => {
    const ts = String(e.created_at ?? "").replace("T", " ").slice(0, 19);
    return `  ${ts}  ${String(e.event_type)}  (${String(e.source)})`;
  }).join("\n");

  return {
    content: [{
      type: "text" as const,
      text: `[${String(m.category)}] access=${m.access_count} useful=${m.useful_count} pinned=${m.pinned}\n${String(m.content).slice(0, 300)}\n\nEvent counts: ${countsLine || "(none)"}\n\nRecent events:\n${evLines || "  (none)"}`,
    }],
  };
}

// ===========================================================================
// memory_neighbors — BFS graph walk from a memory
// ===========================================================================
export const neighborsSchema = z.object({
  memory_id: z.string().uuid(),
  depth:     z.number().int().min(1).max(5).optional().default(2),
  types:     z.array(z.enum(RELATION_TYPES as [RelationType, ...RelationType[]])).optional()
              .describe("Optional filter: only walk these relation types"),
});

export async function neighbors(
  service: RelationsService,
  input: z.infer<typeof neighborsSchema>,
) {
  const r = await service.neighbors(input.memory_id, input.depth, input.types ?? null);
  if (r.ok === false) {
    return { content: [{ type: "text" as const, text: `Error: ${String(r.error)}` }], isError: true };
  }
  const nodes = r.nodes as Array<Record<string, unknown>>;
  if (nodes.length === 0) {
    return { content: [{ type: "text" as const, text: "No reachable neighbors (isolated node)." }] };
  }
  const lines = nodes.map((n) =>
    `  hop=${n.min_hop}  [${String(n.category)}/${String(n.stage)}]  ${String(n.preview).slice(0, 140)}`
  ).join("\n");
  return {
    content: [{
      type: "text" as const,
      text: `Reachable within depth=${input.depth}:\n${lines}`,
    }],
  };
}

// ===========================================================================
// supersede_memory — "b replaces a" with bitemporal bookkeeping
// ===========================================================================
export const supersedeSchema = z.object({
  old_id: z.string().uuid().describe("The memory being superseded"),
  new_id: z.string().uuid().describe("The memory that supersedes it"),
  reason: z.string().optional().default("").describe("Why the old one is stale"),
});

export async function supersede(
  service: RelationsService,
  input: z.infer<typeof supersedeSchema>,
) {
  const r = await service.supersede(input.old_id, input.new_id, input.reason);
  if (r.ok === false) {
    return { content: [{ type: "text" as const, text: `Error: ${String(r.error)}` }], isError: true };
  }
  return {
    content: [{
      type: "text" as const,
      text: `superseded ${r.old_id}\n  by ${r.new_id}\n  valid_until=${r.valid_until}`,
    }],
  };
}
