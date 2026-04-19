/**
 * Neurochemistry-Service (Migration 042).
 *
 * Drei Systeme: Dopamin (Prediction Error), Serotonin (Zeithorizont),
 * Noradrenalin (Arousal/Yerkes-Dodson). Rückwärtskompatibel über compat-Getter.
 * Pro Genom; Kinder erben beim Breeding über neurochem_init_from_parents.
 *
 * Die Update-Logik liegt in SQL (atomisch, ein Roundtrip). Hier nur Wrapper.
 */
import { PostgrestClient } from "@supabase/postgrest-js";

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string };
  return e.message || e.details || e.hint || JSON.stringify(err);
}

export type NeurochemEvent =
  | "task_complete"
  | "task_failed"
  | "novel_stimulus"
  | "familiar_task"
  | "idle"
  | "error"
  | "teacher_consulted"
  | "born_from_breeding";

export interface NeurochemState {
  exists: boolean;
  label: string;
  dopamine: { current: number; baseline: number; prediction: number; lr: number };
  serotonin: { current: number; decay_rate: number };
  noradrenaline: { current: number; optimal: number };
  consecutive_failures: number;
  last_event: string | null;
  last_outcome: number | null;
  updated_at: string;
  history_n: number;
}

export interface CompatVariables {
  exists: boolean;
  label: string;
  curiosity: number;
  frustration: number;
  satisfaction: number;
  confidence: number;
  last_event: string | null;
  updated_at: string;
}

export interface RecallParams {
  exists: boolean;
  label: string;
  k: number;
  score_threshold: number;
  include_adjacent: boolean;
  performance: number;
}

export interface HorizonResult {
  exists: boolean;
  label: string;
  days: number;
  patience_threshold: number;
}

export class NeurochemistryService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey } : {},
    });
  }

  async ensure(label: string): Promise<string> {
    const { data, error } = await this.db.rpc("neurochem_get_or_init", { p_label: label });
    if (error) throw new Error(`neurochem_get_or_init: ${fmtErr(error)}`);
    return data as string;
  }

  async apply(label: string, event: NeurochemEvent, outcome?: number | null, intensity = 1.0): Promise<NeurochemState> {
    const { data, error } = await this.db.rpc("neurochem_apply", {
      p_label: label,
      p_event: event,
      p_outcome: outcome ?? null,
      p_intensity: intensity,
    });
    if (error) throw new Error(`neurochem_apply: ${fmtErr(error)}`);
    return this._asState(data);
  }

  async get(label: string): Promise<NeurochemState> {
    const { data, error } = await this.db.rpc("neurochem_get", { p_label: label });
    if (error) throw new Error(`neurochem_get: ${fmtErr(error)}`);
    return data as NeurochemState;
  }

  async getCompat(label: string): Promise<CompatVariables> {
    const { data, error } = await this.db.rpc("neurochem_get_compat", { p_label: label });
    if (error) throw new Error(`neurochem_get_compat: ${fmtErr(error)}`);
    return data as CompatVariables;
  }

  async getRecallParams(label: string): Promise<RecallParams> {
    const { data, error } = await this.db.rpc("neurochem_get_recall_params", { p_label: label });
    if (error) throw new Error(`neurochem_get_recall_params: ${fmtErr(error)}`);
    return data as RecallParams;
  }

  async getHorizon(label: string): Promise<HorizonResult> {
    const { data, error } = await this.db.rpc("neurochem_get_horizon", { p_label: label });
    if (error) throw new Error(`neurochem_get_horizon: ${fmtErr(error)}`);
    return data as HorizonResult;
  }

  async history(label: string, limit = 30): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.db.rpc("neurochem_history", { p_label: label, p_limit: limit });
    if (error) throw new Error(`neurochem_history: ${fmtErr(error)}`);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async reset(label: string): Promise<NeurochemState> {
    const { data, error } = await this.db.rpc("neurochem_reset", { p_label: label });
    if (error) throw new Error(`neurochem_reset: ${fmtErr(error)}`);
    return this._asState(data);
  }

  async initFromParents(childLabel: string, parentALabel: string, parentBLabel: string, mutationRate = 0.05): Promise<NeurochemState> {
    const { data, error } = await this.db.rpc("neurochem_init_from_parents", {
      p_child_label: childLabel,
      p_parent_a_label: parentALabel,
      p_parent_b_label: parentBLabel,
      p_mutation_rate: mutationRate,
    });
    if (error) throw new Error(`neurochem_init_from_parents: ${fmtErr(error)}`);
    return this._asState(data);
  }

  /** Row-form from neurochem_apply (raw table row) → nested NeurochemState shape. */
  private _asState(row: unknown): NeurochemState {
    const r = row as Record<string, unknown>;
    return {
      exists: true,
      label: String(r.label ?? ""),
      dopamine: {
        current:    Number(r.dopamine_current),
        baseline:   Number(r.dopamine_baseline),
        prediction: Number(r.dopamine_prediction),
        lr:         Number(r.dopamine_lr),
      },
      serotonin: {
        current:    Number(r.serotonin_current),
        decay_rate: Number(r.serotonin_decay_rate),
      },
      noradrenaline: {
        current:    Number(r.noradrenaline_current),
        optimal:    Number(r.noradrenaline_optimal),
      },
      consecutive_failures: Number(r.consecutive_failures ?? 0),
      last_event:    (r.last_event as string) ?? null,
      last_outcome:  r.last_outcome == null ? null : Number(r.last_outcome),
      updated_at:    String(r.updated_at ?? ""),
      history_n:     Array.isArray(r.history) ? (r.history as unknown[]).length : 0,
    };
  }
}
