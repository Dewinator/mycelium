/**
 * Swarm resolve-contradict service — Phase 4 / issue #143 write-side slice.
 *
 * Thin wrapper around the `operator_resolve_contradict(p_pair_id UUID,
 * p_decision TEXT) RETURNS JSONB` RPC shipped in migration 086. The
 * heavy lifting — atomic UPDATE+DELETE+tier_promotion_log INSERT — lives
 * in the SQL function so the substrate is identical regardless of whether
 * the call comes from the dashboard's POST handler or this MCP tool.
 *
 * Three operator outcomes per SWARM_SPEC §10.3:
 *
 *   * 'a'    — keep lesson a, delete lesson b. The kept lesson is promoted
 *              to Tier-A (B->A audit row in tier_promotion_log) when it
 *              wasn't already there.
 *   * 'b'    — mirror of 'a'.
 *   * 'park' — mark the pair resolved with both lessons retained at their
 *              current tier. No tier_promotion_log row (no tier change).
 *
 * Service-boundary contracts:
 *
 *   1. Decision validation happens BEFORE the RPC dispatch. The RPC
 *      itself raises on unknown decisions, but a Postgres exception
 *      surfaces less cleanly than an early structured throw — and we
 *      can give the MCP caller a precise error message ("must be a/b/park")
 *      rather than the postgrest-flavored RAISE EXCEPTION text.
 *
 *   2. Already-resolved pairs surface as an explicit error string, not a
 *      generic RPC failure. The RPC's RAISE EXCEPTION carries the
 *      timestamp; we forward it verbatim so the operator can see when
 *      the pair was first resolved without an extra SELECT.
 *
 *   3. Outcome shape is normalized into `ResolveContradictOutcome` —
 *      a discriminated union over the three decisions. The RPC returns
 *      slightly different JSONB keys per branch (kept_id/dropped_id only
 *      on a/b, no promotion flag on park); the discriminated union
 *      makes the ts callers handle each branch explicitly rather than
 *      dropping into `any`.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type ResolveContradictDecision = "a" | "b" | "park";

export interface ResolveContradictBaseOutcome {
  pair_id: string;
  decision: ResolveContradictDecision;
  resolved_at: string;
}

export interface ResolveContradictKeepOutcome
  extends ResolveContradictBaseOutcome {
  decision: "a" | "b";
  kept_id: string;
  dropped_id: string;
  promoted_to_a: boolean;
}

export interface ResolveContradictParkOutcome
  extends ResolveContradictBaseOutcome {
  decision: "park";
  a_id: string;
  b_id: string;
}

export type ResolveContradictOutcome =
  | ResolveContradictKeepOutcome
  | ResolveContradictParkOutcome;

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase. Mirror of
 * `SwarmPinDeps` from swarm-pin.ts.
 */
export interface SwarmResolveContradictDeps {
  /**
   * Invoke the migration-086 `operator_resolve_contradict(UUID, TEXT)`
   * RPC and return the parsed JSONB body. Throws on RPC failure with
   * the original postgrest message preserved so callers can distinguish
   * "unknown pair" / "already resolved" / "decision rejected".
   */
  callOperatorResolveContradict(
    pairId: string,
    decision: ResolveContradictDecision,
  ): Promise<unknown>;
}

const ALLOWED_DECISIONS: ReadonlySet<ResolveContradictDecision> = new Set([
  "a",
  "b",
  "park",
]);

/**
 * Validate that `decision` is one of the three §10.3 outcomes. Surfaced
 * as an explicit guard so the MCP tool's structured-error response can
 * say "decision must be a/b/park" rather than letting Postgres' RAISE
 * EXCEPTION text leak through.
 */
export function isValidDecision(
  decision: string,
): decision is ResolveContradictDecision {
  return ALLOWED_DECISIONS.has(decision as ResolveContradictDecision);
}

/**
 * Map a JSONB row from `operator_resolve_contradict` into the typed
 * outcome union. Postgres' jsonb_build_object preserves key names but
 * not types — every value lands on `unknown` and we narrow here. Throws
 * if the RPC returned a shape that doesn't match either branch (a bug
 * in the migration would surface as a hard error rather than a silent
 * mis-cast).
 */
export function parseResolveOutcome(raw: unknown): ResolveContradictOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `operator_resolve_contradict: expected JSONB object, got ${
        Array.isArray(raw) ? "array" : typeof raw
      }`,
    );
  }
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    throw new Error(
      `operator_resolve_contradict: ok=false in response (raw=${JSON.stringify(
        raw,
      )})`,
    );
  }
  const decision = r.decision;
  if (decision !== "a" && decision !== "b" && decision !== "park") {
    throw new Error(
      `operator_resolve_contradict: decision must be a/b/park, got ${String(
        decision,
      )}`,
    );
  }
  const pair_id = r.pair_id;
  const resolved_at = r.resolved_at;
  if (typeof pair_id !== "string" || typeof resolved_at !== "string") {
    throw new Error(
      `operator_resolve_contradict: missing pair_id or resolved_at (raw=${JSON.stringify(
        raw,
      )})`,
    );
  }
  if (decision === "park") {
    const a_id = r.a_id;
    const b_id = r.b_id;
    if (typeof a_id !== "string" || typeof b_id !== "string") {
      throw new Error(
        `operator_resolve_contradict park: missing a_id/b_id (raw=${JSON.stringify(
          raw,
        )})`,
      );
    }
    return { pair_id, decision: "park", resolved_at, a_id, b_id };
  }
  const kept_id = r.kept_id;
  const dropped_id = r.dropped_id;
  if (typeof kept_id !== "string" || typeof dropped_id !== "string") {
    throw new Error(
      `operator_resolve_contradict ${decision}: missing kept_id/dropped_id (raw=${JSON.stringify(
        raw,
      )})`,
    );
  }
  return {
    pair_id,
    decision,
    resolved_at,
    kept_id,
    dropped_id,
    promoted_to_a: r.promoted_to_a === true,
  };
}

export class SwarmResolveContradictService {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Resolve a contradict pair. Validates the decision before dispatch
   * (so an MCP caller passing 'maybe' gets a clean structured error
   * instead of a postgrest exception body). Throws on:
   *   - decision not in {a, b, park}
   *   - unknown pair_id
   *   - pair already resolved (RPC raises with timestamp)
   *   - RPC error (postgrest message preserved)
   */
  async resolveContradict(
    pairId: string,
    decision: ResolveContradictDecision,
    deps: SwarmResolveContradictDeps,
  ): Promise<ResolveContradictOutcome> {
    if (!isValidDecision(decision)) {
      throw new Error(
        `swarm_resolve_contradict: decision must be a/b/park, got ${String(
          decision,
        )}`,
      );
    }
    const raw = await deps.callOperatorResolveContradict(pairId, decision);
    return parseResolveOutcome(raw);
  }

  /**
   * Default deps wired against the service's own SupabaseClient. Same
   * pattern as SwarmPinService.defaultDeps.
   */
  defaultDeps(): SwarmResolveContradictDeps {
    const db = this.db;
    return {
      async callOperatorResolveContradict(pairId, decision) {
        const { data, error } = await db.rpc(
          "operator_resolve_contradict",
          { p_pair_id: pairId, p_decision: decision },
        );
        if (error) {
          throw new Error(
            `operator_resolve_contradict RPC failed: ${
              error.message ?? String(error)
            }`,
          );
        }
        return data;
      },
    };
  }
}
