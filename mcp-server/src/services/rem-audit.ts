/**
 * REM self-audit service — Swarm Phase 4h (issue #109).
 *
 * Implements the orchestrator side of SWARM_SPEC §10.5: scan tentative
 * (Tier-B) swarm-imported lessons against local lived experience and
 * falsify those that a high-confidence local cluster contradicts.
 *
 * Three-stage pipeline:
 *   1. RPC `rem_audit_swarm_lessons` (migration 079) returns the rows
 *      that crossed the contradicting-cluster threshold.
 *   2. For each row, the orchestrator:
 *        a. records a local falsifying lesson via the existing
 *           `record_lesson` RPC (so the synthesis enters the local
 *           knowledge graph and is itself eligible for v1.1 publication
 *           — closing the self-correcting loop)
 *        b. decrements the origin's trust_edge with reason
 *           'audit-falsification' via `record_trust_edge_change`
 *           (migration 075) — magnitude scales with mean local cosine
 *        c. deletes the swarm_lesson row (forget)
 *   3. Returns a structured per-lesson report so digest.ts can include
 *      it in the cycle summary.
 *
 * Design discipline (mirrors lesson-contradiction-gate.ts from PR #121):
 *   - The pure decision layer (`scoreFinding`) takes only the RPC row
 *     and is trivially testable.
 *   - The persistence layer (`runSelfAudit`) injects DB side effects via
 *     an `opts.deps` callback bag, so unit tests exercise the
 *     orchestrator without a live Supabase.
 *
 * Local-only invariant (acceptance #2 on issue #109): the RPC reads ONLY
 * the local `experiences` table — never `swarm_lessons`, never `lessons`
 * (which can encode swarm-derived material). The orchestrator does NOT
 * pass any swarm-derived inputs back into the RPC, preserving the
 * "lived-experience-only" ground-truth filter end-to-end.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface RemAuditFinding {
  swarm_lesson_id: string;
  origin_node_id: string;
  swarm_lesson_text: string;
  cluster_size: number;
  mean_cosine: number;
  mean_local_valence: number;
  local_evidence_ids: string[];
  seed_summary: string;
}

export interface RemAuditOptions {
  minClusterSize?: number;
  minCosine?: number;
  maxLocalValence?: number;
  maxAgeDays?: number;
}

export interface RemAuditOutcome {
  swarm_lesson_id: string;
  origin_node_id: string;
  cluster_size: number;
  trust_decrement: number;
  local_lesson_id: string | null;
  forgotten: boolean;
  error?: string;
}

/**
 * Pure decision layer: derive the trust decrement and falsifying-lesson text
 * from a single RPC finding. Has no DB dependency — exercise in unit tests
 * with bare object inputs.
 *
 * The decrement magnitude scales linearly with the mean local cosine
 * (range ~0.8..1.0 → decrement ~0.05..0.25). A floor of 0.05 ensures every
 * confirmed audit moves the trust needle; a ceiling of 0.25 prevents a
 * single audit from collapsing a peer's reputation in one cycle (the
 * §10.1 decay should cumulatively reduce trust over multiple incidents,
 * not via single-shot punitive jumps).
 */
export function scoreFinding(finding: RemAuditFinding): {
  trust_decrement: number;
  falsifying_lesson_text: string;
} {
  const cosineFactor = Math.max(0, Math.min(1, finding.mean_cosine));
  const trust_decrement = Math.max(0.05, Math.min(0.25, cosineFactor * 0.25));
  const falsifying_lesson_text = formatFalsifyingLessonText(finding);
  return { trust_decrement, falsifying_lesson_text };
}

/**
 * Local falsifying-lesson text. Written in the agent's first person so it
 * matches the existing record_lesson convention ("Ich habe gelernt: ...").
 * Captures the four pieces of context a future REM cycle (or operator
 * review) needs to understand WHY the swarm import was rejected:
 *   1. the origin node id (so trust pattern across origins is auditable)
 *   2. the cluster size (so the decision's evidence base is visible)
 *   3. the seed summary (the strongest local counter-example)
 *   4. mean valence (so "contradicting cluster strength" is on record)
 */
export function formatFalsifyingLessonText(finding: RemAuditFinding): string {
  const meanValence = finding.mean_local_valence.toFixed(2);
  const meanCosine = finding.mean_cosine.toFixed(2);
  return (
    `Ich habe gelernt: ein swarm-importierter Lesson von ${finding.origin_node_id} ` +
    `wurde durch ${finding.cluster_size} lokale Erfahrungen falsifiziert ` +
    `(mean cosine ${meanCosine}, mean valence ${meanValence}). ` +
    `Stärkste lokale Gegenevidenz: "${finding.seed_summary}".`
  );
}

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase.
 */
export interface RemAuditDeps {
  /** Insert a local lesson via the existing record_lesson RPC. Returns the new lesson id. */
  recordLesson(text: string, sourceIds: string[]): Promise<string>;
  /** Read the current trust_weight for a node, defaulting to 0.5 for unknowns. */
  readTrustWeight(nodeId: string): Promise<number>;
  /** Apply the trust change atomically via record_trust_edge_change (migration 075). */
  recordTrustEdgeChange(nodeId: string, newWeight: number, reason: string): Promise<void>;
  /** Delete the swarm_lesson row (the §10.5 forget). */
  deleteSwarmLesson(lessonId: string): Promise<void>;
}

export class RemAuditService {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /** Run the §10.5 RPC and return the contradicting-cluster findings. */
  async findContradicted(opts: RemAuditOptions = {}): Promise<RemAuditFinding[]> {
    const { data, error } = await this.db.rpc("rem_audit_swarm_lessons", {
      p_min_cluster_size:  opts.minClusterSize ?? 2,
      p_min_cosine:        opts.minCosine ?? 0.8,
      p_max_local_valence: opts.maxLocalValence ?? -0.3,
      p_max_age_days:      opts.maxAgeDays ?? 90,
    });
    if (error) {
      throw new Error(`rem_audit_swarm_lessons failed: ${error.message ?? String(error)}`);
    }
    return (data ?? []) as RemAuditFinding[];
  }

  /**
   * Run the full §10.5 cycle: query, then for each finding apply the three
   * side effects (forget + trust decrement + falsifying lesson). Returns
   * one outcome row per finding. Per-finding errors are caught so one
   * failure cannot block the rest of the audit pass — the digest pipeline
   * runs every cycle and a transient peer/DB hiccup shouldn't poison it.
   */
  async runSelfAudit(opts: RemAuditOptions, deps: RemAuditDeps): Promise<RemAuditOutcome[]> {
    const findings = await this.findContradicted(opts);
    const outcomes: RemAuditOutcome[] = [];
    for (const finding of findings) {
      outcomes.push(await this.applyFinding(finding, deps));
    }
    return outcomes;
  }

  /**
   * Apply the three side effects for a single finding. Order is intentional:
   *   1. record_lesson FIRST so the falsifying knowledge persists even if
   *      the trust update or forget fails (we never lose the synthesis).
   *   2. record_trust_edge_change SECOND so the audit trail captures the
   *      decrement before the source row disappears.
   *   3. delete_swarm_lesson LAST so a failure earlier in the chain doesn't
   *      orphan the audit references.
   *
   * On any failure the partial-progress outcome is returned with `error` set
   * — the orchestrator never throws across findings.
   */
  private async applyFinding(finding: RemAuditFinding, deps: RemAuditDeps): Promise<RemAuditOutcome> {
    const { trust_decrement, falsifying_lesson_text } = scoreFinding(finding);
    const outcome: RemAuditOutcome = {
      swarm_lesson_id: finding.swarm_lesson_id,
      origin_node_id:  finding.origin_node_id,
      cluster_size:    finding.cluster_size,
      trust_decrement,
      local_lesson_id: null,
      forgotten:       false,
    };
    try {
      outcome.local_lesson_id = await deps.recordLesson(
        falsifying_lesson_text,
        finding.local_evidence_ids,
      );

      const before = await deps.readTrustWeight(finding.origin_node_id);
      const after = Math.max(0, Math.min(1, before - trust_decrement));
      if (after !== before) {
        await deps.recordTrustEdgeChange(
          finding.origin_node_id,
          after,
          `audit-falsification:${finding.swarm_lesson_id}`,
        );
      }

      await deps.deleteSwarmLesson(finding.swarm_lesson_id);
      outcome.forgotten = true;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
    return outcome;
  }

  /**
   * Default deps wired against the service's own SupabaseClient. digest.ts
   * uses this when running in-process; tests inject mocks instead.
   */
  defaultDeps(embedFn: (text: string) => Promise<number[]>): RemAuditDeps {
    const db = this.db;
    return {
      async recordLesson(text, sourceIds) {
        const embedding = await embedFn(text);
        const { data, error } = await db.rpc("record_lesson", {
          p_lesson:     text,
          p_embedding:  embedding,
          p_source_ids: sourceIds,
          p_category:   "warning",
          p_confidence: 0.7,
        });
        if (error) throw new Error(`record_lesson failed: ${error.message}`);
        return data as string;
      },
      async readTrustWeight(nodeId) {
        const { data, error } = await db
          .from("nodes")
          .select("trust_weight")
          .eq("node_id", nodeId)
          .maybeSingle();
        if (error) throw new Error(`read trust_weight failed: ${error.message}`);
        const weight = (data as { trust_weight?: number } | null)?.trust_weight;
        return typeof weight === "number" ? weight : 0.5;
      },
      async recordTrustEdgeChange(nodeId, newWeight, reason) {
        const { error } = await db.rpc("record_trust_edge_change", {
          p_node_id:    nodeId,
          p_new_weight: newWeight,
          p_reason:     reason,
        });
        if (error) throw new Error(`record_trust_edge_change failed: ${error.message}`);
      },
      async deleteSwarmLesson(lessonId) {
        const { error } = await db.from("swarm_lessons").delete().eq("id", lessonId);
        if (error) throw new Error(`delete swarm_lesson failed: ${error.message}`);
      },
    };
  }
}
