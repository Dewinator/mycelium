/**
 * Auto-Digest runner — fires record_experience for sessions that have been
 * idle past N9's threshold (#4 N4 + N9 spec).
 *
 * Wraps a SessionTracker:
 *   - on a timer (default 60s), reapIdle() — find sessions idle ≥ 30min
 *   - for each, mark advisory-lock-in-flight (no double-digest)
 *   - skip silent sessions (no user msgs and no errors) per N9 §default
 *   - call record_experience RPC with aggregated session metadata
 *   - finishDigest() to drop the session row
 *
 * record_experience triggers compute_affect (mig 062) which in turn
 * triggers neurochem_apply via the affect→neurochem reverse loop
 * (mig 065). The Auto-Digest is therefore a single RPC call that lights
 * up the entire downstream cognitive pipeline.
 */

import { PostgrestClient } from "@supabase/postgrest-js";
import type { SessionTracker, SessionSnapshot } from "./session-tracker.js";

export interface DigesterOptions {
  supabaseUrl:     string;
  supabaseKey:     string;
  ollamaUrl?:      string;
  embeddingModel?: string;
  /**
   * Optional embedding callback. When provided, takes precedence over the
   * built-in Ollama fetch — wire `createEmbeddingProvider().embed.bind(p)`
   * here so the digest pipeline respects `MYCELIUM_LLM_PROVIDER=llama-cpp`
   * (issue #178, native-app track #176).
   */
  embed?:          (text: string) => Promise<number[]>;
  /** Tick interval in ms. Default 60s. */
  tickMs?:         number;
}

export interface DigestResult {
  fired:   number;
  skipped_silent: number;
  failed:  number;
}

export interface DigesterStats {
  total_fired:         number;
  total_skipped_silent: number;
  total_failed:        number;
  last_tick_at:        number | null;
  ticks:               number;
}

export class Digester {
  private db: PostgrestClient;
  private ollamaUrl: string;
  private embeddingModel: string;
  private embedOverride: ((text: string) => Promise<number[]>) | null;
  private tracker: SessionTracker;
  private tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firedCount = 0;
  private silentCount = 0;
  private failedCount = 0;
  private tickCount = 0;
  private lastTickAt: number | null = null;

  constructor(tracker: SessionTracker, opts: DigesterOptions) {
    this.tracker = tracker;
    this.db = new PostgrestClient(opts.supabaseUrl, {
      headers: opts.supabaseKey
        ? { Authorization: `Bearer ${opts.supabaseKey}`, apikey: opts.supabaseKey }
        : {},
    });
    this.ollamaUrl      = opts.ollamaUrl ?? "http://127.0.0.1:11434";
    this.embeddingModel = opts.embeddingModel ?? "nomic-embed-text";
    this.embedOverride  = opts.embed ?? null;
    this.tickMs         = opts.tickMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    // unref so the timer doesn't keep node alive past SIGTERM.
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * One pass of the idle-sweep. Returns counts so tests don't have to wait
   * on the timer; they can call tick() directly with an injected clock.
   */
  async tick(): Promise<DigestResult> {
    this.tickCount += 1;
    this.lastTickAt = Date.now();
    const result: DigestResult = { fired: 0, skipped_silent: 0, failed: 0 };
    const candidates = this.tracker.reapIdle();
    for (const c of candidates) {
      if (!this.tracker.markDigestStart(c.client_key)) continue;  // someone got there first
      try {
        const fired = await this.fireOne(c);
        if (fired) {
          this.tracker.finishDigest(c.client_key);
          result.fired += 1;
          this.firedCount += 1;
        } else {
          // Silent session — drop the tracking row so the next message
          // starts fresh, but don't write a digest.
          this.tracker.finishDigest(c.client_key);
          result.skipped_silent += 1;
          this.silentCount += 1;
        }
      } catch (err) {
        // Per N9 §3 "transient verloren" — log and forget. Do NOT retry
        // from this layer. Cancel the lock so the next tick can re-attempt.
        result.failed += 1;
        this.failedCount += 1;
        this.tracker.cancelDigest(c.client_key);
        console.error(`[middleware] auto-digest failed (${c.client_key}):`,
          err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }

  stats(): DigesterStats {
    return {
      total_fired:          this.firedCount,
      total_skipped_silent: this.silentCount,
      total_failed:         this.failedCount,
      last_tick_at:         this.lastTickAt,
      ticks:                this.tickCount,
    };
  }

  /**
   * Decide + write one digest. Returns true if record_experience landed,
   * false for silent-session skip.
   */
  private async fireOne(c: SessionSnapshot): Promise<boolean> {
    // N9 §default — silent sessions don't get digested. A session is
    // silent if it has zero user messages AND zero errors. The
    // assistant_messages alone are not a reason to digest (a long stream
    // of model output without any human prompt is rare and not
    // experience-worthy).
    if (c.user_messages === 0 && c.errors === 0) return false;

    const summary = this.buildSummary(c);
    const outcome = this.deriveOutcome(c);
    const embedding = await this.embed(summary);

    const { error } = await this.db.rpc("record_experience", {
      p_summary:           summary,
      p_embedding:         embedding,
      p_session_id:        c.session_id,
      p_task_type:         null,
      p_details:           JSON.stringify({
        user_messages:      c.user_messages,
        assistant_messages: c.assistant_messages,
        models_seen:        c.models_seen,
        errors:             c.errors,
        idle_ms:            c.idle_ms,
        duration_ms:        c.last_activity_at - c.started_at,
        client_key:         c.client_key,
      }),
      p_outcome:           outcome,
      p_difficulty:        0.5,
      p_confidence_before: null,
      p_confidence_after:  null,
      p_user_sentiment:    null,
      p_valence:           outcome === "success" ? 0.3 : outcome === "failure" ? -0.3 : 0,
      p_arousal:           0.2,
      p_what_worked:       null,
      p_what_failed:       c.errors > 0 ? `${c.errors} upstream error(s)` : null,
      p_tools_used:        c.models_seen,
      p_tags:              ["middleware:auto-digest"],
      p_metadata:          { source: "middleware:auto-digest" },
    });
    if (error) throw new Error(error.message ?? JSON.stringify(error));
    return true;
  }

  private buildSummary(c: SessionSnapshot): string {
    const minutes = Math.round((c.last_activity_at - c.started_at) / 60_000);
    const models = c.models_seen.length ? c.models_seen.join(", ") : "no model";
    return [
      `Middleware session ended (idle ≥30min).`,
      `${c.user_messages} user message(s), ${c.assistant_messages} assistant reply(ies),`,
      `${c.errors} error(s) over ~${minutes} min via ${models}.`,
    ].join(" ");
  }

  private deriveOutcome(c: SessionSnapshot): "success" | "partial" | "failure" | "unknown" {
    if (c.user_messages === 0) return "unknown";
    if (c.errors === 0 && c.assistant_messages > 0) return "success";
    if (c.errors > 0 && c.assistant_messages > 0) return "partial";
    if (c.errors > 0 && c.assistant_messages === 0) return "failure";
    return "unknown";
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
