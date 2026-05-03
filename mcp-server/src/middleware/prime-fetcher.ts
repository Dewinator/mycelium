/**
 * Prime-context fetcher for the small-model middleware (issue #2, N2).
 *
 * The middleware sits between an MCP client and an LLM endpoint (Ollama in
 * Phase 1). Before forwarding, it asks mycelium for the same data
 * `prime_context_compact` would surface and renders it through the same
 * pure formatter (mcp-server/src/util/context-formatter.ts).
 *
 * This file is the data layer. It calls the existing Supabase RPCs the MCP
 * tools already use — primeContextStatic, recall_experiences,
 * match_memories_cognitive, affect_get, skill_recommend — without dragging
 * in the full MCP server. No agent registration, no event bus, no neurochem
 * — those live on the MCP server side.
 */

import { PostgrestClient } from "@supabase/postgrest-js";
import { CompactContextInput, formatCompactContext } from "../util/context-formatter.js";
import { TtlLruCache, buildPrimeKey, type PrimeCacheOptions, type CacheStats } from "./prime-cache.js";

export interface PrimeFetcherOptions {
  supabaseUrl: string;
  supabaseKey: string;
  ollamaUrl?:  string;          // for embedding the task_description
  embeddingModel?: string;
  /**
   * Optional embedding callback. When provided, takes precedence over the
   * built-in Ollama fetch — wire `createEmbeddingProvider().embed.bind(p)`
   * here so the prime fetcher respects `MYCELIUM_LLM_PROVIDER=llama-cpp`
   * (issue #178, native-app track #176).
   */
  embed?:      (text: string) => Promise<number[]>;
  recallLimit?: number;         // experiences + memories per side
  /** Cache configuration (#7, N7). Pass null to disable caching entirely. */
  cache?:      PrimeCacheOptions | null;
}

interface MoodSnapshotRpc {
  window_hours: number;
  label:        string;
  valence:      number;
  arousal:      number;
  n:            number;
}

interface PrimeContextStaticRpc {
  mood:               MoodSnapshotRpc;
  recent_pattern:     { last_n: number; success_rate: number | null; avg_difficulty: number | null };
  top_traits:         { trait: string; polarity: number; evidence_count: number }[];
  active_intentions:  { intention: string; priority: number; progress: number }[];
  open_conflicts:     { a_trait: string; b_trait: string; polarity_diff: number }[];
}

interface AffectRpc {
  curiosity?:    number;
  frustration?:  number;
  satisfaction?: number;
  confidence?:   number;
  valence?:      number;
  arousal?:      number;
}

interface RecallExpRpc {
  content: string;
  outcome?: string | null;
  kind?: string;
}

interface MatchMemRpc {
  content: string;
}

interface SkillRecRpc {
  skill: string;
  success_rate: number | null;
  n_total: number;
  n_failure: number;
}

export class PrimeFetcher {
  private db: PostgrestClient;
  private ollamaUrl: string;
  private embeddingModel: string;
  private embedOverride: ((text: string) => Promise<number[]>) | null;
  private recallLimit: number;
  private cache: TtlLruCache<string> | null;

  constructor(opts: PrimeFetcherOptions) {
    // PostgrestClient directly, not @supabase/supabase-js: the self-hosted
    // PostgREST serves under "/" while supabase-js hard-codes the "/rest/v1"
    // prefix from Supabase Cloud, which 404s against our docker setup. Same
    // pattern as MemoryService in services/supabase.ts.
    this.db = new PostgrestClient(opts.supabaseUrl, {
      headers: opts.supabaseKey
        ? { Authorization: `Bearer ${opts.supabaseKey}`, apikey: opts.supabaseKey }
        : {},
    });
    this.ollamaUrl      = opts.ollamaUrl ?? "http://127.0.0.1:11434";
    this.embeddingModel = opts.embeddingModel ?? "nomic-embed-text";
    this.embedOverride  = opts.embed ?? null;
    this.recallLimit    = opts.recallLimit ?? 5;
    this.cache          = opts.cache === null ? null : new TtlLruCache<string>(opts.cache ?? {});
  }

  /** Cache stats for /health surface. Returns null when cache is disabled. */
  cacheStats(): CacheStats | null {
    return this.cache ? this.cache.stats() : null;
  }

  /** Drop the cache (for tests + manual invalidation). */
  clearCache(): void {
    this.cache?.clear();
  }

  /**
   * Build a CompactContextInput for the given task. Returns null on
   * unrecoverable failure — the caller should forward the LLM request
   * without injection rather than block on a missing context.
   */
  async build(taskDescription: string | undefined, taskType?: string): Promise<CompactContextInput | null> {
    try {
      const [staticCtx, affect] = await Promise.all([
        this.callStatic(),
        this.callAffect().catch(() => null),
      ]);

      let taskExperiences: { content: string; outcome?: string | null; kind?: string }[] = [];
      let taskMemories:    { content: string }[] = [];
      let skillHints: CompactContextInput["skill_hints"];

      if (taskDescription && taskDescription.trim() && this.recallLimit > 0) {
        const embedding = await this.embed(taskDescription).catch(() => null);
        if (embedding) {
          const [exps, mems] = await Promise.all([
            this.callRecallExperiences(embedding, taskDescription).catch(() => []),
            this.callMatchMemories(embedding, taskDescription).catch(() => []),
          ]);
          taskExperiences = exps.slice(0, this.recallLimit).map((e) => ({
            content: e.content, outcome: e.outcome, kind: e.kind,
          }));
          taskMemories = mems.slice(0, this.recallLimit).map((m) => ({ content: m.content }));
        }
      }

      if (taskType) {
        const recs = await this.callSkillRecommend(taskType).catch(() => []);
        if (recs.length) {
          skillHints = {
            task_type: taskType,
            skills: recs.map((r) => ({
              skill: r.skill,
              success_rate: r.success_rate,
              n_total: r.n_total,
              n_failure: r.n_failure,
            })),
          };
        }
      }

      return {
        task_description: taskDescription,
        affect: affect ? {
          curiosity:    affect.curiosity,
          frustration:  affect.frustration,
          satisfaction: affect.satisfaction,
          confidence:   affect.confidence,
        } : undefined,
        mood: {
          label:        staticCtx.mood.label,
          valence:      staticCtx.mood.valence,
          arousal:      staticCtx.mood.arousal,
          n:            staticCtx.mood.n,
          window_hours: staticCtx.mood.window_hours,
        },
        recent_pattern: staticCtx.recent_pattern.last_n > 0 ? {
          last_n:         staticCtx.recent_pattern.last_n,
          success_rate:   staticCtx.recent_pattern.success_rate,
          avg_difficulty: staticCtx.recent_pattern.avg_difficulty,
        } : undefined,
        traits:     staticCtx.top_traits,
        intentions: staticCtx.active_intentions,
        conflicts:  staticCtx.open_conflicts.slice(0, 3),
        skill_hints:      skillHints,
        task_experiences: taskExperiences,
        task_memories:    taskMemories,
      };
    } catch (err) {
      console.error("[middleware] prime-fetcher failed (non-fatal):",
        err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Convenience: build + format in one call. Returns null on failure.
   *
   * When the cache is enabled (default), repeat calls within `ttlMs` for the
   * same `(taskDescription, taskType)` short-circuit Supabase + Ollama
   * entirely (#7). Cache hits return the same formatted string regardless
   * of any concurrent agent_affect / experience writes — that's the
   * intended TTL trade-off, calibrated against the issue body's 5min
   * default.
   */
  async buildAndFormat(taskDescription: string | undefined, taskType?: string): Promise<string | null> {
    if (this.cache) {
      const key = buildPrimeKey(taskDescription, taskType);
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;
      const input = await this.build(taskDescription, taskType);
      if (!input) return null;
      const formatted = formatCompactContext(input);
      this.cache.set(key, formatted);
      return formatted;
    }
    const input = await this.build(taskDescription, taskType);
    if (!input) return null;
    return formatCompactContext(input);
  }

  private async callStatic(): Promise<PrimeContextStaticRpc> {
    const { data, error } = await this.db.rpc("prime_context_static");
    if (error) throw new Error(`prime_context_static failed: ${error.message}`);
    return data as PrimeContextStaticRpc;
  }

  private async callAffect(): Promise<AffectRpc> {
    const { data, error } = await this.db.rpc("affect_get");
    if (error) throw new Error(`affect_get failed: ${error.message}`);
    return data as AffectRpc;
  }

  private async callRecallExperiences(embedding: number[], taskText: string): Promise<RecallExpRpc[]> {
    const { data, error } = await this.db.rpc("recall_experiences", {
      query_embedding: embedding,
      query_text:      taskText,
      match_count:     this.recallLimit,
      include_lessons: true,
    });
    if (error) throw new Error(`recall_experiences failed: ${error.message}`);
    return Array.isArray(data) ? (data as RecallExpRpc[]) : [];
  }

  private async callMatchMemories(embedding: number[], taskText: string): Promise<MatchMemRpc[]> {
    const { data, error } = await this.db.rpc("match_memories_cognitive", {
      query_embedding:  embedding,
      query_text:       taskText,
      match_count:      this.recallLimit,
      vector_weight:    0.6,
      include_archived: false,
    });
    if (error) throw new Error(`match_memories_cognitive failed: ${error.message}`);
    return Array.isArray(data) ? (data as MatchMemRpc[]) : [];
  }

  private async callSkillRecommend(taskType: string): Promise<SkillRecRpc[]> {
    const { data, error } = await this.db.rpc("skill_recommend", {
      p_task_type: taskType, p_limit: 2, p_min_n: 3,
    });
    if (error) throw new Error(`skill_recommend failed: ${error.message}`);
    return Array.isArray(data) ? (data as SkillRecRpc[]) : [];
  }

  private async embed(text: string): Promise<number[]> {
    if (this.embedOverride) return this.embedOverride(text);
    const r = await fetch(new URL("/api/embed", this.ollamaUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
    });
    if (!r.ok) throw new Error(`ollama embed failed: HTTP ${r.status}`);
    const j = (await r.json()) as { embeddings?: number[][] };
    const v = j.embeddings?.[0];
    if (!v) throw new Error("ollama embed returned no vector");
    return v;
  }
}
