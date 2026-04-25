import type { Agent, AgentEventBus, BusEvent } from "./event-bus.js";
import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * SalienceReactor
 * ---------------
 * Phase 2 of the Hub-Architektur: a single agent that turns memory_events
 * into salience deltas on the four non-memory cognitive tables
 * (experiences, lessons, soul_traits, intentions).
 *
 * Why the memory table is NOT handled here: memories already have a
 * computed salience (008's match_memories_cognitive: pinned, valence,
 * arousal) plus persistent counters (strength, useful_count, access_count)
 * that recall.ts touches on the hot path. Layering a second salience
 * scalar on memories would just create two systems that drift. The
 * Reactor's job is to bring the OTHER four tables into the same
 * "heard recently / mattered recently" channel, so spreading-activation
 * and future hub-views can rank across kinds with a common signal.
 *
 * Event-to-salience map (deltas chosen to mirror the existing memory
 * mechanics — small bumps for retrieval, big bumps for explicit "useful",
 * penalties for contradictions):
 *
 *   mark_useful (source='mcp:mark_experience_useful')
 *     → bump_salience('experience', context.experience_id, +0.10)
 *   agent_completed → bump_salience('experience', context.experience_id, +0.03)
 *   agent_error     → bump_salience('experience', context.experience_id, -0.03)
 *
 * Memory-targeted events (mark_useful with source='mcp:mark_useful',
 * used_in_response, contradiction_detected, contradiction_resolved,
 * recalled) are intentionally ignored — they're already handled by the
 * memory layer's own mechanics. We listen to them anyway to keep the
 * subscription explicit and to log a hit count, which makes diagnosing
 * a future "wait why isn't salience moving" moment trivial.
 *
 * Idempotence: bump_salience is mutative, not additive on identity, so
 * replaying the same event would double-count. The bus delivers
 * at-least-once but advances cursor per event, so duplicates only
 * happen on cold-start lookback overlap. Acceptable: the smooth-bump
 * shape (delta * (1-salience) for positives) means a single duplicate
 * doesn't push the row very far, and decay_salience() is the eventual
 * homeostat anyway.
 *
 * Cycle guard: the bus skips events with source starting 'agent:' before
 * dispatching, so this Reactor cannot trigger itself even if a future
 * version emits its own bump events.
 */

const DELTAS = {
  experience_mark_useful:  +0.10,
  experience_completed:    +0.03,
  experience_error:        -0.03,
} as const;

interface SalienceContextShape {
  experience_id?: string;
  // Future kinds: lesson_id, trait_id, intention_id — slots reserved.
}

export class SalienceReactor implements Agent {
  readonly name = "salience";
  readonly subscribedEvents = [
    "mark_useful",
    "agent_completed",
    "agent_error",
    // Memory-only events, listed so an operator scanning the bus log
    // sees them flow past this agent (and to keep the cursor advancing
    // through them in case the subscription set widens later).
    "used_in_response",
    "recalled",
    "contradiction_detected",
    "contradiction_resolved",
  ];

  private db: PostgrestClient;
  private hits = 0;
  private skips = 0;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async handle(event: BusEvent, _bus: AgentEventBus): Promise<void> {
    const ctx = (event.context ?? {}) as SalienceContextShape;
    const expId = ctx.experience_id;

    let delta: number | null = null;
    let kind: "experience" | null = null;
    let id: string | null = null;

    if (event.event_type === "mark_useful" && event.source === "mcp:mark_experience_useful" && expId) {
      delta = DELTAS.experience_mark_useful;
      kind  = "experience";
      id    = expId;
    } else if (event.event_type === "agent_completed" && expId) {
      delta = DELTAS.experience_completed;
      kind  = "experience";
      id    = expId;
    } else if (event.event_type === "agent_error" && expId) {
      delta = DELTAS.experience_error;
      kind  = "experience";
      id    = expId;
    }

    if (delta === null || kind === null || id === null) {
      this.skips++;
      return;
    }

    const { error } = await this.db.rpc("bump_salience", {
      p_kind:  kind,
      p_id:    id,
      p_delta: delta,
    });

    if (error) {
      console.error(`[salience] bump_salience(${kind}, ${id.slice(0,8)}, ${delta}) failed: ${error.message ?? String(error)}`);
      return;
    }

    this.hits++;
    if ((this.hits + this.skips) % 50 === 0) {
      console.error(`[salience] processed=${this.hits} skipped=${this.skips}`);
    }
  }
}
