import { PostgrestClient } from "@supabase/postgrest-js";
import type {
  Memory,
  MemorySearchResult,
  SpreadResult,
  CrossSpreadResult,
  CreateMemoryInput,
  UpdateMemoryInput,
} from "../types/memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { scoreEncoding } from "./heuristics.js";

/**
 * PostgREST sometimes returns errors without a `.message` field (e.g. PGRST202,
 * permission denials), which used to surface in our logs as "undefined". Always
 * format with a fallback chain so the actual cause is visible.
 */
function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    // Error fields are non-enumerable → JSON.stringify gives "{}".
    // Walk the cause chain so undici/fetch wrappers reveal the real reason.
    const parts = [err.name, err.message].filter(Boolean);
    let cause: unknown = (err as { cause?: unknown }).cause;
    while (cause) {
      if (cause instanceof Error) {
        parts.push(`caused by ${cause.name}: ${cause.message}`);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(`caused by ${String(cause)}`);
        break;
      }
    }
    return parts.join(": ");
  }
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

/**
 * Wire literal for the `mark_useful` memory_event type.
 *
 * compute_affect() (docs/affect-observables.md §satisfaction) reads
 * memory_events filtered by `event_type='mark_useful'` to compute
 * `useful_delta`. The string is emitted from two independent call sites:
 *
 *   - `MemoryService.emitMarkUseful` (memory-subject path, this file)
 *   - `ExperienceService.markUseful` (experience-subject path, services/experiences.ts)
 *
 * Both must agree, and both must agree with the SQL formula. Centralising
 * the literal here means a rename forces a single edit (and the test in
 * `affect-event-types.test.ts` then fails until the spec doc is updated
 * too), instead of two emit sites silently drifting apart.
 */
export const MARK_USEFUL_EVENT_TYPE = "mark_useful" as const;

/**
 * Wire literal for the `recalled` memory_event type.
 *
 * compute_affect() (docs/affect-observables.md) reads memory_events filtered
 * by `event_type='recalled'` to compute three of the six affect dimensions:
 *
 *   §curiosity   — empty_recalls    (event_type='recalled' AND hits=0)
 *                  low_conf_recalls (event_type='recalled' AND score<0.4)
 *   §frustration — zero_hit_ratio   (event_type='recalled' AND hits=0)
 *
 * That makes this the most heavily-read literal in the whole spec. It is
 * emitted from a single producer (`MemoryService.emitRecalled` below),
 * which is in turn called from `tools/recall.ts` and `tools/belief.ts`.
 *
 * Centralising the literal here means a rename is a single deliberate edit
 * that also fails `affect-recalled-event-type.test.ts` until the spec doc +
 * SQL are updated to match — same defensive pattern as MARK_USEFUL_EVENT_TYPE.
 */
export const RECALLED_EVENT_TYPE = "recalled" as const;

/**
 * Wire literals for the `contradiction_detected` / `contradiction_resolved`
 * memory_event types.
 *
 * compute_affect() (docs/affect-observables.md §frustration) reads
 * memory_events filtered by both literals to compute `open_conflicts`:
 *
 *   open_conflicts = count(memory_events WHERE event_type='contradiction_detected'
 *                          AND created_at > now()-'48h'
 *                          AND NOT EXISTS (…resolution event with same trace_id…))
 *
 * The "…resolution event…" sub-clause matches `event_type='contradiction_resolved'`
 * with the same trace_id as the detection — see services/relations.ts
 * `maybeEmitContradictionResolved` for the closer logic. The two literals
 * are co-load-bearing: a silent rename of *either* would zero out the
 * frustration `open_conflicts` term in different ways:
 *
 *   - rename `contradiction_detected` → frustration sees zero conflicts
 *     (the count(*) in the outer query collapses to 0).
 *   - rename `contradiction_resolved` → frustration over-counts indefinitely
 *     (no resolutions match, so every detected row stays "open" forever).
 *
 * Each literal is emitted from a single producer:
 *   - `contradiction_detected` — `agents/conscience-agent.ts` (one bus.emit
 *     site, alongside `conscience_warning` with shared trace_id).
 *   - `contradiction_resolved` — `services/relations.ts`
 *     (`maybeEmitContradictionResolved` after a successful supersede_memory).
 *
 * `services/relations.ts` also reads `contradiction_detected` via
 * `.eq("event_type", …)` to find the detection it should pair with the
 * resolution — so that lookup must use the same constant as the producer,
 * or the resolver silently stops finding any detections to close.
 *
 * Centralising the literals here means a rename is a single deliberate edit
 * across producer + lookup + spec doc + SQL — same defensive pattern as
 * MARK_USEFUL_EVENT_TYPE / RECALLED_EVENT_TYPE. Pinned in
 * `affect-contradiction-event-types.test.ts`.
 */
export const CONTRADICTION_DETECTED_EVENT_TYPE = "contradiction_detected" as const;
export const CONTRADICTION_RESOLVED_EVENT_TYPE = "contradiction_resolved" as const;

/**
 * JSONB payload for `recalled` memory_events.
 *
 * The compute_affect() SQL formulas (docs/affect-observables.md §curiosity
 * and §frustration) read these keys directly via JSON pointer:
 *   (context->>'hits')::int   — empty_recalls / zero_hit_ratio
 *   (context->>'score')::float — low_conf_recalls
 *
 * Renaming or dropping a key here silently breaks the SQL trigger without
 * any TypeScript signal. The unit test in `affect-event-payloads.test.ts`
 * pins the key set + types so the contract stays in lockstep with the spec.
 */
export interface RecalledContext {
  hits: number;
  score: number;
  query_length: number;
}

export function buildRecalledContext(
  hits: number,
  topScore: number,
  queryLength: number,
): RecalledContext {
  return { hits, score: topScore, query_length: queryLength };
}

export class MemoryService {
  private db: PostgrestClient;
  private embeddings: EmbeddingProvider;
  private healthy = true;

  constructor(supabaseUrl: string, supabaseKey: string, embeddings: EmbeddingProvider) {
    // Use PostgrestClient directly instead of supabase-js: self-hosted PostgREST
    // serves under "/" while supabase-js hard-codes the "/rest/v1" prefix from
    // Supabase Cloud, which would 404 against our docker setup.
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.embeddings = embeddings;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const { error } = await this.db.from("memories").select("id").limit(1);
      this.healthy = !error;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  /** Find near-duplicate memories using a pure-vector pass (relevance only). */
  async findSimilar(content: string, threshold: number = 0.92): Promise<MemorySearchResult[]> {
    const results = await this.search(content, undefined, 3, 1.0);
    return results.filter((r) => r.relevance >= threshold);
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    const duplicates = await this.findSimilar(input.content);
    if (duplicates.length > 0) {
      console.error(
        `Skipped near-duplicate (relevance ${duplicates[0].relevance.toFixed(3)}) of memory ${duplicates[0].id} — touching it instead`
      );
      // Rehearse the existing trace rather than create a duplicate.
      await this.touch([duplicates[0].id]);
      const existing = await this.get(duplicates[0].id);
      if (existing) return existing;
    }

    const embedding = await this.embeddings.embed(input.content);

    // Auto-score from text when caller didn't supply explicit values.
    // This is the difference between defaults-everywhere (cognitive model
    // does nothing) and the model actually responding to content.
    const auto = scoreEncoding(input.content);
    const importance = input.importance ?? auto.importance;
    const valence = input.valence ?? auto.valence;
    const arousal = input.arousal ?? auto.arousal;
    const decay_tau_days = input.decay_tau_days ?? auto.decay_tau_days;

    const { data, error } = await this.db
      .from("memories")
      .insert({
        content: input.content,
        category: input.category ?? "general",
        tags: input.tags ?? [],
        embedding,
        metadata: input.metadata ?? {},
        source: input.source ?? null,
        importance,
        valence,
        arousal,
        pinned: input.pinned ?? false,
        decay_tau_days,
        project_id: input.project_id ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create memory: ${fmtErr(error)}`);
    const memory = data as Memory;

    // Hebbian seeding: link new memory to its semantic neighbors so spreading
    // activation has something to follow on the very first recall.
    try {
      const neighbors = await this.search(input.content, undefined, 4, 1.0);
      const neighborIds = neighbors
        .map((n) => n.id)
        .filter((id) => id !== memory.id)
        .slice(0, 3);
      if (neighborIds.length > 0) {
        await this.coactivate([memory.id, ...neighborIds]);
      }
      // Retrieval-induced forgetting: new similar info weakens old traces.
      await this.interfere(embedding, memory.id, 5);
    } catch (err) {
      console.error("Auto-link / interference failed (non-fatal):", err);
    }

    return memory;
  }

  /** Interference: weaken the k nearest existing memories when a new one is encoded. */
  async interfere(embedding: number[], excludeId: string, k = 5): Promise<void> {
    const { error } = await this.db.rpc("interfere_with_neighbors", {
      new_embedding: embedding,
      exclude_id: excludeId,
      k,
      decay_factor: 0.97,
    });
    if (error) console.error("interfere_with_neighbors failed:", error.message);
  }

  /** Strongest learning signal: this memory was actually used in an answer. */
  async markUseful(id: string): Promise<void> {
    const { error } = await this.db.rpc("mark_memory_useful", { memory_id: id });
    if (error) throw new Error(`mark_memory_useful failed: ${fmtErr(error)}`);
    await this.emitMarkUseful(id, "mcp:mark_useful");
  }

  /**
   * Emit one `mark_useful` event per explicit strong-learning signal.
   * Consumed by the compute_affect() triggers (see docs/affect-observables.md):
   * feeds the `useful_delta` term of `satisfaction`. Non-fatal — this is
   * telemetry, not a correctness dependency.
   */
  async emitMarkUseful(memoryId: string | null, source: string): Promise<void> {
    const { error } = await this.db.rpc("log_memory_event", {
      p_memory_id:  memoryId,
      p_event_type: MARK_USEFUL_EVENT_TYPE,
      p_source:     source,
      p_context:    {},
      p_trace_id:   null,
      p_created_by: null,
    });
    if (error) console.error(`emitMarkUseful(${source}) failed:`, fmtErr(error));
  }

  async dedup(threshold = 0.93): Promise<number> {
    const { data, error } = await this.db.rpc("dedup_similar_memories", {
      similarity_threshold: threshold,
      max_passes: 1000,
    });
    if (error) throw new Error(`dedup failed: ${fmtErr(error)}`);
    return (data as number) ?? 0;
  }

  /** Cognitive search: relevance × strength × salience. */
  async search(
    query: string,
    category?: string,
    limit: number = 10,
    vectorWeight: number = 0.6
  ): Promise<MemorySearchResult[]> {
    const queryEmbedding = await this.embeddings.embed(query);

    const { data, error } = await this.db.rpc("match_memories_cognitive", {
      query_embedding: queryEmbedding,
      query_text: query,
      match_count: limit,
      filter_category: category ?? null,
      vector_weight: vectorWeight,
      include_archived: false,
    });

    if (error) throw new Error(`Failed to search memories: ${fmtErr(error)}`);
    return (data ?? []) as MemorySearchResult[];
  }

  /** Rehearse memories — strengthens trace and updates last_accessed_at. */
  async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.db.rpc("touch_memories", { memory_ids: ids });
    if (error) console.error("touch_memories failed:", error.message);
  }

  /** Hebbian co-activation: link memories that fired together. */
  async coactivate(ids: string[]): Promise<void> {
    if (ids.length < 2) return;
    const { error } = await this.db.rpc("coactivate_memories", { memory_ids: ids });
    if (error) console.error("coactivate_memories failed:", error.message);
  }

  /**
   * Emit one `recalled` event per recall call with hit count and top score
   * in the context payload. Consumed by the compute_affect() triggers
   * (see docs/affect-observables.md): `hits=0` feeds empty_recalls, and
   * `score<0.4` feeds low_conf_recalls.
   *
   * Non-fatal on error — this is telemetry, not a correctness dependency.
   */
  async emitRecalled(
    hits: number,
    topScore: number,
    queryLength: number,
    source: string
  ): Promise<void> {
    const { error } = await this.db.rpc("log_memory_event", {
      p_memory_id:  null,
      p_event_type: RECALLED_EVENT_TYPE,
      p_source:     source,
      p_context:    buildRecalledContext(hits, topScore, queryLength),
      p_trace_id:   null,
      p_created_by: null,
    });
    if (error) console.error(`emitRecalled(${source}) failed:`, fmtErr(error));
  }

  /**
   * Emit one `used_in_response` event per id, all sharing a trace_id.
   * Consumed by the CoactivationAgent (Migration 047 event-bus). Non-fatal
   * on error — this is telemetry, not a correctness dependency.
   */
  async emitUsedInResponse(ids: string[], traceId: string): Promise<void> {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) =>
      this.db.rpc("log_memory_event", {
        p_memory_id:  id,
        p_event_type: "used_in_response",
        p_source:     "mcp:recall:cite",
        p_context:    {},
        p_trace_id:   traceId,
        p_created_by: null,
      }).then(({ error }) => {
        if (error) console.error(`emitUsedInResponse(${id.slice(0,8)}) failed:`, error.message ?? error);
      })
    ));
  }

  /** Spreading activation — return associated neighbors of the seed memories.
   *  Memory-only legacy path (kept for callers that don't want cross-kind
   *  results — most should prefer spreadCross). */
  async spread(seedIds: string[], maxNeighbors: number = 5): Promise<SpreadResult[]> {
    if (seedIds.length === 0) return [];
    const { data, error } = await this.db.rpc("spread_activation", {
      seed_ids: seedIds,
      max_neighbors: maxNeighbors,
    });
    if (error) {
      console.error("spread_activation failed:", error.message);
      return [];
    }
    return (data ?? []) as SpreadResult[];
  }

  /** Polymorphic spreading activation (Migration 054) — walks memory_links
   *  AND experience_memory_links from a single typed seed and returns
   *  neighbors as (kind, id, content, …). The kind expands as future
   *  Hebbian tables ship; signature is forward-compatible. */
  async spreadCross(
    seedKind: CrossSpreadResult["kind"],
    seedId: string,
    maxNeighbors: number = 5,
  ): Promise<CrossSpreadResult[]> {
    const { data, error } = await this.db.rpc("spread_activation_cross", {
      p_seed_kind:     seedKind,
      p_seed_id:       seedId,
      p_max_neighbors: maxNeighbors,
    });
    if (error) {
      console.error("spread_activation_cross failed:", error.message);
      return [];
    }
    return (data ?? []) as CrossSpreadResult[];
  }

  async consolidate(minAccessCount = 3, minAgeDays = 1): Promise<number> {
    const { data, error } = await this.db.rpc("consolidate_memories", {
      min_access_count: minAccessCount,
      min_age_days: minAgeDays,
    });
    if (error) throw new Error(`consolidate failed: ${fmtErr(error)}`);
    return (data as number) ?? 0;
  }

  async forgetWeak(strengthThreshold = 0.05, minAgeDays = 7): Promise<number> {
    const { data, error } = await this.db.rpc("forget_weak_memories", {
      strength_threshold: strengthThreshold,
      min_age_days: minAgeDays,
    });
    if (error) throw new Error(`forget_weak failed: ${fmtErr(error)}`);
    return (data as number) ?? 0;
  }

  async get(id: string): Promise<Memory | null> {
    const { data, error } = await this.db.from("memories").select("*").eq("id", id).single();
    if (error) {
      if (error.code === "PGRST116") return null;
      throw new Error(`Failed to get memory: ${fmtErr(error)}`);
    }
    return data as Memory;
  }

  async update(input: UpdateMemoryInput): Promise<Memory> {
    const updates: Record<string, unknown> = {};
    if (input.content !== undefined) {
      updates.content = input.content;
      updates.embedding = await this.embeddings.embed(input.content);
    }
    if (input.category !== undefined) updates.category = input.category;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.metadata !== undefined) updates.metadata = input.metadata;
    if (input.importance !== undefined) updates.importance = input.importance;
    if (input.valence !== undefined) updates.valence = input.valence;
    if (input.arousal !== undefined) updates.arousal = input.arousal;
    if (input.pinned !== undefined) updates.pinned = input.pinned;

    const { data, error } = await this.db
      .from("memories")
      .update(updates)
      .eq("id", input.id)
      .select()
      .single();

    if (error) throw new Error(`Failed to update memory: ${fmtErr(error)}`);
    return data as Memory;
  }

  async delete(id: string): Promise<boolean> {
    const { error } = await this.db.from("memories").delete().eq("id", id);
    if (error) throw new Error(`Failed to delete memory: ${fmtErr(error)}`);
    return true;
  }

  /**
   * For a given memory, return any linked experiences (cross-layer Hebbian
   * edges from migration 016). This is what makes "lived knowledge" possible:
   * a fact recall surfaces "and here's how it actually went last time".
   */
  async experiencesForMemory(
    memoryId: string,
    limit = 3
  ): Promise<
    Array<{
      id: string;
      summary: string;
      outcome: string;
      difficulty: number;
      valence: number;
      weight: number;
      created_at: string;
    }>
  > {
    const { data, error } = await this.db.rpc("experiences_for_memory", {
      p_memory_id: memoryId,
      p_limit:     limit,
    });
    if (error) {
      // Non-fatal: migration 016 may not be applied yet.
      console.error("experiences_for_memory failed (non-fatal):", error.message);
      return [];
    }
    return (data ?? []) as Array<{
      id: string;
      summary: string;
      outcome: string;
      difficulty: number;
      valence: number;
      weight: number;
      created_at: string;
    }>;
  }

  async list(category?: string, limit: number = 20): Promise<Memory[]> {
    let query = this.db
      .from("memories")
      .select("*")
      .neq("stage", "archived")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (category) {
      query = query.eq("category", category);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list memories: ${fmtErr(error)}`);
    return (data ?? []) as Memory[];
  }
}
