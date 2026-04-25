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
    const result = (data as Record<string, unknown>) ?? { ok: false };
    if (result.ok !== false) {
      await this.maybeEmitContradictionResolved(oldId, newId);
    }
    return result;
  }

  /**
   * If conscience-agent previously flagged (oldId, newId) as a contradiction,
   * emit a matching `contradiction_resolved` event with the same trace_id.
   * This closes the open-conflict loop read by compute_affect()'s frustration
   * term — see docs/affect-observables.md §frustration.
   *
   * Non-fatal on error: supersede itself has already succeeded; the event is
   * telemetry for the affect pipeline, not a correctness dependency.
   */
  private async maybeEmitContradictionResolved(
    oldId: string,
    newId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from("memory_events")
      .select("trace_id, memory_id, context")
      .eq("event_type", "contradiction_detected")
      .in("memory_id", [oldId, newId])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.error(`[supersede] contradiction lookup failed: ${fmtErr(error)}`);
      return;
    }
    const rows = (data ?? []) as ContradictionDetectedRow[];
    const match = findResolutionMatch(rows, oldId, newId);
    if (!match) return;
    const { error: logErr } = await this.db.rpc("log_memory_event", {
      p_memory_id:  oldId,
      p_event_type: "contradiction_resolved",
      p_source:     "mcp:supersede_memory",
      p_context:    buildContradictionResolvedContext(newId),
      p_trace_id:   match.trace_id,
      p_created_by: null,
    });
    if (logErr) {
      console.error(`[supersede] emit contradiction_resolved failed: ${fmtErr(logErr)}`);
    }
  }
}

export interface ContradictionDetectedRow {
  trace_id: string | null;
  memory_id: string;
  context: { contradicts_id?: string } | null;
}

/**
 * JSONB context payload for `contradiction_resolved` memory_events.
 *
 * The frustration term of compute_affect() (docs/affect-observables.md
 * §frustration) closes the open-conflict loop by trace_id, not by reading
 * this payload — but the keys are still load-bearing for downstream
 * consumers (e.g. dashboard surface, future audit-trail tooling) that need
 * to know *how* the contradiction was resolved. Pulling the literal out of
 * relations.ts:supersede() and pinning it with unit tests guards against
 * silent drift across renames or refactors. Mirrors the same defensive
 * pattern as `buildContradictionDetectedContext` and `buildRecalledContext`.
 *
 * Pure: no side-effects, no aliasing — every call returns a fresh object.
 */
export function buildContradictionResolvedContext(
  supersederId: string,
): { resolution: "superseded"; superseder_id: string } {
  return { resolution: "superseded", superseder_id: supersederId };
}

/**
 * Bidirectional lookup for a `contradiction_detected` row that pairs
 * (oldId, newId). ConscienceAgent stamps the event on one side only —
 * `memory_id = newMemory.id` with `context.contradicts_id = oldMemory.id`
 * — so the matcher must tolerate either direction of the pair.
 *
 * Exported so __tests__/relations.test.ts can pin the payload shape
 * compute_affect()'s frustration term depends on without needing a live
 * PostgrestClient. See docs/affect-observables.md §frustration.
 */
export function findResolutionMatch(
  rows: ContradictionDetectedRow[],
  oldId: string,
  newId: string,
): ContradictionDetectedRow | null {
  return rows.find((e) => {
    const other = e.context?.contradicts_id;
    return (e.memory_id === oldId && other === newId) ||
           (e.memory_id === newId && other === oldId);
  }) ?? null;
}
