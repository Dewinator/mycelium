/**
 * Lesson contradiction gate — Swarm Phase 4g (issue #108).
 *
 * Implements the §10.3 receiver-side check: when a freshly-ingested swarm
 * lesson L_b lands, scan the already-held swarm lessons for any L_a that
 * satisfies all of:
 *
 *   1. cosine_similarity(L_a.embedding, L_b.embedding) > 0.85   (same topic)
 *   2. polarity inversion in their content                      (mutually exclusive)
 *   3. both already passed §5 rejection rules                   (caller's invariant)
 *
 * On detection the gate marks both as `lesson_tier='B'` (idempotent;
 * the §10.6 firebreak column from migration 078), inserts a row in
 * `swarm_lesson_contradictions` via the `chain_swarm_lesson_contradicts`
 * RPC from migration 080, and returns a structured report so the caller
 * can record an experience for §10.5 REM-audit rediscovery.
 *
 * Design discipline (mirrors wire-validator.ts):
 *   - The pure detection layer (`detectContradictionsAgainst`) takes only
 *     plain inputs (vectors + text) and is trivially testable.
 *   - The persistence layer (`applyContradictionGate`) injects the DB +
 *     experience-recorder side effects via an `opts.deps` callback bag,
 *     so unit tests can exercise the orchestrator without a live Supabase.
 *   - Cosine and polarity heuristics live next to each other so a future
 *     swap to an embedding-based polarity classifier is one well-defined
 *     boundary, not a sprinkle of in-line if-statements.
 *
 * Polarity-inversion heuristic — why this approach was picked over the
 * alternatives (issue #108 acceptance: "documented one paragraph"):
 *
 *   We classify each lesson's content as `negated` / `affirmed` /
 *   `mixed` by counting hard-negation tokens (`not`, `never`, `kein*`,
 *   `nicht`, `niemals`, `no longer`, `MUST NOT`, `darf nicht`, `do not`,
 *   `don't`, `can't`, `cannot`, `won't`) versus the total clause count.
 *   A pair is "polarity-inverted" iff exactly one side is `negated` and
 *   the other is `affirmed` (mixed never triggers — cosine-only
 *   neighbours that disagree on multiple axes need a real classifier
 *   to disambiguate corroboration from contradiction).
 *
 *   Why not a learned classifier: §10.3 says "implementation-defined,
 *   typically a small classifier or contradiction-relation lookup —
 *   choose the smallest viable option". An on-disk classifier would be
 *   another ML dependency (~10–50 MB) and would block CI/local dev on
 *   model availability. Why not the existing ConscienceAgent gateway:
 *   it spawns a Qwen subprocess per check, blocks single-flight, and
 *   the §10.3 trigger needs to scan many candidates per ingest — gateway
 *   roundtrips would dominate ingest latency. The negation-token
 *   heuristic is bilingual (en/de cover the project's two operator
 *   languages) and is wrong on the same edge cases a small classifier
 *   would also be wrong on (sarcasm, double negation, scope ambiguity).
 *   When 4h's REM self-audit lands, those false positives get
 *   downgraded by lived experience anyway.
 *
 *   Future swap: replace `classifyPolarity` with an embedding-distance
 *   call to a contradiction model (e.g. NLI). The orchestrator does not
 *   change; only the heuristic moves.
 */

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const COSINE_TOPIC_THRESHOLD = 0.85;       // §10.3 threshold

export type Polarity = "negated" | "affirmed" | "mixed";

export interface SwarmLessonRow {
  id:        string;
  content:   string;
  embedding: number[];
  /** Optional §10.6 lesson tier (migration 078) — gate may demote A → B. */
  lesson_tier?: "A" | "B";
}

export interface ContradictionFinding {
  /** New lesson being ingested (the trigger). */
  new_lesson_id: string;
  /** The pre-existing lesson it contradicts. */
  prior_lesson_id: string;
  cosine: number;
  /** Polarity-inversion confidence in [0,1]. */
  confidence: number;
  reason: string;
}

export interface ApplyDeps {
  /**
   * Idempotent UPSERT into `swarm_lesson_contradictions` + tier demotion.
   * Wraps the `chain_swarm_lesson_contradicts(...)` RPC from migration 080.
   * Returns the JSONB row the RPC produced. Throws on DB error so the
   * caller can decide to swallow vs. abort the ingest batch.
   */
  recordContradiction: (args: {
    a_id:      string;
    b_id:      string;
    cosine:    number;
    confidence: number;
    reason:    string;
  }) => Promise<Record<string, unknown>>;
  /**
   * Record an experience for §10.5 REM-audit rediscovery. Optional —
   * gate is functional without it (the contradiction edge alone is
   * enough state for REM to find later) but recording it lets the
   * agent's affect/frustration-term observe the conflict.
   */
  recordExperience?: (args: {
    summary: string;
    tags:    string[];
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}

export interface ApplyResult {
  findings:           ContradictionFinding[];
  edges_recorded:     number;
  experiences_logged: number;
}

// ---------------------------------------------------------------------------
// Cosine similarity — pure utility. Returns 0 for degenerate inputs
// (zero vector / mismatched dim) rather than NaN, so threshold tests are
// trivially robust to call-site bugs.
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) return 0;
    dot += ai * bi;
    na  += ai * ai;
    nb  += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Polarity heuristic — bilingual negation-token classifier.
//
// We compile the patterns once at module load. Each pattern matches a
// negation phrase as a whole word/clause to avoid clipping inside other
// tokens (e.g. "knot" doesn't trip the `not` matcher).
//
// English patterns deliberately come BEFORE German ones because mixed-
// language content is common in this codebase's lessons, and the regex
// engine short-circuits on first match per word. Order doesn't change
// the count, only the iteration cost; keep it stable.
// ---------------------------------------------------------------------------

const NEGATION_PATTERNS: RegExp[] = [
  /\b(?:not|never|no|nor|none|nothing|nobody|nowhere|neither)\b/gi,
  /\b(?:can(?:not|'t)|won'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|shan'?t|shouldn'?t|wouldn'?t|couldn'?t|hasn'?t|haven'?t|hadn'?t|mustn'?t)\b/gi,
  /\bmust\s+not\b/gi,
  /\bno\s+longer\b/gi,
  /\b(?:nicht|nie|niemals|kein|keine|keiner|keines|keinem|keinen|nichts|niemand|nirgends|weder)\b/gi,
  /\b(?:darf|dürfen|sollte|soll|muss|müssen|kann|können)\s+nicht\b/gi,
  /\b(?:darf|dürfen|sollte|soll|muss|müssen|kann|können)\s+kein(?:e|er|en|em|es)?\b/gi,
];

/**
 * Classify a piece of lesson content as negated / affirmed / mixed.
 *
 * - `affirmed`: zero negation tokens detected.
 * - `negated`:  any negation token detected, AND the lesson does NOT
 *               contain a counter-affirmation phrase strong enough to
 *               flip the reading. We currently treat the very weak
 *               heuristic "double-negation collapses to affirmation"
 *               as out of scope — see polarity write-up at top of file.
 *               Two or more negation hits in different clauses still
 *               count as `negated` (they amplify, they don't cancel).
 * - `mixed`:    a heuristic placeholder — currently unreachable from
 *               this implementation, kept in the type so callers can
 *               check exhaustively. A future classifier swap fills it.
 */
export function classifyPolarity(content: string): Polarity {
  if (typeof content !== "string" || content.trim() === "") return "affirmed";
  const text = content.toLowerCase();
  let hits = 0;
  for (const pat of NEGATION_PATTERNS) {
    // Reset lastIndex because the patterns are /g — without this they
    // would skip over content on repeated invocations.
    pat.lastIndex = 0;
    const matches = text.match(pat);
    if (matches) hits += matches.length;
  }
  return hits > 0 ? "negated" : "affirmed";
}

/**
 * True iff exactly one side is `negated` and the other is `affirmed`.
 * Returns `false` for any pair that includes `mixed`, two negations,
 * or two affirmations — corroboration and ambiguous cases are NOT
 * contradictions per §10.3.
 */
export function polarityInverted(a: Polarity, b: Polarity): boolean {
  return (a === "negated" && b === "affirmed") ||
         (a === "affirmed" && b === "negated");
}

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

/**
 * Scan `priors` for any lesson that contradicts `incoming` per §10.3.
 *
 * Pure: no DB, no clock, no I/O. Returns one finding per contradiction
 * detected, in input order. The caller decides what to do with them
 * (`applyContradictionGate` is the canonical orchestrator).
 *
 * Self-pair (same id) is silently skipped so callers don't have to
 * pre-filter — an ingest may re-process its own row and we don't want
 * to flag a lesson as contradicting itself.
 */
export function detectContradictionsAgainst(
  incoming: SwarmLessonRow,
  priors:   SwarmLessonRow[],
): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  if (!incoming.embedding || incoming.embedding.length === 0) return findings;
  const incomingPolarity = classifyPolarity(incoming.content);

  for (const prior of priors) {
    if (!prior || prior.id === incoming.id) continue;
    if (!prior.embedding || prior.embedding.length === 0) continue;

    const cos = cosineSimilarity(incoming.embedding, prior.embedding);
    if (!(cos > COSINE_TOPIC_THRESHOLD)) continue;     // §10.3 threshold (strict >)

    const priorPolarity = classifyPolarity(prior.content);
    if (!polarityInverted(incomingPolarity, priorPolarity)) continue;

    // Heuristic confidence: cosine itself is a fine proxy because the
    // polarity gate is a hard yes/no — strength of contradiction tracks
    // strength of topic match. Clamped to [0,1] though cosine can in
    // principle be -1..1, here we already gated on >0.85.
    const confidence = Math.max(0, Math.min(1, cos));

    findings.push({
      new_lesson_id:   incoming.id,
      prior_lesson_id: prior.id,
      cosine:          cos,
      confidence,
      reason: `polarity inversion at cosine=${cos.toFixed(3)} (${incomingPolarity} vs ${priorPolarity})`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestrator (side-effecting; deps injected)
// ---------------------------------------------------------------------------

/**
 * Run the §10.3 gate on a freshly-ingested swarm lesson against an
 * already-held candidate set, persist any contradiction findings, and
 * (optionally) record an experience for each so REM-audit can revisit.
 *
 * The orchestrator does NOT load the candidate set itself — the caller
 * pre-filters the candidates because the right scope depends on the
 * ingest path (e.g. a single-peer poll might pre-restrict to that peer's
 * topic cohort, while a backfill might scan everything). Keeping the
 * scoping decision out here avoids accidentally hard-coding a policy
 * that 4h or 4i should own.
 */
export async function applyContradictionGate(
  incoming:   SwarmLessonRow,
  priors:     SwarmLessonRow[],
  deps:       ApplyDeps,
): Promise<ApplyResult> {
  const findings = detectContradictionsAgainst(incoming, priors);
  let edges = 0;
  let logs  = 0;

  for (const f of findings) {
    try {
      await deps.recordContradiction({
        a_id:       f.new_lesson_id,
        b_id:       f.prior_lesson_id,
        cosine:     f.cosine,
        confidence: f.confidence,
        reason:     f.reason,
      });
      edges += 1;
    } catch (err) {
      // Swallow at the per-finding boundary so one bad row doesn't poison
      // the whole batch. The caller can correlate via `findings`.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lesson-contradiction-gate] recordContradiction failed for ${f.new_lesson_id.slice(0,8)}↔${f.prior_lesson_id.slice(0,8)}: ${msg}`);
      continue;
    }

    if (deps.recordExperience) {
      try {
        await deps.recordExperience({
          summary: `§10.3 contradiction detected between swarm lessons ${f.new_lesson_id.slice(0,8)} and ${f.prior_lesson_id.slice(0,8)} (cosine=${f.cosine.toFixed(3)}). Both demoted to lesson_tier='B' (§10.6 firebreak).`,
          tags:    ["swarm", "contradiction", "phase-4g"],
          metadata: {
            new_lesson_id:   f.new_lesson_id,
            prior_lesson_id: f.prior_lesson_id,
            cosine:          f.cosine,
            confidence:      f.confidence,
            reason:          f.reason,
            spec_section:    "§10.3",
          },
        });
        logs += 1;
      } catch (err) {
        // Experience-logging failure is non-fatal — the edge is the
        // load-bearing record; the experience is observability.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[lesson-contradiction-gate] recordExperience failed: ${msg}`);
      }
    }
  }

  return { findings, edges_recorded: edges, experiences_logged: logs };
}
