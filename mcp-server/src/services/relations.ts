import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Memory-to-memory relations graph (Migration 046 + 047).
 *
 * Explicit, typed edges between memories (distinct from the undirected
 * Hebbian memory_links in migration 007). Backs the chain / why / history
 * MCP tools and is the read primitive for future saga-style agents that
 * need to walk causal chains across the memory layer.
 */

export type RelationType =
  | "caused_by"
  | "led_to"
  | "supersedes"
  | "contradicts"
  | "related"
  | "overrides"
  | "originated_in"
  | "learned_from"
  | "depends_on"
  | "exemplifies"
  | "fixed_by"
  | "repeated_mistake"
  | "validated_by";

export const RELATION_TYPES: RelationType[] = [
  "caused_by", "led_to", "supersedes", "contradicts", "related",
  "overrides", "originated_in", "learned_from", "depends_on",
  "exemplifies", "fixed_by", "repeated_mistake", "validated_by",
];

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string };
  return e.message || e.details || e.hint || JSON.stringify(err);
}

export class RelationsService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async chain(
    aId: string,
    bId: string,
    type: RelationType,
    reason: string,
    weight: number,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("chain_memories", {
      p_a_id:   aId,
      p_b_id:   bId,
      p_type:   type,
      p_reason: reason,
      p_weight: weight,
    });
    if (error) throw new Error(`chain_memories failed: ${fmtErr(error)}`);
    return (data as Record<string, unknown>) ?? {};
  }

  async why(memoryId: string): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("memory_why", { p_memory_id: memoryId });
    if (error) throw new Error(`memory_why failed: ${fmtErr(error)}`);
    return (data as Record<string, unknown>) ?? { exists: false };
  }

  async history(memoryId: string, limit: number): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("memory_history", {
      p_memory_id: memoryId,
      p_limit:     limit,
    });
    if (error) throw new Error(`memory_history failed: ${fmtErr(error)}`);
    return (data as Record<string, unknown>) ?? { exists: false };
  }

  async neighbors(
    memoryId: string,
    depth: number,
    types: RelationType[] | null,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("memory_neighbors", {
      p_memory_id: memoryId,
      p_depth:     depth,
      p_types:     types,
    });
    if (error) throw new Error(`memory_neighbors failed: ${fmtErr(error)}`);
    return (data as Record<string, unknown>) ?? { ok: false };
  }

  async supersede(
    oldId: string,
    newId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("supersede_memory", {
      p_old_id: oldId,
      p_new_id: newId,
      p_reason: reason,
    });
    if (error) throw new Error(`supersede_memory failed: ${fmtErr(error)}`);
    return (data as Record<string, unknown>) ?? { ok: false };
  }
}
