/**
 * Swarm admit-lesson service — Phase 4 / issue #143 receiver-side test slice.
 *
 * Wraps the pure `admitSwarmLesson` HTTP-shaped handler from
 * `swarm/endpoints/lesson-admission.ts` with a TS-friendly orchestrator that
 * builds the side-effect bag against Supabase + `NodeIdentityService`. Two
 * surfaces share the same handler and therefore the same admission
 * semantics:
 *
 *   - HTTP host (PR #163): peer posts a v1.1 envelope to `POST /swarm/lessons`.
 *   - This MCP tool: an LLM agent or local test driver passes the envelope
 *     in-process. Useful for single-node integration testing without
 *     spinning up a second peer (#143 explicitly motivates this).
 *
 * Both wirings respect the §10.6 firebreak: every admitted row lands at
 * `lesson_tier='B'` regardless of how it arrived; promotion to A is the
 * exclusive job of `RemPromotionService` (corroboration) or
 * `swarm_pin_lesson` (operator override).
 *
 * Design boundaries — same calls the dashboard wiring (#163) deliberately
 * leaves un-wired:
 *
 *   1. `getExpectedPrevLessonHash` — receiver-side rule-19 needs a
 *      per-origin `received_lesson_chain` table that does not yet exist
 *      in the substrate. Producer-side `lesson_chain` (mig 074) does NOT
 *      cover this. Follow-up issue.
 *   2. `runContradictionGate` — the §10.3 gate runs out-of-band via
 *      `LessonContradictionRunner` (PR #148 substrate, PR #164 wiring) on
 *      the digest cycle. Wiring it inline here would require loading +
 *      iterating priors per call; the asynchronous REM self-audit (§10.5)
 *      plus the digest-side runner already cover the same ground. The
 *      `contradicts_with` field in the tool output therefore reports the
 *      empty array on success — callers learn about contradictions via
 *      the digest's experience log, not the admit response.
 *
 * Both deferrals keep this slice tight (mirror of the dashboard wiring's
 * shape) and reviewable on its own — adding the gate or rule 19 doubles
 * the surface and would block on a substrate change anyway.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  admitSwarmLesson,
  type HttpResponseShape,
  type LessonAdmissionDeps,
} from "../swarm/endpoints/lesson-admission.js";
import { NodeIdentityService } from "./node-identity.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type SwarmAdmitDecision =
  | "admitted"
  | "rejected"
  | "quarantined"
  | "self_loop"
  | "unknown_peer"
  | "internal_error";

/**
 * Typed projection of the handler's HttpResponseShape into the surface
 * issue #143 specifies. The handler returns either a 201 with a small
 * JSON envelope or a 4xx/503 with `{ error, ... }` — we collapse those
 * into one `SwarmAdmitOutcome` discriminated union the MCP layer can
 * pattern-match on without re-parsing the response body.
 */
export interface SwarmAdmitSuccess {
  decision: "admitted";
  lesson_id: string;
  lesson_tier: "B";
  /** UUIDs of priors flagged by the §10.3 gate. Always empty in this
   *  slice — the gate is wired by `LessonContradictionRunner` on the
   *  digest cycle, not inline at admission time. See module header. */
  contradicts_with: string[];
  /** §10.1 +0.05 "admitted" trust bump applied to `origin_node_id`. */
  trust_delta: number;
  origin_node_id: string;
  http_status: 201;
}

export interface SwarmAdmitFailure {
  decision: Exclude<SwarmAdmitDecision, "admitted">;
  http_status: number;
  /** §5 wire rule the validator rejected on, when the failure came from
   *  validation. Absent for pre-validation guards (self-loop, unknown
   *  peer, quarantine pre-check, body shape). */
  rule?: number;
  /** True when the rejection pulled the producer into the §10.2
   *  single-strike 1-hour quarantine (rules 5 / 16 / 19 / 20). */
  quarantined: boolean;
  error: string;
  origin_node_id?: string;
  detail?: string;
}

export type SwarmAdmitOutcome = SwarmAdmitSuccess | SwarmAdmitFailure;

/**
 * Parse the handler's HttpResponseShape into a typed outcome. Throws on
 * shape drift (missing `lesson_id` on 201, non-JSON body) so a future
 * handler edit fails loud rather than silently feeding `undefined` into
 * the memory-bus side-effect.
 */
export function parseAdmitResponse(res: HttpResponseShape): SwarmAdmitOutcome {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `swarm_admit_lesson: handler returned non-JSON body (status=${res.status}, body=${res.body.slice(0, 200)})`,
    );
  }

  if (res.status === 201) {
    const lesson_id = body.lesson_id;
    const lesson_tier = body.lesson_tier;
    const origin_node_id = body.origin_node_id;
    if (typeof lesson_id !== "string" || lesson_tier !== "B" || typeof origin_node_id !== "string") {
      throw new Error(
        `swarm_admit_lesson: 201 body missing lesson_id / lesson_tier='B' / origin_node_id (raw=${JSON.stringify(body)})`,
      );
    }
    return {
      decision: "admitted",
      lesson_id,
      lesson_tier: "B",
      // Gate is deferred (see header). The digest-cycle runner discovers
      // contradicts asynchronously and writes to swarm_lesson_contradictions.
      contradicts_with: [],
      trust_delta: 0.05,
      origin_node_id,
      http_status: 201,
    };
  }

  // Failure path. Map status + body shape onto the discriminated decision.
  const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  const origin_node_id = typeof body.origin_node_id === "string" ? body.origin_node_id : undefined;
  const rule = typeof body.rule === "number" ? body.rule : undefined;
  const quarantined = body.quarantined === true;

  let decision: Exclude<SwarmAdmitDecision, "admitted">;
  if (res.status === 403) {
    decision = "quarantined";
  } else if (res.status === 401 && /unknown peer/i.test(error)) {
    decision = "unknown_peer";
  } else if (res.status === 400 && /self-published/i.test(error)) {
    decision = "self_loop";
  } else if (res.status >= 500) {
    decision = "internal_error";
  } else {
    decision = "rejected";
  }

  return {
    decision,
    http_status: res.status,
    rule,
    quarantined,
    error,
    origin_node_id,
    detail: typeof body.detail === "string" ? body.detail : undefined,
  };
}

// ---------------------------------------------------------------------------
// Side-effect dep bag — shape mirrors LessonAdmissionDeps but we own the
// `body` and `now` fields ourselves and let callers inject only the IO.
// ---------------------------------------------------------------------------

export interface SwarmAdmitDeps {
  /** Self-row from `nodes.is_self=true`. Same shape `loadSelf` expects. */
  loadSelf: LessonAdmissionDeps["loadSelf"];
  /** Raw 32-byte Ed25519 pubkey for `node_id`, or null when unknown. */
  getPubkeyForNode: LessonAdmissionDeps["getPubkeyForNode"];
  /** Current `quarantined_until` ISO-8601, or null when not quarantined. */
  getQuarantinedUntil: LessonAdmissionDeps["getQuarantinedUntil"];
  /** Persist the validated lesson to `swarm_lessons` at lesson_tier='B'. */
  insertSwarmLesson: LessonAdmissionDeps["insertSwarmLesson"];
  /** Set `nodes.quarantined_until` (single-strike per §5/§10.2). */
  setQuarantine: LessonAdmissionDeps["setQuarantine"];
  /** Append `(node_id, delta, reason)` to the trust log (§10.1). */
  recordTrustEdgeChange: LessonAdmissionDeps["recordTrustEdgeChange"];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SwarmAdmitService {
  private db: SupabaseClient;
  private nodeIdentity: NodeIdentityService;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
    this.nodeIdentity = new NodeIdentityService(supabaseUrl, supabaseKey);
  }

  /**
   * Run the admission pipeline on a single envelope and return a typed
   * outcome. `now` defaults to wall-clock; tests inject a fixed Date so
   * quarantine windows are deterministic.
   */
  async admit(
    envelope: unknown,
    deps: SwarmAdmitDeps,
    opts: { now?: Date; ourSpecMajor?: number } = {},
  ): Promise<SwarmAdmitOutcome> {
    const res = await admitSwarmLesson({
      body: envelope,
      ourSpecMajor: opts.ourSpecMajor ?? 1,
      now: opts.now ?? new Date(),
      loadSelf: deps.loadSelf,
      getPubkeyForNode: deps.getPubkeyForNode,
      getQuarantinedUntil: deps.getQuarantinedUntil,
      insertSwarmLesson: deps.insertSwarmLesson,
      setQuarantine: deps.setQuarantine,
      recordTrustEdgeChange: deps.recordTrustEdgeChange,
      // Deferred — see module header. Both rule-19 chain tracking and the
      // §10.3 gate land in follow-up slices.
      // getExpectedPrevLessonHash: undefined,
      // runContradictionGate:      undefined,
    });
    return parseAdmitResponse(res);
  }

  /**
   * Default deps wired against this service's own SupabaseClient and
   * NodeIdentityService. Mirror of `SwarmPinService.defaultDeps`. Same
   * five callbacks the dashboard wiring (#163) constructs by hand.
   */
  defaultDeps(): SwarmAdmitDeps {
    const db = this.db;
    const nodeIdentity = this.nodeIdentity;
    return {
      loadSelf: async () => {
        const self = await nodeIdentity.getSelf();
        if (!self) return null;
        return { node_id: self.node_id, pubkey_b64: self.pubkey_b64 };
      },
      getPubkeyForNode: async (nodeId) => {
        const { data, error } = await db
          .from("nodes")
          .select("pubkey_b64url")
          .eq("node_id", nodeId)
          .maybeSingle();
        if (error) {
          throw new Error(`nodes.pubkey_b64url fetch failed: ${error.message ?? String(error)}`);
        }
        if (!data) return null;
        const b64 = (data as { pubkey_b64url: string | null }).pubkey_b64url;
        if (typeof b64 !== "string" || b64.length === 0) return null;
        return decodeB64Url(b64);
      },
      getQuarantinedUntil: async (nodeId) => {
        const { data, error } = await db
          .from("nodes")
          .select("quarantined_until")
          .eq("node_id", nodeId)
          .maybeSingle();
        if (error) {
          throw new Error(`nodes.quarantined_until fetch failed: ${error.message ?? String(error)}`);
        }
        if (!data) return null;
        return (data as { quarantined_until: string | null }).quarantined_until ?? null;
      },
      insertSwarmLesson: async (lesson) => {
        const { data, error } = await db
          .from("swarm_lessons")
          .insert({
            id:                            lesson.id,
            content:                       lesson.content,
            embedding:                     lesson.embedding,
            synthesized_from_cluster_size: lesson.synthesized_from_cluster_size,
            origin_node_id:                lesson.origin_node_id,
            signed_at:                     lesson.signed_at,
            created_at:                    lesson.created_at,
            signature:                     lesson.signature,
            tags:                          lesson.tags ?? null,
            spec_version:                  lesson.spec_version,
            // §10.6 firebreak — admitted rows land at B regardless of
            // what the producer claimed. Promotion is the exclusive job
            // of RemPromotionService / swarm_pin_lesson.
            lesson_tier:                   "B",
          })
          .select("id")
          .single();
        if (error) {
          throw new Error(`swarm_lessons insert failed: ${error.message ?? String(error)}`);
        }
        const row = data as { id: string } | null;
        return { lesson_id: row?.id ?? lesson.id };
      },
      setQuarantine: async (nodeId, untilMs, reason) => {
        // Direct UPDATE — the quarantine_origin RPC enforces p_days > 0
        // which can't represent the §10.2 1-hour single-strike window.
        // Same trade-off the dashboard wiring (#163) takes.
        const { error } = await db
          .from("nodes")
          .update({
            quarantined_until: new Date(untilMs).toISOString(),
            decay_reason:      reason,
          })
          .eq("node_id", nodeId);
        if (error) {
          throw new Error(`nodes setQuarantine failed: ${error.message ?? String(error)}`);
        }
      },
      recordTrustEdgeChange: async (nodeId, delta, reason) => {
        // The §10.1 contract is delta-based ("+0.05 admitted"); the RPC
        // sets an absolute new_weight. Read-modify-write so the audit
        // row carries the before→after pair the §10.1 semantics expect.
        // Same shape the dashboard wiring (#163) uses.
        const { data: nodeRow, error: nodeErr } = await db
          .from("nodes")
          .select("trust_weight")
          .eq("node_id", nodeId)
          .maybeSingle();
        if (nodeErr) {
          throw new Error(`nodes.trust_weight fetch failed: ${nodeErr.message ?? String(nodeErr)}`);
        }
        const before = nodeRow ? Number((nodeRow as { trust_weight: number }).trust_weight ?? 0.5) : 0.5;
        const next = Math.max(0, Math.min(1, before + delta));
        const { error: rpcErr } = await db.rpc("record_trust_edge_change", {
          p_node_id:    nodeId,
          p_new_weight: next,
          p_reason:     reason,
        });
        if (rpcErr) {
          throw new Error(`record_trust_edge_change RPC failed: ${rpcErr.message ?? String(rpcErr)}`);
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a URL-safe or standard base64 string (with or without padding)
 * into a raw byte array. Mirrors the dashboard wiring's helper so the
 * MCP path and the HTTP path agree on what counts as a valid pubkey
 * encoding.
 */
function decodeB64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? std : std + "=".repeat(4 - (std.length % 4));
  return new Uint8Array(Buffer.from(pad, "base64"));
}
