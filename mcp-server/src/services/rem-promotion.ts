/**
 * REM promotion-audit service — Swarm Phase 4i, sub-phase 4i.2 (issue #114).
 *
 * Symmetric counterpart to `rem-audit.ts` (4h, issue #109): instead of
 * scanning tentative (Tier-B) swarm-imported lessons for a *contradicting*
 * local cluster (forget), this service scans them for a *corroborating*
 * local cluster (promote to Tier-A).
 *
 * Without a promotion path, the §10.6 broadcast firewall (migration 078) is
 * a permanent dead-end for swarm-ingested lessons — the §10.6 "broadcast-
 * eligible if corroborated" clause is unreachable. This service closes that
 * arrow. The two paths are intentionally written as siblings so the next
 * reader can hold both halves of the §10 immune system in one mental frame.
 *
 * Three-stage pipeline, mirroring rem-audit.ts:
 *   1. RPC `rem_promote_swarm_lessons` (migration 081) returns the rows
 *      that crossed the corroborating-cluster threshold.
 *   2. For each row, the orchestrator:
 *        a. UPDATEs `swarm_lessons.lesson_tier` from 'B' to 'A'
 *        b. INSERTs a row into `tier_promotion_log` (migration 078) with
 *           from_tier='B', to_tier='A', and the local evidence_ids that
 *           justified the promotion — append-only audit
 *      No trust-edge change here: trust deltas are §10.1 + §10.5
 *      territory; promotion is an evidence-driven status transition,
 *      not a reputation event.
 *   3. Returns a structured per-lesson report so digest.ts can include
 *      it in the cycle summary.
 *
 * Local-only invariant (mirrors 4h's acceptance #2): the RPC reads ONLY
 * the local `experiences` table — never `swarm_lessons`, never `lessons`.
 * Without this, two peers could mutually-promote each other's claims to
 * Tier-A without any local ground truth — the §10.4 echo-chamber attack
 * would have a clean entry point straight through 4i.2.
 *
 * Design discipline (mirrors lesson-contradiction-gate.ts and rem-audit.ts):
 *   - The pure decision layer (`scoreFinding`) takes only the RPC row
 *     and is trivially testable.
 *   - The persistence layer (`runPromotionPass`) injects DB side effects
 *     via an `opts.deps` callback bag, so unit tests exercise the
 *     orchestrator without a live Supabase.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface RemPromotionFinding {
  swarm_lesson_id: string;
  origin_node_id: string;
  swarm_lesson_text: string;
  cluster_size: number;
  mean_cosine: number;
  mean_local_valence: number;
  local_evidence_ids: string[];
  seed_summary: string;
}

export interface RemPromotionOptions {
  minClusterSize?: number;
  minCosine?: number;
  minLocalValence?: number;
  maxAgeDays?: number;
}

export interface RemPromotionOutcome {
  swarm_lesson_id: string;
  origin_node_id: string;
  cluster_size: number;
  promoted: boolean;
  log_reason: string;
  error?: string;
}

/**
 * Pure decision layer: derive the promotion-log `reason` text from a
 * single RPC finding. Has no DB dependency — exercised in unit tests
 * with bare object inputs.
 *
 * Symmetric to `scoreFinding` in rem-audit.ts but simpler: there is no
 * trust delta to compute (promotion is not a reputation event), only
 * an audit-log message. The reason embeds the four pieces of context an
 * operator review needs to understand WHY the promotion was justified:
 *   1. cluster size (so the evidence base is on record)
 *   2. mean cosine (cluster→lesson semantic distance)
 *   3. mean valence (cluster polarity strength)
 *   4. seed summary (the strongest local corroborating example)
 *
 * Truncated to fit the migration-078 `reason` CHECK (octet_length <= 512)
 * with margin for prefix and embedded numbers.
 */
export function scoreFinding(finding: RemPromotionFinding): {
  log_reason: string;
} {
  const meanValence = finding.mean_local_valence.toFixed(2);
  const meanCosine = finding.mean_cosine.toFixed(2);
  const seed = truncateForLog(finding.seed_summary, 220);
  const log_reason =
    `§10.6 corroborated: ${finding.cluster_size} local experience(s) ` +
    `(mean cosine ${meanCosine}, mean valence ${meanValence}). ` +
    `Strongest: "${seed}".`;
  return { log_reason };
}

function truncateForLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase.
 */
export interface RemPromotionDeps {
  /** UPDATE swarm_lessons SET lesson_tier='A' WHERE id = lessonId. */
  promoteSwarmLessonTier(lessonId: string): Promise<void>;
  /**
   * INSERT INTO tier_promotion_log (lesson_id, from_tier='B', to_tier='A',
   * reason, evidence_ids). Append-only — migration 078 withholds UPDATE
   * and DELETE grants on this table.
   */
  recordTierPromotion(
    lessonId: string,
    reason: string,
    evidenceIds: string[],
  ): Promise<void>;
}

export class RemPromotionService {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /** Run the §10.6 RPC and return the corroborating-cluster findings. */
  async findCorroborated(
    opts: RemPromotionOptions = {},
  ): Promise<RemPromotionFinding[]> {
    const { data, error } = await this.db.rpc("rem_promote_swarm_lessons", {
      p_min_cluster_size:  opts.minClusterSize ?? 2,
      p_min_cosine:        opts.minCosine ?? 0.8,
      p_min_local_valence: opts.minLocalValence ?? 0.3,
      p_max_age_days:      opts.maxAgeDays ?? 90,
    });
    if (error) {
      throw new Error(
        `rem_promote_swarm_lessons failed: ${error.message ?? String(error)}`,
      );
    }
    return (data ?? []) as RemPromotionFinding[];
  }

  /**
   * Run the full §10.6 promotion pass: query, then for each finding apply
   * the two side effects (tier flip + audit log). Returns one outcome per
   * finding. Per-finding errors are caught so one failure cannot block the
   * rest of the pass — the digest pipeline runs every cycle and a transient
   * peer/DB hiccup shouldn't poison it.
   */
  async runPromotionPass(
    opts: RemPromotionOptions,
    deps: RemPromotionDeps,
  ): Promise<RemPromotionOutcome[]> {
    const findings = await this.findCorroborated(opts);
    const outcomes: RemPromotionOutcome[] = [];
    for (const finding of findings) {
      outcomes.push(await this.applyFinding(finding, deps));
    }
    return outcomes;
  }

  /**
   * Apply the two side effects for a single finding. Order is intentional:
   *   1. recordTierPromotion FIRST so the audit row is durable even if the
   *      tier flip fails. The append-only log is the source of truth for
   *      §10.6 traceability — losing the log is worse than a stuck tier.
   *   2. promoteSwarmLessonTier SECOND. If step 1 fails we never run
   *      step 2, so the broadcast firewall stays closed (Tier-B remains)
   *      until the next REM cycle retries.
   *
   * On any failure the partial-progress outcome is returned with `error`
   * set — the orchestrator never throws across findings.
   */
  private async applyFinding(
    finding: RemPromotionFinding,
    deps: RemPromotionDeps,
  ): Promise<RemPromotionOutcome> {
    const { log_reason } = scoreFinding(finding);
    const outcome: RemPromotionOutcome = {
      swarm_lesson_id: finding.swarm_lesson_id,
      origin_node_id:  finding.origin_node_id,
      cluster_size:    finding.cluster_size,
      promoted:        false,
      log_reason,
    };
    try {
      await deps.recordTierPromotion(
        finding.swarm_lesson_id,
        log_reason,
        finding.local_evidence_ids,
      );
      await deps.promoteSwarmLessonTier(finding.swarm_lesson_id);
      outcome.promoted = true;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    return outcome;
  }

  /**
   * Default deps wired against the service's own SupabaseClient. digest.ts
   * uses this when running in-process; tests inject mocks instead.
   */
  defaultDeps(): RemPromotionDeps {
    const db = this.db;
    return {
      async recordTierPromotion(lessonId, reason, evidenceIds) {
        const { error } = await db.from("tier_promotion_log").insert({
          lesson_id:    lessonId,
          from_tier:    "B",
          to_tier:      "A",
          reason,
          evidence_ids: evidenceIds,
        });
        if (error) {
          throw new Error(
            `tier_promotion_log insert failed: ${error.message}`,
          );
        }
      },
      async promoteSwarmLessonTier(lessonId) {
        const { error } = await db
          .from("swarm_lessons")
          .update({ lesson_tier: "A" })
          .eq("id", lessonId);
        if (error) {
          throw new Error(
            `swarm_lessons tier promotion failed: ${error.message}`,
          );
        }
      },
    };
  }
}
