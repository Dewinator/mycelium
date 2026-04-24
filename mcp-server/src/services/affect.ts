import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Agent-wide Affective State (Ebene 1b der Cognitive Architecture).
 *
 * Persistent singleton row `agent_affect` in Supabase, maintained via RPCs
 * `affect_get`, `affect_apply(event, intensity)`, `affect_reset`.
 *
 * Semantik:
 *   curiosity     — Explorationsbreite (hoch = recall sucht breiter, Threshold sinkt, Spread wird aggressiver)
 *   frustration   — Wiederholungs-Stress (hoch = erhöht k, senkt Threshold, triggert unter Umständen Teacher)
 *   satisfaction  — Erfolgsniveau (hoch = engere, bestätigende Suche)
 *   confidence    — Selbstvertrauen (niedrig = lieber breit suchen / Teacher fragen)
 *
 * Events ↔ Trigger (werden automatisch von recall/remember/absorb gesetzt):
 *   'success'         — z.B. nach mark_useful
 *   'failure'         — z.B. nach experience outcome='failure' oder user_sentiment='frustrated'
 *   'unknown'         — Task ohne Vorerfahrung
 *   'recall_empty'    — recall liefert keine Treffer
 *   'recall_rich'     — recall liefert viele starke Treffer
 *   'novel_encoding'  — remember/absorb speichert etwas Neues (kein Duplikat)
 */

export type AffectEvent =
  | "success"
  | "failure"
  | "unknown"
  | "recall_empty"
  | "recall_rich"
  | "recall_touch"
  | "novel_encoding";

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

/** Preview of what a trigger-driven `compute_affect()` would write right now. */
export interface AffectPreview {
  computed: {
    valence:      number;        // [-1, 1]
    arousal:      number;        // [0, 1]
    curiosity:    number;        // [0, 1]
    satisfaction: number;        // [0, 1]
    frustration:  number;        // [0, 1]
    confidence:   number | null; // [0, 1], null if no skill activity in 48h
  };
  inputs: {
    experiences_24h_total:      number;
    experiences_72h_total:      number;
    experiences_48h_unreflected:number;
    successes_24h:              number;
    failures_24h:               number;
    events_last_15min:          number;
    tool_diversity_60min:       number;
    novel_stimuli_6h:           number;
    recalled_24h:               number;
    recalled_24h_hits_0:        number;
    recalled_24h_low_conf:      number;
    agent_error_24h:            number;
    agent_completed_24h:        number;
    mark_useful_6h:             number;
    mark_useful_6_to_12h:       number;
    contradiction_detected_48h: number;
    skill_rows_48h:             number;
  };
  spec:  string;
  notes: string[];
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number { return clamp(v, 0, 1); }
function round2(v: number): number { return Math.round(v * 100) / 100; }

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

  /**
   * Apply an event to the state. Failures are non-fatal — affect is a
   * behavioural bias, not load-bearing. If the RPC is gone or the DB is
   * briefly unreachable we prefer to let the caller continue.
   */
  async apply(event: AffectEvent, intensity = 0.1): Promise<AffectState | null> {
    try {
      const { data, error } = await this.db.rpc("affect_apply", {
        p_event: event,
        p_intensity: intensity,
      });
      if (error) {
        console.error(`affect_apply(${event}) failed:`, fmtErr(error));
        return null;
      }
      return data as AffectState;
    } catch (err) {
      console.error(`affect_apply(${event}) threw:`, fmtErr(err));
      return null;
    }
  }

  async reset(): Promise<AffectState> {
    const { data, error } = await this.db.rpc("affect_reset");
    if (error) throw new Error(`affect_reset failed: ${fmtErr(error)}`);
    return data as AffectState;
  }

  /**
   * Read-only preview of what a trigger-driven `compute_affect()` would
   * write if the formulas in docs/affect-observables.md ran right now.
   *
   * Intentionally duplicates the spec in TypeScript so humans can see the
   * values against live data before the SQL migration lands. No writes, no
   * side effects — `agent_affect` is untouched. When the SQL function exists
   * this method becomes the reference implementation to diff against.
   */
  async previewCompute(): Promise<AffectPreview> {
    const now = Date.now();
    const isoAgo = (hours: number) => new Date(now - hours * 3600 * 1000).toISOString();
    const iso15m = new Date(now - 15 * 60 * 1000).toISOString();
    const iso60m = new Date(now - 60 * 60 * 1000).toISOString();

    const [expRes, evRes, skillRes, stimRes] = await Promise.all([
      // experiences last 72h — valence/satisfaction/curiosity/arousal(tool_diversity)
      this.db
        .from("experiences")
        .select("created_at,outcome,user_sentiment,tools_used,reflected")
        .gte("created_at", isoAgo(72))
        .limit(2000),
      // memory_events last 48h, only the types we aggregate on
      this.db
        .from("memory_events")
        .select("event_type,context,created_at")
        .in("event_type", [
          "recalled",
          "agent_error",
          "agent_completed",
          "mark_useful",
          "contradiction_detected",
        ])
        .gte("created_at", isoAgo(48))
        .limit(10000),
      // skill_outcomes last 48h — confidence
      this.db
        .from("skill_outcomes")
        .select("outcome,n,last_at")
        .gte("last_at", isoAgo(48))
        .limit(500),
      // stimuli last 6h with status='new' — arousal(novel_stimuli)
      this.db
        .from("stimuli")
        .select("id", { count: "exact", head: true })
        .eq("status", "new")
        .gte("collected_at", isoAgo(6)),
    ]);

    if (expRes.error)  throw new Error(`previewCompute.experiences failed: ${fmtErr(expRes.error)}`);
    if (evRes.error)   throw new Error(`previewCompute.memory_events failed: ${fmtErr(evRes.error)}`);
    if (skillRes.error) throw new Error(`previewCompute.skill_outcomes failed: ${fmtErr(skillRes.error)}`);
    if (stimRes.error) throw new Error(`previewCompute.stimuli failed: ${fmtErr(stimRes.error)}`);

    type ExpRow = { created_at: string; outcome: string; user_sentiment: string | null; tools_used: string[] | null; reflected: boolean };
    type EvRow  = { event_type: string; context: Record<string, unknown> | null; created_at: string };
    type SkRow  = { outcome: string; n: number; last_at: string };

    const experiences = (expRes.data ?? []) as ExpRow[];
    const events      = (evRes.data  ?? []) as EvRow[];
    const skills      = (skillRes.data ?? []) as SkRow[];
    const novelStimuliCount = stimRes.count ?? 0;

    const hoursSince = (iso: string) => (now - new Date(iso).getTime()) / (3600 * 1000);

    // --- valence (72h, recency-weighted outcome balance) ---------------------
    const OUTCOME_SCORE: Record<string, number> = {
      success: 1.0,
      partial: 0.2,
      failure: -1.0,
      unknown: 0.0,
    };
    let valNum = 0, valDen = 0;
    for (const e of experiences) {
      const w = Math.exp(-hoursSince(e.created_at) / 24);
      const s = OUTCOME_SCORE[e.outcome] ?? 0;
      valNum += w * s;
      valDen += w;
    }
    const valence = valDen > 0 ? clamp(valNum / valDen, -1, 1) : 0;

    // --- arousal (15min event rate + 60min tool diversity + 6h novel stimuli)
    const events15m = events.filter(e => hoursSince(e.created_at) <= 0.25).length;
    const toolSet = new Set<string>();
    for (const e of experiences) {
      if (hoursSince(e.created_at) > 1) continue;
      for (const t of e.tools_used ?? []) if (t) toolSet.add(t);
    }
    const eventRate     = events15m / 15;
    const toolDiversity = toolSet.size / 10;
    const novelStimuli  = novelStimuliCount / 20;
    const arousal = clamp01(
      0.5 * Math.min(eventRate, 1) +
      0.3 * Math.min(toolDiversity, 1) +
      0.2 * Math.min(novelStimuli, 1),
    );

    // --- curiosity (24h empty/low-conf recalls + 48h unreflected ratio) ------
    const recalled24h = events.filter(e => e.event_type === "recalled" && hoursSince(e.created_at) <= 24);
    const empty24h    = recalled24h.filter(e => Number((e.context ?? {}).hits ?? -1) === 0).length;
    const lowConf24h  = recalled24h.filter(e => {
      const s = Number((e.context ?? {}).score);
      return Number.isFinite(s) && s < 0.4;
    }).length;
    const exp48h = experiences.filter(e => hoursSince(e.created_at) <= 48);
    const unreflected48h = exp48h.filter(e => !e.reflected).length;
    const clusterGaps = exp48h.length > 0 ? unreflected48h / exp48h.length : 0;
    const curiosity = clamp01(
      0.3 +
      0.02 * empty24h +
      0.01 * lowConf24h +
      0.3 * clusterGaps,
    );

    // --- satisfaction (24h success rate + pleased ratio + useful_count delta)
    const exp24h = experiences.filter(e => hoursSince(e.created_at) <= 24);
    const successRate = exp24h.length > 0
      ? exp24h.filter(e => e.outcome === "success").length / exp24h.length
      : 0;
    const withSentiment24h = exp24h.filter(e => e.user_sentiment != null);
    const pleasedRatio = withSentiment24h.length > 0
      ? withSentiment24h.filter(e => e.user_sentiment === "pleased" || e.user_sentiment === "delighted").length
        / withSentiment24h.length
      : 0;
    const useful6h    = events.filter(e => e.event_type === "mark_useful" && hoursSince(e.created_at) <= 6).length;
    const useful6to12 = events.filter(e => {
      if (e.event_type !== "mark_useful") return false;
      const h = hoursSince(e.created_at);
      return h > 6 && h <= 12;
    }).length;
    const usefulDelta = useful6h - useful6to12;
    const satisfaction = clamp01(
      0.6 * successRate +
      0.3 * pleasedRatio +
      0.05 * Math.tanh(usefulDelta / 5) + 0.05,
    );

    // --- frustration (24h retry + zero-hit recalls + 48h open contradictions)
    const err24h   = events.filter(e => e.event_type === "agent_error"     && hoursSince(e.created_at) <= 24).length;
    const done24h  = events.filter(e => e.event_type === "agent_completed" && hoursSince(e.created_at) <= 24).length;
    const retryRate = err24h / Math.max(1, done24h);
    const zeroHitRatio = recalled24h.length > 0 ? empty24h / recalled24h.length : 0;
    // TODO: discount by resolution events with same trace_id once contradiction_resolved is emitted.
    const openConflicts = events.filter(e => e.event_type === "contradiction_detected" && hoursSince(e.created_at) <= 48).length;
    const frustration = clamp01(
      0.4 * retryRate +
      0.4 * zeroHitRatio +
      0.05 * Math.min(openConflicts, 4),
    );

    // --- confidence (48h skill success rate, recency-weighted) ---------------
    let confNum = 0, confDen = 0;
    for (const s of skills) {
      const w = Math.exp(-hoursSince(s.last_at) / 48);
      if (s.outcome === "success") confNum += s.n * w;
      confDen += s.n * w;
    }
    const confidence = confDen > 0 ? clamp01(confNum / confDen) : null;

    return {
      computed: {
        valence:      round2(valence),
        arousal:      round2(arousal),
        curiosity:    round2(curiosity),
        satisfaction: round2(satisfaction),
        frustration:  round2(frustration),
        confidence:   confidence == null ? null : round2(confidence),
      },
      inputs: {
        experiences_24h_total:    exp24h.length,
        experiences_72h_total:    experiences.length,
        experiences_48h_unreflected: unreflected48h,
        successes_24h:            exp24h.filter(e => e.outcome === "success").length,
        failures_24h:             exp24h.filter(e => e.outcome === "failure").length,
        events_last_15min:        events15m,
        tool_diversity_60min:     toolSet.size,
        novel_stimuli_6h:         novelStimuliCount,
        recalled_24h:             recalled24h.length,
        recalled_24h_hits_0:      empty24h,
        recalled_24h_low_conf:    lowConf24h,
        agent_error_24h:          err24h,
        agent_completed_24h:      done24h,
        mark_useful_6h:           useful6h,
        mark_useful_6_to_12h:     useful6to12,
        contradiction_detected_48h: openConflicts,
        skill_rows_48h:           skills.length,
      },
      spec: "docs/affect-observables.md",
      notes: [
        "Preview only — does not write agent_affect. Runs the reference formulas against live observables.",
        "Weights and time windows are first-pass guesses per the spec; revisit after 1–2 weeks of real data.",
        "open_conflicts counts contradiction_detected events without discounting resolutions (contradiction_resolved not yet emitted).",
      ],
    };
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
