/**
 * `swarm_pin_lesson` MCP tool — first write-side slice of issue #143.
 *
 * Manual operator-side override of `swarm_lessons.lesson_tier`. Behind the
 * `OPENCLAW_ALLOW_SWARM_WRITE=1` ethics-gate (mirrors `OPENCLAW_ALLOW_BREEDING`):
 * an LLM agent cannot silently grow or pin into the swarm without an
 * explicit operator opt-in.
 *
 * Tier semantics (SWARM_SPEC.md §10.6):
 *   - "A" → broadcast-eligible (after promotion via §10.5 corroboration OR
 *           operator pin). Visible in `swarm_lessons_broadcast_eligible`.
 *   - "B" → tentative. NOT broadcast. Default for newly-ingested swarm
 *           lessons; also set by §10.3 contradiction demotions.
 *
 * Audit trail: every successful pin appends a row to `tier_promotion_log`
 * with `reason` prefixed `'operator-pinned'`. The migration-078 firebreak
 * is therefore preserved — operator overrides are visible alongside REM-
 * driven promotions in the same log.
 *
 * Memory-bus side-effect (issue #143 acceptance): on success the tool also
 * writes a `decisions`-category memory tagged `swarm` so the agent's own
 * tier-pinning decisions become recallable. This is best-effort — if the
 * embedding provider is unreachable the tool still succeeds (the audit log
 * already records the operation; the memory row is convenience, not
 * compliance).
 */

import { z } from "zod";
import { MemoryService } from "../services/supabase.js";
import { SwarmPinService, type LessonTier } from "../services/swarm-pin.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const swarmPinLessonSchema = z.object({
  lesson_id: z
    .string()
    .regex(UUID_REGEX, "lesson_id must be a UUID")
    .describe("UUID of the swarm_lessons row to pin."),
  tier: z
    .enum(["A", "B"])
    .describe(
      "Target tier. 'A' = broadcast-eligible (manual promotion). " +
        "'B' = tentative (manual demotion / firebreak).",
    ),
  reason: z
    .string()
    .max(480)
    .optional()
    .describe(
      "Optional human-readable justification appended to the audit log " +
        "after the 'operator-pinned' prefix. Capped at 480 chars to fit " +
        "the migration-078 reason CHECK (octet_length <= 512).",
    ),
});

export type SwarmPinLessonInput = z.infer<typeof swarmPinLessonSchema>;

export interface SwarmPinLessonOutput {
  ok: boolean;
  lesson_id?: string;
  from_tier?: LessonTier;
  to_tier?: LessonTier;
  reason?: string;
  memory_recorded?: boolean;
  memory_error?: string;
  error?: string;
  fix_hint?: string;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
}

function asMcpResult(payload: SwarmPinLessonOutput): McpToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/**
 * Ethics-gate check. Mirrors the OPENCLAW_ALLOW_BREEDING pattern documented
 * in vector-memory under "engram-mcp Ethik-Gate 1: Keine autonome
 * Reproduktion." For pin_lesson the surface is smaller (a single lesson's
 * broadcast eligibility) but the principle is the same: a write into the
 * §10 trust substrate requires explicit operator consent expressed via env.
 */
function isSwarmWriteAllowed(): boolean {
  return process.env.OPENCLAW_ALLOW_SWARM_WRITE === "1";
}

/**
 * Pure handler — returns the structured output. Exposed for unit tests so
 * they don't have to unwrap the MCP `content` envelope. The MCP-facing
 * adapter `swarmPinLessonHandler` wraps this in the `{ content: [...] }`
 * shape that `withErrorHandling` expects.
 */
export async function swarmPinLesson(
  pinService: SwarmPinService,
  memoryService: MemoryService,
  input: SwarmPinLessonInput,
): Promise<SwarmPinLessonOutput> {
  if (!isSwarmWriteAllowed()) {
    return {
      ok: false,
      error: "swarm_pin_lesson requires OPENCLAW_ALLOW_SWARM_WRITE=1",
      fix_hint:
        "Operator must opt in by setting OPENCLAW_ALLOW_SWARM_WRITE=1 in " +
        "the MCP server environment. Without it, no MCP tool can write to " +
        "the swarm trust substrate (§3.4 / §10.6 firebreak).",
    };
  }

  let outcome;
  try {
    outcome = await pinService.pinLesson(
      input.lesson_id,
      input.tier,
      input.reason,
      pinService.defaultDeps(),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok:    false,
      error: message,
      fix_hint:
        message.includes("not found")
          ? "Verify the lesson_id exists in swarm_lessons. Check spelling/case."
          : message.includes("already at tier")
            ? "Lesson is already at the requested tier. Pass the opposite tier or skip."
            : "Inspect the swarm_lessons / tier_promotion_log tables for the underlying DB error.",
    };
  }

  // Memory-bus side-effect — best-effort. The audit row in tier_promotion_log
  // is the durable record; the memory row is a recall convenience for the
  // agent's own future introspection ("did I pin anything in the last hour?").
  let memory_recorded = false;
  let memory_error: string | undefined;
  try {
    const direction = outcome.from_tier === "B" ? "promoted" : "demoted";
    await memoryService.create({
      content:
        `Operator pinned swarm_lesson ${outcome.lesson_id}: ` +
        `${direction} ${outcome.from_tier} → ${outcome.to_tier}. ${outcome.reason}`,
      category: "decisions",
      tags:     ["swarm", "tier-pin", `tier-${outcome.to_tier.toLowerCase()}`],
      metadata: {
        lesson_id: outcome.lesson_id,
        from_tier: outcome.from_tier,
        to_tier:   outcome.to_tier,
        source:    "swarm_pin_lesson",
      },
      source: "swarm_pin_lesson",
    });
    memory_recorded = true;
  } catch (err) {
    memory_error = err instanceof Error ? err.message : String(err);
  }

  return {
    ok:        true,
    lesson_id: outcome.lesson_id,
    from_tier: outcome.from_tier,
    to_tier:   outcome.to_tier,
    reason:    outcome.reason,
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
export async function swarmPinLessonHandler(
  pinService: SwarmPinService,
  memoryService: MemoryService,
  input: SwarmPinLessonInput,
): Promise<McpToolResult> {
  const output = await swarmPinLesson(pinService, memoryService, input);
  return asMcpResult(output);
}
