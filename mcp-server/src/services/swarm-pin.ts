/**
 * Swarm pin-lesson service — Swarm Phase 4 / issue #143 write-side slice.
 *
 * Manual operator-side override of `swarm_lessons.lesson_tier`. Mirrors the
 * §10.6 promotion path implemented by `RemPromotionService` (sub-phase 4i.2),
 * but without the corroborating-cluster gate: an operator who calls this
 * tool is asserting "I have decided this lesson belongs at tier X" and the
 * audit row in `tier_promotion_log` records that intent.
 *
 * Two design points worth holding in one frame with rem-promotion.ts:
 *
 *   1. **Audit-first ordering.** `tier_promotion_log` INSERT happens BEFORE
 *      the `swarm_lessons.lesson_tier` UPDATE. If the UPDATE fails, the
 *      audit row still records the operator's *intent*. Losing the audit
 *      row is worse than a stuck tier — the §10.6 traceability contract
 *      depends on every transition being on the log, even failed ones.
 *
 *   2. **No-op rejection at the service boundary.** If `current_tier` is
 *      already `to_tier`, the service throws before touching the DB. The
 *      migration-078 `(from_tier <> to_tier)` CHECK on `tier_promotion_log`
 *      would reject a no-op INSERT anyway, but throwing earlier produces a
 *      cleaner error for the MCP caller and avoids polluting the audit log
 *      with would-be-failures.
 *
 * The reason text format is fixed to start with `'operator-pinned'` so
 * downstream review tooling (dashboard, REM audit) can distinguish operator
 * overrides from §10.6 evidence-driven promotions ('§10.6 corroborated…')
 * and §10.5 falsifications. An optional caller-supplied note is appended
 * after a `:` separator.
 */

import type { DbClient } from "./db-client.js";

export type LessonTier = "A" | "B";

export interface PinLessonOutcome {
  lesson_id: string;
  from_tier: LessonTier;
  to_tier: LessonTier;
  reason: string;
}

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase. Same pattern as
 * `RemPromotionDeps`.
 */
export interface SwarmPinDeps {
  /** SELECT lesson_tier FROM swarm_lessons WHERE id = lessonId. Returns
   * null when the row does not exist (caller maps to a "not found" error). */
  fetchCurrentTier(lessonId: string): Promise<LessonTier | null>;
  /** INSERT INTO tier_promotion_log — append-only per migration 078.
   * evidence_ids is empty for operator-pinned transitions; the *reason*
   * is the human-supplied justification. */
  recordTierTransition(
    lessonId: string,
    fromTier: LessonTier,
    toTier: LessonTier,
    reason: string,
  ): Promise<void>;
  /** UPDATE swarm_lessons SET lesson_tier = toTier WHERE id = lessonId. */
  updateLessonTier(lessonId: string, toTier: LessonTier): Promise<void>;
}

/**
 * Build the `tier_promotion_log.reason` for an operator pin. Caps the
 * caller note so the combined string fits the migration-078 reason CHECK
 * (octet_length <= 512). The `'operator-pinned'` prefix is the
 * machine-readable distinguisher that lets dashboards filter operator
 * overrides out of (or specifically into) audit views.
 */
export function buildPinReason(note?: string): string {
  const prefix = "operator-pinned";
  if (!note || note.trim().length === 0) return prefix;
  const trimmed = note.trim();
  // 512 octet budget on the column; reserve ~20 octets for prefix + ": " + ellipsis.
  const MAX_NOTE_OCTETS = 480;
  const truncated = truncateToOctets(trimmed, MAX_NOTE_OCTETS);
  return `${prefix}: ${truncated}`;
}

/**
 * UTF-8-safe truncation by octet length. Avoids splitting a multi-byte
 * code unit in the middle (Postgres rejects non-UTF-8 input).
 */
function truncateToOctets(text: string, maxOctets: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxOctets) return text;
  // Walk back from the cap until we hit a UTF-8 boundary (top two bits not 10).
  let cut = maxOctets;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.slice(0, cut).toString("utf8") + "…";
}

export class SwarmPinService {
  private db: DbClient;

  // Accepts a DbClient (PostgrestClient | PGliteAdapter) so this service
  // works against both the Docker/Supabase backend and the in-process PGlite
  // adapter shipped with the native app. The two share the `.from(t)
  // .select|insert|update().eq().maybeSingle()` chain used in defaultDeps —
  // the adapter contract tests gate that surface.
  constructor(db: DbClient) {
    this.db = db;
  }

  /**
   * Pin a lesson to the requested tier. Throws on:
   *   - lesson not found
   *   - current tier already equals target tier (no-op)
   *   - audit-log INSERT failure (the tier UPDATE is skipped — see header)
   *   - tier UPDATE failure
   *
   * Returns the from/to/reason on success so the tool layer can echo it
   * back to the caller and (optionally) write a memory-bus row.
   */
  async pinLesson(
    lessonId: string,
    toTier: LessonTier,
    note: string | undefined,
    deps: SwarmPinDeps,
  ): Promise<PinLessonOutcome> {
    const currentTier = await deps.fetchCurrentTier(lessonId);
    if (currentTier === null) {
      throw new Error(`swarm_lesson ${lessonId} not found`);
    }
    if (currentTier === toTier) {
      throw new Error(
        `swarm_lesson ${lessonId} is already at tier ${toTier} — no-op`,
      );
    }
    const reason = buildPinReason(note);
    await deps.recordTierTransition(lessonId, currentTier, toTier, reason);
    await deps.updateLessonTier(lessonId, toTier);
    return {
      lesson_id: lessonId,
      from_tier: currentTier,
      to_tier:   toTier,
      reason,
    };
  }

  /**
   * Default deps wired against the service's own DbClient. The MCP tool uses
   * this when running in-process; tests inject mocks instead.
   *
   * `db` is widened from `DbClient` because TypeScript can't unify the
   * PostgrestClient and PGliteAdapter `.from()` generic signatures even
   * though both speak the same chain shape at runtime — pglite-adapter
   * contract tests gate that runtime equivalence.
   */
  defaultDeps(): SwarmPinDeps {
    const db = this.db as { from(table: string): any };
    return {
      async fetchCurrentTier(lessonId) {
        const { data, error } = await db
          .from("swarm_lessons")
          .select("lesson_tier")
          .eq("id", lessonId)
          .maybeSingle();
        if (error) {
          throw new Error(
            `swarm_lessons fetch failed: ${error.message ?? String(error)}`,
          );
        }
        if (!data) return null;
        const tier = (data as { lesson_tier: string }).lesson_tier;
        if (tier !== "A" && tier !== "B") {
          throw new Error(
            `swarm_lesson ${lessonId} has unexpected tier ${tier}`,
          );
        }
        return tier;
      },
      async recordTierTransition(lessonId, fromTier, toTier, reason) {
        const { error } = await db.from("tier_promotion_log").insert({
          lesson_id:    lessonId,
          from_tier:    fromTier,
          to_tier:      toTier,
          reason,
          evidence_ids: [],
        });
        if (error) {
          throw new Error(
            `tier_promotion_log insert failed: ${error.message ?? String(error)}`,
          );
        }
      },
      async updateLessonTier(lessonId, toTier) {
        const { error } = await db
          .from("swarm_lessons")
          .update({ lesson_tier: toTier })
          .eq("id", lessonId);
        if (error) {
          throw new Error(
            `swarm_lessons tier update failed: ${error.message ?? String(error)}`,
          );
        }
      },
    };
  }
}
