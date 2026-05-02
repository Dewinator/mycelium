/**
 * `swarm_admit_lesson` MCP tool — fifth and final write-side slice of
 * issue #143.
 *
 * Receiver-side test entrypoint: takes a v1.1 Lesson envelope (full body,
 * not just the id) and runs it through the same admission pipeline the
 * `POST /swarm/lessons` HTTP endpoint uses (PR #154 substrate, PR #163
 * wiring). Useful for local single-node integration testing without
 * spinning up a second peer — the intent #143 explicitly calls out.
 *
 * Behind `OPENCLAW_ALLOW_SWARM_WRITE=1` (mirrors `swarm_pin_lesson` and
 * `swarm_resolve_contradict`): admission INSERTs a `swarm_lessons` row
 * and bumps trust + (potentially) quarantines a peer. None of those
 * writes should happen without explicit operator opt-in.
 *
 * Memory-bus side-effect on a successful 201: a `decisions`-category
 * memory tagged `swarm` so the agent's own admit decisions become
 * recallable. Best-effort — the durable record is the swarm_lessons row
 * + the trust_edge_log audit; the memory row is a recall convenience for
 * the agent's own future introspection ("did I admit anything from peer
 * X in the last hour?").
 */

import { z } from "zod";
import { MemoryService } from "../services/supabase.js";
import {
  SwarmAdmitService,
  type SwarmAdmitOutcome,
  type SwarmAdmitSuccess,
} from "../services/swarm-admit.js";

export const swarmAdmitLessonSchema = z.object({
  envelope: z
    .record(z.unknown())
    .describe(
      "Full v1.1 Lesson envelope as a JSON object — id, content, embedding, " +
        "synthesized_from_cluster_size, origin_node_id, signed_at, created_at, " +
        "signature, spec_version, evidence_root, evidence_count, " +
        "prev_lesson_hash, maturity_age_days, useful_count, optional tags. " +
        "The wire-validator (§5 rules 1-13/16/19/20) re-checks every field; " +
        "no client-side trust is granted to the shape.",
    ),
});

export type SwarmAdmitLessonInput = z.infer<typeof swarmAdmitLessonSchema>;

export interface SwarmAdmitLessonOutput {
  ok: boolean;
  /** Stable machine-readable decision tag, present on every response. */
  decision?: SwarmAdmitOutcome["decision"];
  http_status?: number;
  /** Populated on `decision='admitted'`. */
  lesson_id?: string;
  lesson_tier?: "B";
  contradicts_with?: string[];
  trust_delta?: number;
  origin_node_id?: string;
  /** §5 wire rule the validator rejected on, when applicable. */
  rule?: number;
  /** True when the rejection pulled the producer into quarantine. */
  quarantined?: boolean;
  memory_recorded?: boolean;
  memory_error?: string;
  error?: string;
  fix_hint?: string;
  detail?: string;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
}

function asMcpResult(payload: SwarmAdmitLessonOutput): McpToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Ethics-gate check. Mirrors `swarm_pin_lesson` and
 * `swarm_resolve_contradict`. Admission INSERTs a swarm_lessons row,
 * bumps trust on the origin, and may quarantine a peer for an hour —
 * all writes the §3.4 / §10.6 firebreak requires explicit operator
 * consent for.
 */
function isSwarmWriteAllowed(): boolean {
  return process.env.OPENCLAW_ALLOW_SWARM_WRITE === "1";
}

/**
 * Map a non-201 outcome's decision tag onto an operator-actionable hint.
 * The §5 rule numbers in the body let an LLM caller correlate with
 * `docs/SWARM_SPEC.md` if it has the spec in context.
 */
function fixHintFor(out: Exclude<SwarmAdmitOutcome, SwarmAdmitSuccess>): string {
  switch (out.decision) {
    case "self_loop":
      return "The envelope's origin_node_id matches this node's own node_id. " +
        "Self-published lessons go through the producer path (swarm_publish_tier_a_lesson), " +
        "never the admission endpoint.";
    case "unknown_peer":
      return "No pubkey is held for the envelope's origin_node_id. " +
        "Register the peer first (insert into nodes with pubkey_b64url) before admission.";
    case "quarantined":
      return "The origin is currently quarantined — admission will resume after the " +
        "quarantine window expires. Quarantine state is per-peer in nodes.quarantined_until.";
    case "internal_error":
      return "A dependency (DB, signature lookup) threw. Inspect the dashboard logs " +
        "or the response detail field for the underlying cause.";
    case "rejected":
      if (out.rule === 5 || out.rule === 19) {
        return `Wire rule ${out.rule} failed — signature or chain mismatch. ` +
          "The producer has been quarantined for one hour (§10.2 single-strike). " +
          "Re-sign the envelope with the matching key, or wait for quarantine to lift.";
      }
      if (out.rule === 16 || out.rule === 20) {
        return `Wire rule ${out.rule} failed — proof-of-knowledge shape rejected. ` +
          "Quarantined for one hour (§10.2 single-strike). Verify evidence_root and " +
          "evidence_count against the producer's lesson_evidence_origin table.";
      }
      if (typeof out.rule === "number") {
        return `Wire rule ${out.rule} failed — see docs/SWARM_SPEC.md §5 for the rule body. ` +
          "No quarantine for non-single-strike rules; fix the envelope and retry.";
      }
      return "Pre-validation guard rejected the envelope. Inspect the error string for " +
        "the specific cause (body shape, missing origin_node_id, malformed UUID).";
  }
}

function describeAdmitOutcome(out: SwarmAdmitSuccess): string {
  return (
    `Admitted swarm lesson ${out.lesson_id} from peer ${out.origin_node_id} at tier B ` +
    `(§10.6 firebreak). Trust +${out.trust_delta.toFixed(2)} applied via §10.1.`
  );
}

/**
 * Pure handler — exposed for unit tests so they don't have to unwrap the
 * MCP `content` envelope. Same split as `swarm_pin_lesson` and
 * `swarm_resolve_contradict`.
 */
export async function swarmAdmitLesson(
  service: SwarmAdmitService,
  memoryService: MemoryService,
  input: SwarmAdmitLessonInput,
): Promise<SwarmAdmitLessonOutput> {
  if (!isSwarmWriteAllowed()) {
    return {
      ok: false,
      error: "swarm_admit_lesson requires OPENCLAW_ALLOW_SWARM_WRITE=1",
      fix_hint:
        "Operator must opt in by setting OPENCLAW_ALLOW_SWARM_WRITE=1 in " +
        "the MCP server environment. Without it, no MCP tool can write to " +
        "the swarm trust substrate (§3.4 / §10.6 firebreak).",
    };
  }

  let outcome: SwarmAdmitOutcome;
  try {
    outcome = await service.admit(input.envelope, service.defaultDeps());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      fix_hint:
        "Service-layer throw before the handler returned. " +
        "Likely a Supabase outage or a self-row that hasn't been bootstrapped — " +
        "run scripts/init-node-identity.mjs and check docker compose status.",
    };
  }

  if (outcome.decision !== "admitted") {
    return {
      ok: false,
      decision: outcome.decision,
      http_status: outcome.http_status,
      rule: outcome.rule,
      quarantined: outcome.quarantined,
      origin_node_id: outcome.origin_node_id,
      error: outcome.error,
      detail: outcome.detail,
      fix_hint: fixHintFor(outcome),
    };
  }

  // Best-effort memory side-effect — see module header.
  let memory_recorded = false;
  let memory_error: string | undefined;
  try {
    await memoryService.create({
      content: describeAdmitOutcome(outcome),
      category: "decisions",
      tags: ["swarm", "lesson-admitted", `origin-${outcome.origin_node_id.slice(0, 12)}`],
      metadata: {
        lesson_id:      outcome.lesson_id,
        origin_node_id: outcome.origin_node_id,
        lesson_tier:    outcome.lesson_tier,
        trust_delta:    outcome.trust_delta,
        source:         "swarm_admit_lesson",
      },
      source: "swarm_admit_lesson",
    });
    memory_recorded = true;
  } catch (err) {
    memory_error = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: true,
    decision: "admitted",
    http_status: 201,
    lesson_id: outcome.lesson_id,
    lesson_tier: outcome.lesson_tier,
    contradicts_with: outcome.contradicts_with,
    trust_delta: outcome.trust_delta,
    origin_node_id: outcome.origin_node_id,
    memory_recorded,
    ...(memory_error ? { memory_error } : {}),
  };
}

/**
 * MCP-facing adapter — wraps the pure handler's result in the
 * `{ content: [{ type, text }] }` envelope that `withErrorHandling`
 * expects. Same convention as `swarmPinLessonHandler` and
 * `swarmResolveContradictHandler`.
 */
export async function swarmAdmitLessonHandler(
  service: SwarmAdmitService,
  memoryService: MemoryService,
  input: SwarmAdmitLessonInput,
): Promise<McpToolResult> {
  const output = await swarmAdmitLesson(service, memoryService, input);
  return asMcpResult(output);
}
