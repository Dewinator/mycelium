import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Agent-wide Affective State (Ebene 1b der Cognitive Architecture).
 *
 * Persistent singleton row `agent_affect`. Since migration 062 the row is
 * computed from observables — `experiences`, `memory_events`,
 * `skill_outcomes`, `stimuli` — by `compute_affect()`, fired from
 * AFTER-INSERT triggers on `experiences` and `memory_events`. The MCP
 * server only READS it (via `get`) and translates state into a recall
 * bias (`biasFromState`).
 *
 * Semantik:
 *   curiosity     — Explorationsbreite (hoch = recall sucht breiter, Threshold sinkt, Spread wird aggressiver)
 *   frustration   — Wiederholungs-Stress (hoch = erhöht k, senkt Threshold, triggert unter Umständen Teacher)
 *   satisfaction  — Erfolgsniveau (hoch = engere, bestätigende Suche)
 *   confidence    — Selbstvertrauen (niedrig = lieber breit suchen / Teacher fragen)
 */

/**
 * Wire labels that `neurochem_apply()` accepts. Mirrors
 * `neurochemUpdateSchema.event`; the contract test
 * `neurochemistry-schemas.test.ts` keeps both lists in sync.
 */
export const NEUROCHEM_RECOGNISED_EVENTS = [
  "task_complete",
  "task_failed",
  "novel_stimulus",
  "familiar_task",
  "idle",
  "error",
  "teacher_consulted",
] as const;
export type NeurochemEvent = (typeof NEUROCHEM_RECOGNISED_EVENTS)[number];

export interface AffectState {
  curiosity: number;
  frustration: number;
  satisfaction: number;
  confidence: number;
  decay_factor: number;
  updated_at: string;
  hours_since: number;
  last_event: string | null;
}

/** How affect biases a recall call — the practical output of "having feelings". */
export interface RecallBias {
  /** Additive delta on `limit`; positive → widen search. */
  k_delta: number;
  /** Score threshold override (null = keep caller's default). 0..1. */
  score_threshold: number | null;
  /** Whether spreading activation should be aggressive (ignore category, etc.). */
  spread_wide: boolean;
  /** Whether to include adjacent tags in recall (curiosity ≥ 0.6). */
  include_adjacent_tags: boolean;
  /** Short debug string showing which dimensions pushed the bias. */
  reason: string;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export class AffectService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async get(): Promise<AffectState> {
    const { data, error } = await this.db.rpc("affect_get");
    if (error) throw new Error(`affect_get failed: ${fmtErr(error)}`);
    return data as AffectState;
  }

  async reset(): Promise<AffectState> {
    const { data, error } = await this.db.rpc("affect_reset");
    if (error) throw new Error(`affect_reset failed: ${fmtErr(error)}`);
    return data as AffectState;
  }

  /**
   * Translate affect into a concrete recall bias.
   *
   * High frustration + low confidence → widen the search (k+, lower threshold).
   * High satisfaction → narrow the search (engere, bestätigende Abfrage).
   * High curiosity → include adjacent tags / aggressive spread.
   *
   * The magnitudes are deliberately small (Δk ≤ ±4, threshold-swing ≤ 0.15) —
   * affect nudges, it doesn't override caller intent.
   */
  static biasFromState(s: AffectState): RecallBias {
    const reasons: string[] = [];

    let kDelta = 0;
    if (s.frustration >= 0.3) {
      const add = Math.round(s.frustration * 5);       // up to +5
      kDelta += add;
      reasons.push(`frustration=${s.frustration.toFixed(2)} (+${add})`);
    }
    if (s.confidence <= 0.3) {
      const add = Math.round((0.3 - s.confidence) * 10); // up to +3
      kDelta += add;
      reasons.push(`low_conf=${s.confidence.toFixed(2)} (+${add})`);
    }
    if (s.satisfaction >= 0.7) {
      kDelta -= 2;
      reasons.push(`satisfied=${s.satisfaction.toFixed(2)} (-2)`);
    }
    // Clamp to a safe range so callers never get 0 or absurd limits.
    kDelta = Math.max(-4, Math.min(6, kDelta));

    let scoreThreshold: number | null = null;
    if (s.satisfaction >= 0.7) {
      scoreThreshold = 0.7 + Math.min(0.2, (s.satisfaction - 0.7) * 0.66);
      reasons.push(`threshold↑=${scoreThreshold.toFixed(2)}`);
    } else if (s.frustration >= 0.5 || s.curiosity >= 0.7) {
      scoreThreshold = Math.max(0.4, 0.6 - s.curiosity * 0.2);
      reasons.push(`threshold↓=${scoreThreshold.toFixed(2)}`);
    }

    const spreadWide = s.curiosity >= 0.6 || s.frustration >= 0.6;
    const includeAdjacentTags = s.curiosity >= 0.6;
    if (spreadWide) reasons.push("spread_wide");
    if (includeAdjacentTags) reasons.push("adjacent_tags");

    return {
      k_delta: kDelta,
      score_threshold: scoreThreshold,
      spread_wide: spreadWide,
      include_adjacent_tags: includeAdjacentTags,
      reason: reasons.length > 0 ? reasons.join(" ") : "neutral",
    };
  }
}
