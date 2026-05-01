/**
 * Lesson contradiction runner — Swarm Phase 4g.2 substrate (issue #137).
 *
 * Wraps the existing pure §10.3 gate from `lesson-contradiction-gate.ts`
 * with the load + iterate side that turns a single-shot per-ingest check
 * into a sweep over recently-arrived swarm_lessons. This is the missing
 * orchestrator the digest cycle (or, later, the inbound POST endpoint
 * from issue #138) calls once per cycle to populate
 * `swarm_lesson_contradictions` and demote both endpoints to Tier-B.
 *
 * Design discipline mirrors `rem-diversity.ts` and `rem-audit.ts`:
 *   - The pure detection layer lives in `lesson-contradiction-gate.ts`
 *     (unchanged here).
 *   - The persistence + iteration layer here injects all side effects via
 *     an `opts.deps` bag so unit tests can exercise the orchestrator
 *     without a live Supabase.
 *   - The default deps wire against `chain_swarm_lesson_contradicts`
 *     (migration 080) — the same RPC the gate's `applyContradictionGate`
 *     orchestrator already targets.
 *
 * Why a substrate-only PR (no digest wiring yet):
 *   PR #132 (sub-phase 4i.3 follow-up) is the open digest.ts patch that
 *   wires `RemDiversityService` into step 3.7. Adding the §10.3 step here
 *   would conflict with #132 on the digest call site. We follow the same
 *   substrate-then-wiring split that PR #131 (substrate) → PR #132
 *   (wiring) used for §10.4: ship the runner first, wire it in a small
 *   follow-up once #132 lands. The runner is fully testable on its own.
 *
 * Local-only invariant: the runner reads `swarm_lessons` only. It does
 * not pull in `lessons` or `experiences`; the §10.3 gate is a *between-
 * peers* contradiction check, not a swarm-vs-local one (the latter is
 * §10.5 REM self-audit, owned by `rem-audit.ts`).
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  applyContradictionGate,
  type ApplyDeps,
  type ApplyResult,
  type ContradictionFinding,
  type SwarmLessonRow,
} from "./lesson-contradiction-gate.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunOptions {
  /**
   * "Recent" window — swarm_lessons with received_at >= now() - this many
   * hours are checked as newcomers. Default 24h: matches the typical
   * digest cadence and keeps the per-cycle scan bounded.
   */
  recentWindowHours?: number;
  /**
   * "Prior" window — the candidate pool to scan against. Default 14 days.
   * Lessons older than this are NOT compared (saves bandwidth; §10.5 REM
   * self-audit is the long-tail mechanism for stale contradictions).
   */
  priorWindowDays?: number;
  /**
   * Hard cap on the number of newcomer lessons processed per pass.
   * Default 200. The window is the primary scoping; this is a fail-safe.
   */
  newcomerLimit?: number;
  /**
   * Hard cap on the number of priors loaded into memory. Default 2000.
   * The §10.3 gate is O(N) per newcomer in JS-land cosine; this cap keeps
   * a single bad cycle from blowing up the digest budget.
   */
  priorLimit?: number;
}

export interface RunDeps {
  /** Load newcomer rows in the recent window. */
  loadRecent: (opts: { recentWindowHours: number; newcomerLimit: number }) => Promise<SwarmLessonRow[]>;
  /** Load candidate priors. Newcomers are excluded by id at the JS layer. */
  loadPriors: (opts: { priorWindowDays: number; priorLimit: number }) => Promise<SwarmLessonRow[]>;
  /**
   * Per-newcomer side-effect bag passed to `applyContradictionGate`.
   * Identical to the gate's existing `ApplyDeps` so callers can reuse the
   * same recorder pair the inbound HTTP path (issue #138) will use.
   */
  gateDeps: ApplyDeps;
}

export interface RunOutcome {
  new_lesson_id: string;
  scanned_priors: number;
  findings: ContradictionFinding[];
  edges_recorded: number;
  experiences_logged: number;
  /** Set when the per-newcomer pipeline threw before reaching the gate. */
  error?: string;
}

export interface RunSummary {
  newcomers_scanned: number;
  priors_loaded: number;
  outcomes: RunOutcome[];
  total_findings: number;
  total_edges_recorded: number;
  total_experiences_logged: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LessonContradictionRunner {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Run the §10.3 gate across the configured window. Per-newcomer
   * failures are caught so one bad row never poisons the rest of the
   * pass — the SQL CHECK on `chain_swarm_lesson_contradicts` and the
   * gate's own per-finding error boundary already provide one layer;
   * this adds the second around the load+detect combo.
   */
  async runContradictionPass(
    opts: RunOptions,
    deps: RunDeps,
  ): Promise<RunSummary> {
    const recentWindowHours = opts.recentWindowHours ?? 24;
    const priorWindowDays   = opts.priorWindowDays   ?? 14;
    const newcomerLimit     = opts.newcomerLimit     ?? 200;
    const priorLimit        = opts.priorLimit        ?? 2000;

    const recent = await deps.loadRecent({ recentWindowHours, newcomerLimit });
    const priorsRaw = await deps.loadPriors({ priorWindowDays, priorLimit });

    // Newcomers are excluded from the prior pool at the JS layer so a
    // freshly-arrived row that landed within the recent window is not
    // matched against itself. The gate's per-finding self-pair skip
    // would catch it anyway, but stripping here also avoids comparing
    // two newcomers against each other twice (a→b and b→a). Newcomers
    // contradicting each other within the same cycle is a real case
    // covered by the second loop below.
    const newcomerIds = new Set(recent.map((r) => r.id));
    const priors = priorsRaw.filter((p) => !newcomerIds.has(p.id));

    const outcomes: RunOutcome[] = [];
    let totalFindings = 0;
    let totalEdges    = 0;
    let totalExps     = 0;

    for (let i = 0; i < recent.length; i++) {
      const newcomer = recent[i];
      // Compare each newcomer against:
      //   * all priors (older rows)
      //   * the newcomers BEFORE it in the recent set (so a→b is checked
      //     once; b→a is the same edge by canonical ordering on the RPC)
      const earlierNewcomers = recent.slice(0, i);
      const candidates = priors.concat(earlierNewcomers);

      try {
        const result: ApplyResult = await applyContradictionGate(
          newcomer,
          candidates,
          deps.gateDeps,
        );
        outcomes.push({
          new_lesson_id:      newcomer.id,
          scanned_priors:     candidates.length,
          findings:           result.findings,
          edges_recorded:     result.edges_recorded,
          experiences_logged: result.experiences_logged,
        });
        totalFindings += result.findings.length;
        totalEdges    += result.edges_recorded;
        totalExps     += result.experiences_logged;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcomes.push({
          new_lesson_id:      newcomer.id,
          scanned_priors:     candidates.length,
          findings:           [],
          edges_recorded:     0,
          experiences_logged: 0,
          error:              msg,
        });
        // Surface per-newcomer errors but keep the loop alive — the
        // gate already isolates per-finding failures; this catches a
        // failure in the gate's own setup (e.g. the optional experience
        // recorder rejecting the entire batch).
        console.error(
          `[lesson-contradiction-runner] newcomer ${newcomer.id.slice(0, 8)} failed: ${msg}`,
        );
      }
    }

    return {
      newcomers_scanned:        recent.length,
      priors_loaded:            priors.length,
      outcomes,
      total_findings:           totalFindings,
      total_edges_recorded:     totalEdges,
      total_experiences_logged: totalExps,
    };
  }

  /**
   * Default deps wired against this service's SupabaseClient.
   *
   * `loadRecent` / `loadPriors` SELECT the four columns the gate needs
   * (id, content, embedding, lesson_tier). `embedding` is fetched as the
   * pgvector text representation; we parse it back into a plain number
   * array so the in-memory cosine compare in `lesson-contradiction-gate`
   * works without per-row reformatting.
   *
   * `gateDeps.recordContradiction` calls the `chain_swarm_lesson_contradicts`
   * RPC from migration 080 — the same idempotent UPSERT + tier-demotion
   * the gate's tests already cover. `gateDeps.recordExperience` is left
   * undefined here; callers that want experience telemetry inject their
   * own (e.g. the digest wiring follow-up will pass an `ExperienceService`
   * adapter so cohort contradictions show up on the soul timeline).
   */
  defaultDeps(): RunDeps {
    const db = this.db;
    return {
      async loadRecent({ recentWindowHours, newcomerLimit }) {
        const cutoff = new Date(Date.now() - recentWindowHours * 3600 * 1000).toISOString();
        const { data, error } = await db
          .from("swarm_lessons")
          .select("id, content, embedding, lesson_tier")
          .gte("received_at", cutoff)
          .order("received_at", { ascending: true })
          .limit(newcomerLimit);
        if (error) {
          throw new Error(`loadRecent failed: ${error.message ?? String(error)}`);
        }
        return parseRows(data);
      },
      async loadPriors({ priorWindowDays, priorLimit }) {
        const cutoff = new Date(Date.now() - priorWindowDays * 86400 * 1000).toISOString();
        const { data, error } = await db
          .from("swarm_lessons")
          .select("id, content, embedding, lesson_tier")
          .gte("received_at", cutoff)
          .order("received_at", { ascending: false })
          .limit(priorLimit);
        if (error) {
          throw new Error(`loadPriors failed: ${error.message ?? String(error)}`);
        }
        return parseRows(data);
      },
      gateDeps: {
        async recordContradiction({ a_id, b_id, cosine, confidence, reason }) {
          const { data, error } = await db.rpc("chain_swarm_lesson_contradicts", {
            p_lesson_a_id: a_id,
            p_lesson_b_id: b_id,
            p_cosine:      cosine,
            p_confidence:  confidence,
            p_reason:      reason,
          });
          if (error) {
            throw new Error(`chain_swarm_lesson_contradicts failed: ${error.message ?? String(error)}`);
          }
          return (data ?? {}) as Record<string, unknown>;
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * pgvector returns the embedding column as a string in the shape
 * `[0.123,0.456,...]` when SELECTed via PostgREST. `applyContradictionGate`
 * expects a plain `number[]` so we parse defensively here. Already-array
 * inputs (e.g. when an RPC returns the column as JSON) pass through.
 *
 * Exported so the test suite can pin the parser shape — callers that
 * inject their own `loadRecent` / `loadPriors` typically do not need it.
 */
export function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    // Some PostgREST clients deserialise pgvector as number[] directly.
    return raw.map((x) => (typeof x === "number" ? x : Number(x))).filter(Number.isFinite);
  }
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // Strip the surrounding brackets pgvector emits.
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (inner.length === 0) return [];
  const out: number[] = [];
  for (const part of inner.split(",")) {
    const n = Number(part);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

interface RawRow {
  id?:          unknown;
  content?:     unknown;
  embedding?:   unknown;
  lesson_tier?: unknown;
}

function parseRows(rows: RawRow[] | null): SwarmLessonRow[] {
  if (!rows || !Array.isArray(rows)) return [];
  const out: SwarmLessonRow[] = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || typeof r.content !== "string") continue;
    const embedding = parseEmbedding(r.embedding);
    if (embedding.length === 0) continue;
    const tier = r.lesson_tier === "A" || r.lesson_tier === "B" ? r.lesson_tier : undefined;
    out.push({ id: r.id, content: r.content, embedding, lesson_tier: tier });
  }
  return out;
}
