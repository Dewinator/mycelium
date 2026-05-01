/**
 * Swarm peers read-service — issue #143 (swarm_list_peers slice).
 *
 * Read-only window onto the §10 trust state per peer. Wraps three rows
 * the operator already has in the schwarm-tab dashboard, but exposed
 * through MCP so an LLM agent can introspect the swarm without going
 * through the dashboard.
 *
 * Wire-shape choice: trust columns live flat on `nodes` (migrations 070,
 * 071, 075). SWARM_SPEC §3.4 forbids exposing the trust list across the
 * wire — but this is the local MCP boundary, not /swarm/* — so quoting
 * trust_weight back to the local agent is allowed and explicitly
 * intended by issue #143.
 */
import { PostgrestClient } from "@supabase/postgrest-js";

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export interface PeerSummary {
  node_id: string;
  display_name: string | null;
  is_self: boolean;
  trust_weight: number;
  is_quarantined: boolean;
  quarantined_until: string | null;
  last_seen_at: string | null;
  last_decay_at: string | null;
  decay_reason: string | null;
  consecutive_rejections: number;
  last_trust_delta: {
    weight_before: number;
    weight_after: number;
    reason: string;
    at: string;
  } | null;
  recent_admissions_24h: number;
}

interface NodesRow {
  node_id: string;
  display_name: string | null;
  is_self: boolean | null;
  trust_weight: number;
  quarantined_until: string | null;
  last_seen_at: string | null;
  last_decay_at: string | null;
  decay_reason: string | null;
  consecutive_rejections: number;
}

interface TrustEdgeRow {
  node_id: string;
  weight_before: number;
  weight_after: number;
  reason: string;
  at: string;
}

interface SwarmLessonsCountRow {
  origin_node_id: string;
  received_at: string;
}

/**
 * Minimal PostgREST surface this service needs. Lets tests inject a fake
 * without booting Supabase.
 */
export interface SwarmPeersClient {
  listPeers(includeSelf: boolean): Promise<PeerSummary[]>;
}

export class SwarmPeersService implements SwarmPeersClient {
  private readonly db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async listPeers(includeSelf: boolean): Promise<PeerSummary[]> {
    let q = this.db
      .from("nodes")
      .select(
        "node_id, display_name, is_self, trust_weight, quarantined_until, last_seen_at, last_decay_at, decay_reason, consecutive_rejections"
      );
    if (!includeSelf) {
      // PostgREST: `is_self IS NOT TRUE` covers both FALSE and NULL rows.
      q = q.not("is_self", "is", true);
    }
    const { data, error } = await q.order("node_id", { ascending: true });
    if (error) throw new Error(`listPeers nodes: ${fmtErr(error)}`);
    const nodes = (data ?? []) as NodesRow[];
    if (nodes.length === 0) return [];

    const ids = nodes.map((n) => n.node_id);

    // Latest trust_edge_log row per peer. PostgREST has no native
    // window-function endpoint, so we pull the most recent N rows
    // ordered by `at DESC` and take the first hit per node_id locally.
    // Cap N at nodes.length × 5 so heavy-churn peers don't starve quiet
    // ones — five recent rows per peer is plenty to find "the latest".
    const { data: edgeData, error: edgeErr } = await this.db
      .from("trust_edge_log")
      .select("node_id, weight_before, weight_after, reason, at")
      .in("node_id", ids)
      .order("at", { ascending: false })
      .limit(Math.max(50, ids.length * 5));
    if (edgeErr) throw new Error(`listPeers trust_edge_log: ${fmtErr(edgeErr)}`);
    const latestDelta = new Map<string, TrustEdgeRow>();
    for (const row of (edgeData ?? []) as TrustEdgeRow[]) {
      if (!latestDelta.has(row.node_id)) latestDelta.set(row.node_id, row);
    }

    // Recent admissions — swarm_lessons rows received in the last 24h
    // grouped by origin_node_id. PostgREST has no GROUP BY surface, so
    // we pull the rows and tally locally. The 24h window keeps the
    // payload bounded for normal traffic; pathological floods would
    // need a server-side aggregate (deferred).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: admissionData, error: admissionErr } = await this.db
      .from("swarm_lessons")
      .select("origin_node_id, received_at")
      .in("origin_node_id", ids)
      .gte("received_at", since);
    if (admissionErr) {
      throw new Error(`listPeers swarm_lessons: ${fmtErr(admissionErr)}`);
    }
    const admissionCount = new Map<string, number>();
    for (const row of (admissionData ?? []) as SwarmLessonsCountRow[]) {
      admissionCount.set(
        row.origin_node_id,
        (admissionCount.get(row.origin_node_id) ?? 0) + 1
      );
    }

    const now = Date.now();
    return nodes.map((n) => {
      const quarantinedUntilMs = n.quarantined_until
        ? Date.parse(n.quarantined_until)
        : null;
      return {
        node_id: n.node_id,
        display_name: n.display_name,
        is_self: n.is_self === true,
        trust_weight: n.trust_weight,
        is_quarantined:
          quarantinedUntilMs !== null && quarantinedUntilMs > now,
        quarantined_until: n.quarantined_until,
        last_seen_at: n.last_seen_at,
        last_decay_at: n.last_decay_at,
        decay_reason: n.decay_reason,
        consecutive_rejections: n.consecutive_rejections,
        last_trust_delta: latestDelta.get(n.node_id) ?? null,
        recent_admissions_24h: admissionCount.get(n.node_id) ?? 0,
      };
    });
  }
}
