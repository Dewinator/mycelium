/**
 * Auto-Absorb post-processor for the small-model middleware (issue #4, N4
 * — partial: Auto-Absorb only; Auto-Digest is a separate follow-up).
 *
 * The middleware (#2) sees both the user's prompt and the model's reply.
 * After every chat turn, run the conservative regex extractor (#8) over
 * BOTH sides and feed any matches into mycelium's memory store as
 * lightweight `general` memories.
 *
 * Design constraints
 * ------------------
 * - **Best-effort.** Failures (Supabase down, Ollama embed slow) must NOT
 *   delay the chat response. The proxy fires absorb in the background
 *   without awaiting.
 * - **Conservative.** Only N8's hard-trigger patterns. No LLM
 *   classification.
 * - **Process-local dedupe.** A short-TTL Set of fact-text hashes
 *   suppresses obvious within-session repeats so the same "ich habe
 *   gelernt: …" statement spread across a turn-by-turn back-and-forth
 *   doesn't create N copies. Cross-process dedupe is the existing
 *   `findSimilar` path on the MCP-server side; the nightly sleep cycle
 *   also dedupes (mig 029-style consolidation).
 * - **Annotated source.** Every middleware-side memory carries
 *   `source='middleware:auto-absorb'` and `metadata.pattern=<trigger>`
 *   so an operator (or N5 benchmark) can isolate auto-absorb's
 *   contribution from manual `remember` calls.
 */

import { PostgrestClient } from "@supabase/postgrest-js";
import { extractFacts, type FactPattern } from "../util/fact-extractor.js";
import { TtlLruCache } from "./prime-cache.js";

export interface AbsorberOptions {
  supabaseUrl:    string;
  supabaseKey:    string;
  ollamaUrl?:     string;
  embeddingModel?: string;
  /**
   * Optional embedding callback. When provided, takes precedence over the
   * built-in Ollama fetch — wire `createEmbeddingProvider().embed.bind(p)`
   * here so the middleware respects `MYCELIUM_LLM_PROVIDER=llama-cpp`
   * (issue #178, native-app track #176). Tests stay on the direct-fetch
   * failure path by leaving this unset.
   */
  embed?:         (text: string) => Promise<number[]>;
  /** TTL for the in-process dedupe Set. Default 10min. */
  dedupeTtlMs?:   number;
  /** Soft cap on absorbs per chat turn — guards against pathological inputs. */
  maxPerTurn?:    number;
}

export interface AbsorbResult {
  absorbed: number;
  skipped:  number;     // duplicates within process window
  failed:   number;     // embed or insert error
}

export interface AbsorberStats {
  total_absorbed: number;
  total_skipped:  number;
  total_failed:   number;
  by_pattern:     Record<FactPattern, number>;
}

const DEFAULT_DEDUPE_TTL = 10 * 60 * 1_000;
const DEFAULT_MAX_PER_TURN = 5;

/**
 * Stateful absorber. Per-process. Holds a tiny dedupe cache and aggregate
 * stats. The proxy holds one instance for its lifetime.
 */
export class Absorber {
  private db: PostgrestClient;
  private ollamaUrl: string;
  private embeddingModel: string;
  private embedOverride: ((text: string) => Promise<number[]>) | null;
  private dedupe: TtlLruCache<true>;
  private maxPerTurn: number;
  private absorbedCount = 0;
  private skippedCount  = 0;
  private failedCount   = 0;
  private byPattern: Record<FactPattern, number> = {
    ich_habe_gelernt: 0, merk_dir: 0, wichtig: 0, at_remember: 0, note_to_self: 0,
  };

  constructor(opts: AbsorberOptions) {
    this.db = new PostgrestClient(opts.supabaseUrl, {
      headers: opts.supabaseKey
        ? { Authorization: `Bearer ${opts.supabaseKey}`, apikey: opts.supabaseKey }
        : {},
    });
    this.ollamaUrl      = opts.ollamaUrl ?? "http://127.0.0.1:11434";
    this.embeddingModel = opts.embeddingModel ?? "nomic-embed-text";
    this.embedOverride  = opts.embed ?? null;
    this.dedupe = new TtlLruCache<true>({
      ttlMs:   opts.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL,
      maxSize: 500,
    });
    this.maxPerTurn = opts.maxPerTurn ?? DEFAULT_MAX_PER_TURN;
  }

  /**
   * Process the user + assistant texts of one chat turn. Runs in the
   * background — the caller does not await. Errors are logged, not thrown.
   * Returns a Promise mainly for tests; the proxy fires-and-forgets.
   */
  async processTurn(userText: string | undefined, assistantText: string | undefined): Promise<AbsorbResult> {
    const result: AbsorbResult = { absorbed: 0, skipped: 0, failed: 0 };
    const hits = [
      ...extractFacts(userText ?? "").map((h) => ({ ...h, side: "user" as const })),
      ...extractFacts(assistantText ?? "").map((h) => ({ ...h, side: "assistant" as const })),
    ].slice(0, this.maxPerTurn);

    for (const hit of hits) {
      // Dedupe key: pattern + text. Same fact captured in user AND
      // assistant within window counts once.
      const dedupeKey = `${hit.pattern}::${hit.text.toLowerCase()}`;
      if (this.dedupe.get(dedupeKey)) {
        result.skipped += 1;
        this.skippedCount += 1;
        continue;
      }
      try {
        await this.absorbOne(hit.text, hit.pattern, hit.side);
        this.dedupe.set(dedupeKey, true);
        result.absorbed += 1;
        this.absorbedCount += 1;
        this.byPattern[hit.pattern] += 1;
      } catch (err) {
        result.failed += 1;
        this.failedCount += 1;
        console.error(`[middleware] auto-absorb failed (${hit.pattern}):`,
          err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }

  stats(): AbsorberStats {
    return {
      total_absorbed: this.absorbedCount,
      total_skipped:  this.skippedCount,
      total_failed:   this.failedCount,
      by_pattern:     { ...this.byPattern },
    };
  }

  private async absorbOne(text: string, pattern: FactPattern, side: "user" | "assistant"): Promise<void> {
    const embedding = await this.embed(text);
    const { error } = await this.db
      .from("memories")
      .insert({
        content:  text,
        category: "general",
        tags:     [`auto-absorb`, `pattern:${pattern}`, `side:${side}`],
        embedding,
        metadata: { pattern, side, captured_at: new Date().toISOString() },
        source:   "middleware:auto-absorb",
        importance: 0.3,
        valence:    0.0,
        arousal:    0.0,
        pinned:     false,
      });
    if (error) throw new Error(error.message ?? JSON.stringify(error));
  }

  private async embed(text: string): Promise<number[]> {
    if (this.embedOverride) return this.embedOverride(text);
    const r = await fetch(new URL("/api/embed", this.ollamaUrl), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: this.embeddingModel, input: text }),
    });
    if (!r.ok) throw new Error(`ollama embed failed: HTTP ${r.status}`);
    const j = (await r.json()) as { embeddings?: number[][] };
    const v = j.embeddings?.[0];
    if (!v) throw new Error("ollama embed returned no vector");
    return v;
  }
}
