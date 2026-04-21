import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Agent Event-Bus (engram-inspired, Migration 047)
 * ================================================
 *
 * Polls `memory_events` every N seconds and dispatches events to
 * subscribed agents. Each agent has a cursor (created_at, id) so we
 * never miss or double-count across ticks. At-least-once delivery —
 * handlers MUST be idempotent.
 *
 * This is the lightweight analogue of engram's 10-agent system. Only
 * one concrete agent is wired up initially (CoactivationAgent) but the
 * pattern scales to more. Heavy-lift agents (Conscience / Consolidator /
 * Synthesizer) that need a local LLM call should dispatch to the
 * OpenClaw Gateway (http://127.0.0.1:18789) rather than running a second
 * Ollama instance alongside the embedding provider.
 *
 * Cycle detection: events with source starting 'agent:' are skipped so
 * an agent can't trigger itself (or a cascade).
 */

export interface BusEvent {
  id:         string;
  memory_id:  string | null;
  event_type: string;
  source:     string;
  context:    Record<string, unknown>;
  trace_id:   string | null;
  created_at: string;
}

export interface Agent {
  /** Short name, used for cursor persistence and source-tag. */
  name: string;
  /** Event types this agent cares about. Empty array = all. */
  subscribedEvents: string[];
  /** Handle a single event. Must be idempotent (at-least-once delivery). */
  handle(event: BusEvent, bus: AgentEventBus): Promise<void>;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string };
  return e.message ?? JSON.stringify(err);
}

interface Cursor {
  created_at: string;
  id:         string;
}

export class AgentEventBus {
  private db: PostgrestClient;
  private agents: Agent[] = [];
  private cursors = new Map<string, Cursor>();
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs: number;
  private readonly batchSize: number;
  private readonly coldStartLookbackMs: number;
  private busy = false;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    opts: { tickMs?: number; batchSize?: number; coldStartLookbackMs?: number } = {}
  ) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.tickMs              = opts.tickMs              ?? 5000;
    this.batchSize           = opts.batchSize           ?? 100;
    this.coldStartLookbackMs = opts.coldStartLookbackMs ?? 10 * 60 * 1000;
  }

  register(agent: Agent): void {
    this.agents.push(agent);
  }

  start(): void {
    if (this.timer) return;
    // Cold-start cursor: N minutes ago
    const start = new Date(Date.now() - this.coldStartLookbackMs).toISOString();
    const initialCursor: Cursor = { created_at: start, id: "00000000-0000-0000-0000-000000000000" };
    for (const a of this.agents) {
      if (!this.cursors.has(a.name)) this.cursors.set(a.name, initialCursor);
    }
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    console.error(`[event-bus] started (tick=${this.tickMs}ms, agents=${this.agents.length})`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.error("[event-bus] stopped");
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;          // skip if prior tick still draining
    this.busy = true;
    try {
      for (const agent of this.agents) {
        await this.drainForAgent(agent);
      }
    } catch (err) {
      console.error("[event-bus] tick error:", fmtErr(err));
    } finally {
      this.busy = false;
    }
  }

  private async drainForAgent(agent: Agent): Promise<void> {
    const cursor = this.cursors.get(agent.name);
    if (!cursor) return;

    const types = agent.subscribedEvents.length > 0 ? agent.subscribedEvents : null;

    const { data, error } = await this.db.rpc("memory_events_since", {
      p_after_created_at: cursor.created_at,
      p_after_id:         cursor.id,
      p_event_types:      types,
      p_limit:            this.batchSize,
    });

    if (error) {
      console.error(`[event-bus] ${agent.name}: fetch error: ${fmtErr(error)}`);
      return;
    }

    const events = (data ?? []) as BusEvent[];
    if (events.length === 0) return;

    for (const ev of events) {
      // cycle guard — skip events that this very agent (or any agent) emitted
      if (ev.source.startsWith("agent:")) {
        // advance cursor past it but don't invoke handler
      } else {
        try {
          await agent.handle(ev, this);
        } catch (err) {
          console.error(`[event-bus] ${agent.name} handler error on event ${ev.id}: ${fmtErr(err)}`);
          // continue — at-least-once means next tick could retry if cursor
          // weren't advanced. we DO advance here to avoid poison-pill loops.
        }
      }
      this.cursors.set(agent.name, { created_at: ev.created_at, id: ev.id });
    }
  }

  /** Agents call this to log their own actions back into the stream. */
  async emit(
    memoryId: string | null,
    eventType: string,
    agentName: string,
    context: Record<string, unknown> = {},
    traceId: string | null = null,
  ): Promise<void> {
    const { error } = await this.db.rpc("log_memory_event", {
      p_memory_id:  memoryId,
      p_event_type: eventType,
      p_source:     `agent:${agentName}`,
      p_context:    context,
      p_trace_id:   traceId,
      p_created_by: null,
    });
    if (error) {
      console.error(`[event-bus] emit failed: ${fmtErr(error)}`);
    }
  }
}
