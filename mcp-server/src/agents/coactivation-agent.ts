import type { Agent, AgentEventBus, BusEvent } from "./event-bus.js";
import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * CoactivationAgent
 * -----------------
 * Biologically: "neurons that fire together, wire together" (Hebbian).
 *
 * Listens for every `used_in_response` event (a memory was actually cited
 * in a model response). Groups them by trace_id — all memories used in
 * the same response are considered co-active. Calls coactivate_pair()
 * (Migration 048) pairwise to bump memory_links.weight and
 * coactivation_count.
 *
 * Why this is worth an agent and not a client-side call:
 *   * Callers that mark memories as "used" (the digest pipeline, the
 *     PreToolUse hook, …) shouldn't have to know about pairing logic.
 *   * The event stream is the natural place to batch per-trace.
 *
 * Idempotence: coactivate_pair is additive but re-running on the same
 * trace would inflate weights. We debounce with a 30s window: only
 * process events whose trace is "complete" (no new used_in_response in
 * the last 30s). Since the bus replays up to 10min on cold-start, we
 * also de-dupe by trace-id in-memory.
 */

const DEBOUNCE_MS = 30_000;

interface PendingTrace {
  memoryIds: Set<string>;
  lastSeenAt: number;
}

export class CoactivationAgent implements Agent {
  readonly name = "coactivation";
  readonly subscribedEvents = ["used_in_response"];

  private pending = new Map<string, PendingTrace>();
  private processed = new Set<string>();
  private db: PostgrestClient;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    // Flush timer runs independently of the bus tick so debouncing works
    // even when no new events arrive.
    this.flushTimer = setInterval(() => void this.flushDue(), 10_000);
  }

  async handle(event: BusEvent, _bus: AgentEventBus): Promise<void> {
    if (!event.memory_id || !event.trace_id) return;
    if (this.processed.has(event.trace_id)) return;

    const existing = this.pending.get(event.trace_id);
    if (existing) {
      existing.memoryIds.add(event.memory_id);
      existing.lastSeenAt = Date.now();
    } else {
      this.pending.set(event.trace_id, {
        memoryIds: new Set([event.memory_id]),
        lastSeenAt: Date.now(),
      });
    }
  }

  private async flushDue(): Promise<void> {
    const now = Date.now();
    const due: Array<[string, PendingTrace]> = [];
    for (const [trace, p] of this.pending) {
      if (now - p.lastSeenAt >= DEBOUNCE_MS) due.push([trace, p]);
    }
    for (const [trace, p] of due) {
      this.pending.delete(trace);
      if (p.memoryIds.size < 2) {
        this.processed.add(trace);
        continue;
      }
      await this.coactivateSet(trace, [...p.memoryIds]);
      this.processed.add(trace);
    }
    // Bound the processed set so it doesn't grow unbounded in a long-running
    // server. Keep the last 10k traces.
    if (this.processed.size > 10_000) {
      const arr = [...this.processed];
      this.processed = new Set(arr.slice(arr.length - 5_000));
    }
  }

  private async coactivateSet(trace: string, ids: string[]): Promise<void> {
    const delta = ids.length <= 2 ? 0.08 : ids.length <= 5 ? 0.05 : 0.03;
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    }
    for (const [a, b] of pairs) {
      const { error } = await this.db.rpc("coactivate_pair", { p_x: a, p_y: b, p_delta: delta });
      if (error) {
        console.error(`[coactivation] pair (${a.slice(0,8)}, ${b.slice(0,8)}) failed: ${error.message ?? String(error)}`);
      }
    }
    console.error(`[coactivation] trace=${trace.slice(0,8)}: ${ids.length} memories → ${pairs.length} pairs (δ=${delta})`);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
