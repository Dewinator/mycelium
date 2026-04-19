/**
 * Motivation layer (Ebene 4 der Cognitive Architecture).
 *
 * Two surfaces:
 *   - Supabase (stimuli, generated_tasks, stimulus_sources, motivation_stats RPC)
 *   - HTTP sidecar ai.openclaw.motivation on 127.0.0.1:18792 for cycle triggers
 *     and runtime status. Sidecar is advisory — when it's down, Supabase-backed
 *     calls still work.
 */
import { PostgrestClient } from "@supabase/postgrest-js";

export interface MotivationStatus {
  last_cycle_started: string | null;
  last_cycle_finished: string | null;
  last_result: Record<string, unknown> | null;
  cycles_completed: number;
  cycles_failed: number;
}

export interface MotivationStats {
  stimuli_by_band_7d: Record<string, number>;
  stimuli_by_status_total: Record<string, number>;
  tasks_by_status: Record<string, number>;
  sources: Array<{
    id: string;
    source_type: string;
    label: string;
    enabled: boolean;
    interval_minutes: number;
    last_fetched_at: string | null;
    last_error: string | null;
  }>;
  generated_at: string;
}

export interface StimulusRow {
  id: string;
  source_type: string;
  title: string | null;
  url: string | null;
  band: string | null;
  relevance: number | null;
  status: string;
  collected_at: string;
  scored_at: string | null;
}

export interface GeneratedTaskRow {
  id: string;
  stimulus_id: string | null;
  task_text: string;
  rationale: string | null;
  relevance: number | null;
  source_type: string | null;
  status: string;
  drift_score: number;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  dormant_since: string;
  metadata: Record<string, unknown>;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export class MotivationService {
  private db: PostgrestClient;
  private sidecarUrl: string;
  private timeoutMs: number;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    sidecarUrl = "http://127.0.0.1:18792",
    timeoutMs = 4000
  ) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.sidecarUrl = sidecarUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  // ---- sidecar ---------------------------------------------------------
  async sidecarHealth(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await this._fetch(`${this.sidecarUrl}/health`, { method: "GET" });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async sidecarStatus(): Promise<MotivationStatus | null> {
    try {
      const r = await this._fetch(`${this.sidecarUrl}/status`, { method: "GET" });
      if (!r.ok) return null;
      return (await r.json()) as MotivationStatus;
    } catch {
      return null;
    }
  }

  async triggerCycle(force = false): Promise<Record<string, unknown> | null> {
    try {
      const r = await this._fetch(
        `${this.sidecarUrl}/cycle${force ? "?force=1" : ""}`,
        { method: "POST" }
      );
      if (!r.ok) return null;
      return (await r.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // ---- supabase --------------------------------------------------------
  async stats(): Promise<MotivationStats> {
    const { data, error } = await this.db.rpc("motivation_stats");
    if (error) throw new Error(`motivation_stats failed: ${fmtErr(error)}`);
    return data as MotivationStats;
  }

  async listStimuli(args: {
    status?: string;
    band?: string;
    sinceHours?: number;
    limit?: number;
  }): Promise<StimulusRow[]> {
    let q = this.db
      .from("stimuli")
      .select("id,source_type,title,url,band,relevance,status,collected_at,scored_at")
      .order("collected_at", { ascending: false })
      .limit(Math.min(args.limit ?? 50, 500));
    if (args.status) q = q.eq("status", args.status);
    if (args.band) q = q.eq("band", args.band);
    if (args.sinceHours) {
      const cutoff = new Date(Date.now() - args.sinceHours * 3600_000).toISOString();
      q = q.gte("collected_at", cutoff);
    }
    const { data, error } = await q;
    if (error) throw new Error(`list_stimuli failed: ${fmtErr(error)}`);
    return (data ?? []) as StimulusRow[];
  }

  async listTasks(args: { status?: string; limit?: number }): Promise<GeneratedTaskRow[]> {
    let q = this.db
      .from("generated_tasks")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(args.limit ?? 50, 500));
    if (args.status) q = q.eq("status", args.status);
    const { data, error } = await q;
    if (error) throw new Error(`list_generated_tasks failed: ${fmtErr(error)}`);
    return (data ?? []) as GeneratedTaskRow[];
  }

  async updateTaskStatus(
    taskId: string,
    status: string,
    approvedBy?: string | null
  ): Promise<GeneratedTaskRow> {
    const { data, error } = await this.db.rpc("update_generated_task_status", {
      p_task_id: taskId,
      p_status: status,
      p_approved_by: approvedBy ?? null,
    });
    if (error) throw new Error(`update_generated_task_status failed: ${fmtErr(error)}`);
    return data as GeneratedTaskRow;
  }

  async driftScan(): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("motivation_drift_scan");
    if (error) throw new Error(`motivation_drift_scan failed: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  private async _fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
