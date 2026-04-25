import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Skill-performance tracking: which skill worked for which task type?
 *
 * Fed by `digest.tools_used` × `digest.outcome` × `digest.task_type` × difficulty.
 * Recommendation basis: in `prime_context` we surface "skills that have
 * previously succeeded at this kind of task" so the agent picks better.
 */

export interface SkillRecommendation {
  skill: string;
  success_rate: number | null;
  n_total: number;
  n_success: number;
  n_failure: number;
  score: number;
}

export interface SkillStats {
  skills: Array<{
    skill: string;
    n_total: number;
    n_success: number;
    n_partial: number;
    n_failure: number;
    n_unknown: number;
    success_rate: number | null;
    avg_difficulty: number;
    last_at: string;
    task_types: Record<string, number> | null;
  }>;
  generated_at: string;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

/**
 * Pure helper that builds the `skill_record` RPC payload — the wire that
 * eventually populates `skill_outcomes.outcome` for compute_affect()'s
 * confidence formula (docs/affect-observables.md §confidence reads
 * `n(outcome='success')` from this column).
 *
 * Extracted so the parameter contract — exact key names, empty-string
 * fallback to `'unknown'`, value passthrough — is unit-testable without a
 * Supabase client. A silent rename here (e.g. `p_outcome` → `outcome`) or a
 * normalising transform (`'success'` → `'ok'`) would not break compilation,
 * would still satisfy the SQL CHECK constraint via the `'unknown'` branch in
 * `skill_record()`, and would silently zero out the confidence numerator.
 *
 * Pure: no side-effects, no aliasing — every call returns a fresh object.
 * Mirrors the same defensive pattern as `buildRecalledContext` /
 * `buildContradictionResolvedContext`.
 */
export function buildSkillRecordPayload(
  skills: string[],
  taskType: string,
  outcome: string,
  difficulty: number,
): {
  p_skills: string[];
  p_task_type: string;
  p_outcome: string;
  p_difficulty: number;
} {
  return {
    p_skills: skills,
    p_task_type: taskType || "unknown",
    p_outcome: outcome || "unknown",
    p_difficulty: difficulty,
  };
}

export class SkillsService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  /** Record an outcome for one or more skills that were used on a task. */
  async record(
    skills: string[],
    taskType: string,
    outcome: string,
    difficulty = 0.5
  ): Promise<number> {
    if (!skills || skills.length === 0) return 0;
    try {
      const { data, error } = await this.db.rpc(
        "skill_record",
        buildSkillRecordPayload(skills, taskType, outcome, difficulty),
      );
      if (error) {
        console.error("skill_record failed (non-fatal):", fmtErr(error));
        return 0;
      }
      return (data as number) ?? 0;
    } catch (err) {
      console.error("skill_record threw (non-fatal):", fmtErr(err));
      return 0;
    }
  }

  async stats(): Promise<SkillStats | null> {
    try {
      const { data, error } = await this.db.rpc("skill_stats");
      if (error) {
        console.error("skill_stats failed:", fmtErr(error));
        return null;
      }
      return data as SkillStats;
    } catch (err) {
      console.error("skill_stats threw:", fmtErr(err));
      return null;
    }
  }

  async recommend(
    taskType: string | null,
    minEvidence = 2,
    limit = 5
  ): Promise<SkillRecommendation[]> {
    try {
      const { data, error } = await this.db.rpc("skill_recommend", {
        p_task_type: taskType,
        p_min_evidence: minEvidence,
        p_limit: limit,
      });
      if (error) {
        console.error("skill_recommend failed:", fmtErr(error));
        return [];
      }
      return (data ?? []) as SkillRecommendation[];
    } catch (err) {
      console.error("skill_recommend threw:", fmtErr(err));
      return [];
    }
  }
}
