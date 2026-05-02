/**
 * `swarm_publish_tier_a_lesson` MCP tool — issue #143 write-side slice.
 *
 * Forces a locally-generated lesson into the broadcast-eligible Tier-A
 * state by signing it with the node's self-key, computing the §3.7.2
 * chain hash, and dispatching to the migration-087 RPC for the atomic
 * apply (lesson_chain INSERT + swarm_lessons INSERT + tier_promotion_log
 * audit row + UPDATE-to-A in one txn).
 *
 * Behind `OPENCLAW_ALLOW_SWARM_WRITE=1` (mirrors `swarm_pin_lesson` and
 * `swarm_resolve_contradict`): the tool writes to the §10.6 trust
 * substrate AND emits a signed envelope onto the wire — both are
 * surfaces that need explicit operator opt-in (Verfassung pillar 6:
 * cyber security; pillar 1: sovereignty).
 *
 * Memory-bus side-effect on success: the agent writes a
 * `decisions`-category memory tagged `swarm` so its own publish actions
 * become recallable. Best-effort — the durable record is the
 * tier_promotion_log row plus the lesson_chain entry.
 */

import { z } from "zod";
import { MemoryService } from "../services/supabase.js";
import {
  SwarmPublishService,
  type PublishTierAOutcome,
} from "../services/swarm-publish.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const swarmPublishTierAlessonSchema = z.object({
  lesson_id: z
    .string()
    .regex(UUID_REGEX, "lesson_id must be a UUID")
    .describe("UUID of the LOCAL `lessons` row to publish."),
  spec_version: z
    .string()
    .max(16)
    .optional()
    .describe(
      "Optional spec version stamped on the wire. Defaults to '1.1' (the current Proof-of-Knowledge envelope).",
    ),
  note: z
    .string()
    .max(480)
    .optional()
    .describe(
      "Optional human-readable note appended to the audit reason after the 'tool-publish:' prefix. Capped at 480 chars to fit the migration-078 reason CHECK (octet_length <= 512).",
    ),
});

export type SwarmPublishTierAlessonInput = z.infer<
  typeof swarmPublishTierAlessonSchema
>;

export interface SwarmPublishTierAlessonOutput {
  ok: boolean;
  status?: PublishTierAOutcome["status"];
  lesson_id?: string;
  origin_node_id?: string;
  lesson_tier?: "A";
  sequence_number?: number;
  lesson_hash?: string;
  audit_reason?: string;
  signed_at?: string;
  received_at?: string;
  chain_present?: boolean;
  memory_recorded?: boolean;
  memory_error?: string;
  error?: string;
  fix_hint?: string;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
}

function asMcpResult(payload: SwarmPublishTierAlessonOutput): McpToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Ethics-gate check. Mirrors the `OPENCLAW_ALLOW_BREEDING` /
 * `OPENCLAW_ALLOW_SWARM_WRITE` pattern. Publishing onto the swarm IS
 * the most consequential surface this tool family exposes (the lesson
 * leaves the local node for any peer that polls /swarm/lessons), so a
 * conservative explicit-opt-in default is the right policy.
 */
function isSwarmWriteAllowed(): boolean {
  return process.env.OPENCLAW_ALLOW_SWARM_WRITE === "1";
}

/**
 * Map an RPC / service error message onto a hint the operator can act
 * on. The keyword set covers the named raise prefixes from migration
 * 087 plus the validation messages from `assertLocalLessonPublishable`.
 */
function fixHintFromError(message: string): string {
  if (message.includes("local lesson") && message.includes("not found")) {
    return "Verify the lesson_id exists in the local `lessons` table. The publish tool takes a LOCAL lesson id, not a swarm_lessons id.";
  }
  if (message.includes("evidence_count must be >= 2")) {
    return "The §3.1 cluster floor refuses single-experience lessons on the wire. Wait until the lesson accumulates more evidence (or merge it via dedup_lessons).";
  }
  if (message.includes("content exceeds")) {
    return "Trim the local lesson content (octet_length <= 8192). The §5 rule 12 cap is firm.";
  }
  if (message.includes("embedding must be a 768-dim")) {
    return "The local lesson has no embedding or the embedding is the wrong dimension. Re-embed the lesson via the embedding pipeline first.";
  }
  if (message.includes("identity not bootstrapped") || message.includes("no is_self row")) {
    return "Run `node scripts/init-node-identity.mjs` to generate the keypair and insert the self row in `nodes` before publishing.";
  }
  if (message.includes("origin") && message.includes("does not match local self")) {
    return "Internal mismatch: the service derived a self_node_id that the database trigger rejected. Inspect `nodes WHERE is_self=true` for stale rows.";
  }
  if (message.includes("already exists at tier B")) {
    return "A non-self swarm_lessons row already occupies this id. Inspect with `swarm_list_peers` and either resolve via `swarm_resolve_contradict` or pin manually with `swarm_pin_lesson`.";
  }
  if (message.includes("sequence_number race")) {
    return "Concurrent publishers exhausted the retry budget. Retry the tool — the chain tip will have advanced.";
  }
  if (message.includes("biconditional violated")) {
    return "Chain tip read returned an inconsistent state (sequence vs prev_hash). Inspect `lesson_chain` for corruption — this should not happen under normal operation.";
  }
  if (message.includes("no embedding")) {
    return "The local lesson row is missing an embedding. Re-embed via the embedding pipeline first.";
  }
  return "Inspect server logs for the underlying error and the migration-087 / 078 / 074 contracts before retrying.";
}

/**
 * Pure handler — returns the structured output. Exposed for unit tests
 * so they don't have to unwrap the MCP `content` envelope. The
 * MCP-facing adapter wraps this in the `{ content: [...] }` shape that
 * `withErrorHandling` expects.
 */
export async function swarmPublishTierAlesson(
  publishService: SwarmPublishService,
  memoryService: MemoryService,
  input: SwarmPublishTierAlessonInput,
): Promise<SwarmPublishTierAlessonOutput> {
  if (!isSwarmWriteAllowed()) {
    return {
      ok: false,
      error: "swarm_publish_tier_a_lesson requires OPENCLAW_ALLOW_SWARM_WRITE=1",
      fix_hint:
        "Operator must opt in by setting OPENCLAW_ALLOW_SWARM_WRITE=1 in " +
        "the MCP server environment. Without it, no MCP tool can write to " +
        "the swarm trust substrate (§3.4 / §10.6 firebreak) or publish " +
        "lessons onto the wire.",
    };
  }

  let outcome: PublishTierAOutcome;
  try {
    outcome = await publishService.publishTierA(
      input.lesson_id,
      { spec_version: input.spec_version, note: input.note },
      publishService.defaultDeps(),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok:    false,
      error: message,
      fix_hint: fixHintFromError(message),
    };
  }

  // Memory-bus side-effect — best-effort. The audit row in
  // tier_promotion_log + the lesson_chain entry are the durable record;
  // this memory row is a recall convenience for the agent's own future
  // introspection ("did I publish anything in the last hour?").
  let memory_recorded = false;
  let memory_error: string | undefined;
  try {
    const noun =
      outcome.status === "published"
        ? `Published swarm_lesson ${outcome.lesson_id} at Tier-A (seq ${outcome.sequence_number}, hash ${outcome.lesson_hash}). ${outcome.audit_reason}`
        : `Re-publish no-op: lesson ${outcome.lesson_id} already at Tier-A (chain_present=${outcome.chain_present}).`;
    await memoryService.create({
      content:  noun,
      category: "decisions",
      tags:     ["swarm", "publish", "tier-a"],
      metadata: {
        lesson_id: outcome.lesson_id,
        status:    outcome.status,
        source:    "swarm_publish_tier_a_lesson",
        ...(outcome.status === "published"
          ? {
              sequence_number: outcome.sequence_number,
              lesson_hash:     outcome.lesson_hash,
            }
          : {}),
      },
      source: "swarm_publish_tier_a_lesson",
    });
    memory_recorded = true;
  } catch (err) {
    memory_error = err instanceof Error ? err.message : String(err);
  }

  if (outcome.status === "published") {
    return {
      ok:              true,
      status:          "published",
      lesson_id:       outcome.lesson_id,
      origin_node_id:  outcome.origin_node_id,
      lesson_tier:     "A",
      sequence_number: outcome.sequence_number,
      lesson_hash:     outcome.lesson_hash,
      audit_reason:    outcome.audit_reason,
      signed_at:       outcome.signed_at,
      received_at:     outcome.received_at,
      memory_recorded,
      ...(memory_error ? { memory_error } : {}),
    };
  }
  return {
    ok:            true,
    status:        "already_published",
    lesson_id:     outcome.lesson_id,
    lesson_tier:   "A",
    chain_present: outcome.chain_present,
    memory_recorded,
    ...(memory_error ? { memory_error } : {}),
  };
}

/**
 * MCP-facing adapter — wraps the pure handler's result in the
 * `{ content: [{ type, text }] }` envelope that `withErrorHandling`
 * expects. Returning structured JSON-as-text matches the convention used
 * by recall.ts and the rest of the tool surface.
 */
export async function swarmPublishTierAlessonHandler(
  publishService: SwarmPublishService,
  memoryService: MemoryService,
  input: SwarmPublishTierAlessonInput,
): Promise<McpToolResult> {
  const output = await swarmPublishTierAlesson(
    publishService,
    memoryService,
    input,
  );
  return asMcpResult(output);
}
