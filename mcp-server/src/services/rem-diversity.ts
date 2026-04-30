/**
 * REM diversity service — Swarm Phase 4i, sub-phase 4i.3 (issue #114).
 *
 * Implements the orchestrator side of SWARM_SPEC §10.4 "Anti-echo-chamber
 * (diversity policy)": the receiver scans its swarm_lessons for topic-
 * cohort over-concentration and decrements the local_weight of any lesson
 * that >= p_over_concentration of the topic-cohort peer set holds in
 * near-duplicate form. Cohort-level repetition is the inverse of true
 * corroboration (different evidence chains reaching similar conclusions);
 * §10.4 calls it out as plagiarism / re-broadcast amplification and
 * requires the receiver to push back rather than reinforce.
 *
 * Three-stage pipeline (mirrors rem-audit.ts / rem-promotion.ts):
 *   1. RPC `rem_diversity_check_lessons` (migration 082) returns the rows
 *      that crossed the over-concentration threshold.
 *   2. For each row, the orchestrator:
 *        a. reads the lesson's current local_weight
 *        b. computes new_weight = prev_weight * (1 − over_concentration)
 *        c. appends a lesson_diversity_log row FIRST (the (new_weight <=
 *           prev_weight) CHECK is the SQL-layer guarantee that this
 *           multiplier never accidentally amplifies)
 *        d. flips swarm_lessons.local_weight to new_weight
 *   3. Returns a structured per-lesson outcome so a future digest.ts
 *      step 3.7 wiring (sub-phase 4i.4) can include it in the cycle
 *      summary. This sub-phase ships substrate only — wiring follows in
 *      4i.4 to keep the §10.5/§10.6 digest steps from PRs #125/#129
 *      mergeable in either order.
 *
 * Local-only invariant: same as 079 / 081 — the RPC reads ONLY
 * swarm_lessons. §10.4 is explicitly a per-peer concentration signal; any
 * cross-table join to `experiences` or `lessons` would mix lived-evidence
 * into a diversity check that is supposed to operate on inter-peer
 * over-concentration. The orchestrator does not pass any non-swarm input
 * back into the RPC, preserving this end-to-end.
 *
 * §10.4 weight formula:
 *   over_concentration ∈ [p_over_concentration, 1.0]  (RPC threshold)
 *   factor             = (1 − over_concentration)     ∈ [0, 1 − p_over_concentration]
 *   new_weight         = max(0, min(prev_weight, prev_weight * factor))
 * The clamp enforces three §10.4 invariants:
 *   * never increases  (the SQL CHECK plus the min(prev_weight, ...))
 *   * never goes below 0
 *   * a 100%-concentrated cohort silences the lesson entirely
 *     (factor = 0 → new_weight = 0).
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface RemDiversityFinding {
  swarm_lesson_id: string;
  origin_node_id: string;
  swarm_lesson_text: string;
  topic_cohort_size: number;
  near_dup_origin_count: number;
  over_concentration: number;
  near_dup_lesson_ids: string[];
}

export interface RemDiversityOptions {
  topicCosine?: number;
  duplicateCosine?: number;
  evidenceCountBand?: number;
  signedAtWindowDays?: number;
  minCohortSize?: number;
  overConcentration?: number;
}

export interface RemDiversityOutcome {
  swarm_lesson_id: string;
  origin_node_id: string;
  topic_cohort_size: number;
  near_dup_origin_count: number;
  over_concentration: number;
  prev_weight: number;
  new_weight: number;
  applied: boolean;
  error?: string;
}

/**
 * Pure decision layer: derive the new local_weight + audit reason from a
 * single RPC finding's prior weight. No DB dependency — exercise in unit
 * tests with bare object inputs.
 *
 * Three guarantees enforced in code (in addition to the SQL CHECK):
 *   * Clamps over_concentration to [0, 1] so a malformed RPC row cannot
 *     produce a factor outside [0, 1].
 *   * min(prev_weight, prev_weight * factor) ensures the multiplier never
 *     amplifies even if a future caller passes a factor > 1.
 *   * max(0, ...) ensures the result respects the swarm_lessons.local_weight
 *     CHECK lower bound.
 */
export function scoreFinding(
  prevWeight: number,
  finding: RemDiversityFinding,
): { new_weight: number; reason: string } {
  const over = Math.max(0, Math.min(1, finding.over_concentration));
  const factor = 1 - over;
  const candidate = prevWeight * factor;
  const new_weight = Math.max(0, Math.min(prevWeight, candidate));
  const reason = formatReason(finding);
  return { new_weight, reason };
}

/**
 * Audit-log reason string. Captures the four pieces of context an operator
 * (or a future REM cycle) needs to understand WHY the lesson's local_weight
 * dropped:
 *   1. spec section (§10.4) — so the audit row is self-describing
 *   2. near_dup_origin_count / topic_cohort_size — the raw concentration
 *   3. over_concentration — the derived ratio that drove the decrement
 *   4. origin_node_id — so an operator can spot which peer is over-broadcasting
 * The combined length is well under the 512-byte CHECK on lesson_diversity_log.reason.
 */
export function formatReason(finding: RemDiversityFinding): string {
  const over = finding.over_concentration.toFixed(2);
  return (
    `§10.4 echo-chamber: ${finding.near_dup_origin_count}/${finding.topic_cohort_size} ` +
    `cohort peers (incl. ${finding.origin_node_id}) hold near-duplicate ` +
    `(over_concentration=${over})`
  );
}

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase.
 */
export interface RemDiversityDeps {
  /** Read the current local_weight for a swarm_lesson; defaults to 1.0 for unknowns. */
  readLocalWeight(lessonId: string): Promise<number>;
  /** Append a lesson_diversity_log row + flip swarm_lessons.local_weight in that order. */
  applyWeightChange(
    lessonId: string,
    prevWeight: number,
    newWeight: number,
    finding: RemDiversityFinding,
    reason: string,
  ): Promise<void>;
}

export class RemDiversityService {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /** Run the §10.4 RPC and return the over-concentrated findings. */
  async findOverconcentrated(
    opts: RemDiversityOptions = {},
  ): Promise<RemDiversityFinding[]> {
    const { data, error } = await this.db.rpc("rem_diversity_check_lessons", {
      p_topic_cosine:        opts.topicCosine        ?? 0.85,
      p_duplicate_cosine:    opts.duplicateCosine    ?? 0.95,
      p_evidence_count_band: opts.evidenceCountBand  ?? 1,
      p_signed_at_window_d:  opts.signedAtWindowDays ?? 7,
      p_min_cohort_size:     opts.minCohortSize      ?? 3,
      p_over_concentration:  opts.overConcentration  ?? 0.8,
    });
    if (error) {
      throw new Error(
        `rem_diversity_check_lessons failed: ${error.message ?? String(error)}`,
      );
    }
    return (data ?? []) as RemDiversityFinding[];
  }

  /**
   * Run the full §10.4 cycle: query, then for each finding apply the
   * weight decrement (with audit-log append). Returns one outcome row per
   * finding. Per-finding errors are caught so one failure cannot block the
   * rest of the diversity pass — the digest pipeline runs every cycle and
   * a transient DB hiccup shouldn't poison it.
   */
  async runDiversityPass(
    opts: RemDiversityOptions,
    deps: RemDiversityDeps,
  ): Promise<RemDiversityOutcome[]> {
    const findings = await this.findOverconcentrated(opts);
    const outcomes: RemDiversityOutcome[] = [];
    for (const finding of findings) {
      outcomes.push(await this.applyFinding(finding, deps));
    }
    return outcomes;
  }

  /**
   * Apply the weight change for a single finding. Side-effect order is
   * intentional and mirrors rem-promotion.ts (audit-first):
   *   1. read prev_weight
   *   2. compute new_weight via scoreFinding
   *   3. if new_weight === prev_weight, short-circuit (no audit spam from
   *      no-op transitions; the SQL CHECK on (from_tier <> to_tier) is the
   *      analogue for tier_promotion_log — diversity log just needs the
   *      app-layer no-op guard since strict equality on REAL is fine when
   *      both sides came through the same scoreFinding formula)
   *   4. applyWeightChange: log row INSERT first (durable audit), then
   *      swarm_lessons.local_weight flip second. If the log INSERT fails,
   *      the weight stays at prev (visible decrement is impossible without
   *      an audit row).
   *
   * On any failure the partial-progress outcome is returned with `error`
   * set — the orchestrator never throws across findings.
   */
  private async applyFinding(
    finding: RemDiversityFinding,
    deps: RemDiversityDeps,
  ): Promise<RemDiversityOutcome> {
    const outcome: RemDiversityOutcome = {
      swarm_lesson_id:       finding.swarm_lesson_id,
      origin_node_id:        finding.origin_node_id,
      topic_cohort_size:     finding.topic_cohort_size,
      near_dup_origin_count: finding.near_dup_origin_count,
      over_concentration:    finding.over_concentration,
      prev_weight:           1.0,
      new_weight:            1.0,
      applied:               false,
    };
    try {
      const prevWeight = await deps.readLocalWeight(finding.swarm_lesson_id);
      outcome.prev_weight = prevWeight;
      const { new_weight, reason } = scoreFinding(prevWeight, finding);
      outcome.new_weight = new_weight;
      if (new_weight >= prevWeight) {
        // No-op: nothing to decrement. Skip the audit row entirely.
        return outcome;
      }
      await deps.applyWeightChange(
        finding.swarm_lesson_id,
        prevWeight,
        new_weight,
        finding,
        reason,
      );
      outcome.applied = true;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    return outcome;
  }

  /**
   * Default deps wired against the service's own SupabaseClient. The 4i.4
   * digest.ts wiring step uses this; tests inject mocks instead.
   *
   * applyWeightChange: append the audit row FIRST (durable evidence), then
   * UPDATE swarm_lessons.local_weight SECOND. If the UPDATE fails, the log
   * still records the intended transition and a future cycle can retry.
   * If the UPDATE succeeds but the log INSERT had failed, we'd never reach
   * the UPDATE — so weight-without-audit is structurally impossible.
   */
  defaultDeps(): RemDiversityDeps {
    const db = this.db;
    return {
      async readLocalWeight(lessonId) {
        const { data, error } = await db
          .from("swarm_lessons")
          .select("local_weight")
          .eq("id", lessonId)
          .maybeSingle();
        if (error) {
          throw new Error(`read local_weight failed: ${error.message}`);
        }
        const w = (data as { local_weight?: number } | null)?.local_weight;
        return typeof w === "number" ? w : 1.0;
      },
      async applyWeightChange(lessonId, prevWeight, newWeight, finding, reason) {
        const insertRes = await db.from("lesson_diversity_log").insert({
          lesson_id:             lessonId,
          prev_weight:           prevWeight,
          new_weight:            newWeight,
          topic_cohort_size:     finding.topic_cohort_size,
          near_dup_origin_count: finding.near_dup_origin_count,
          over_concentration:    finding.over_concentration,
          reason,
          near_dup_lesson_ids:   finding.near_dup_lesson_ids,
        });
        if (insertRes.error) {
          throw new Error(
            `lesson_diversity_log insert failed: ${insertRes.error.message}`,
          );
        }
        const updateRes = await db
          .from("swarm_lessons")
          .update({ local_weight: newWeight })
          .eq("id", lessonId);
        if (updateRes.error) {
          throw new Error(
            `swarm_lessons.local_weight update failed: ${updateRes.error.message}`,
          );
        }
      },
    };
  }
}
