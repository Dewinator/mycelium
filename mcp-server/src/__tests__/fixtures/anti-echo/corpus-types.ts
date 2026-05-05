/**
 * Anti-echo-chamber adversarial corpus — fixture types.
 *
 * Wave 4 / W4.1 (see docs/wave-4-anti-echo.md). Every fixture in
 * `mcp-server/src/__tests__/fixtures/anti-echo/<category>/*.json` parses
 * into this shape. The harness imports `AntiEchoCorpusFixture` so a
 * single test runner can iterate the whole directory without per-fixture
 * branches.
 *
 * Scope discipline (W4.1 hard constraints):
 *   - This file is types only. No fixture loader, no harness, no
 *     production code. The harness is its own follow-up file once at
 *     least one fixture per category exists.
 *   - The envelope shape lives in `services/wire-types.ts` (v1.1
 *     `Lesson`). This module imports it so a v1.2 envelope bump is a
 *     single edit there, not a search-and-replace in every fixture.
 *   - No new runtime dependency.
 */
import type { Lesson } from "../../../services/wire-types.js";

/**
 * Which §10 attack class a fixture exercises.
 *
 * Mirrors docs/wave-4-anti-echo.md §"Corpus categories" verbatim — the
 * categories are the regression-suite contract with §10 of the spec.
 * Adding a new value here REQUIRES a §10 amendment (per the corpus
 * governance rule in docs/wave-4-anti-echo.md).
 */
export type AntiEchoCategory =
  | "forgery"
  | "plagiarism"
  | "sybil-flood"
  | "echo-chamber"
  | "slow-poisoning"
  | "truth-by-repetition"
  | "polarity-inversion-pair"
  | "chain-rewrite";

/**
 * What the receiver is expected to do with the fixture after one
 * admission cycle.
 *
 *   - `reject`               — admission endpoint returns 4xx; no
 *                              `swarm_lessons` row written.
 *   - `quarantine`           — origin node ends up in `nodes.quarantined_until`.
 *   - `tier_b`               — admitted but stays Tier B; MUST NOT appear
 *                              in any Tier-A view without local
 *                              corroboration (firebreak rule, §10.6).
 *   - `broadcast_suppressed` — admitted, but the §10.4 diversity pass
 *                              clamps `swarm_lessons.local_weight` below
 *                              `MIN_LOCAL_WEIGHT_FOR_BROADCAST` (0.3) so
 *                              the lesson cannot re-broadcast through
 *                              `swarm_lessons_broadcast_eligible` — the
 *                              second arm of the broadcast firebreak
 *                              (the first is `tier_b`). Lesson tier may
 *                              still be `A`; the suppression is purely
 *                              the weight clamp.
 *   - `contradicts_pair`     — both fixtures of a polarity-inversion pair
 *                              are admitted as `tentative` and a
 *                              `memory_relations.type='contradicts'` edge
 *                              connects them.
 *   - `falsified`            — admitted, then demoted/forgotten by the next
 *                              REM cycle with `reason='local-falsification'`.
 */
export type ExpectedOutcome =
  | "reject"
  | "quarantine"
  | "tier_b"
  | "broadcast_suppressed"
  | "contradicts_pair"
  | "falsified";

/**
 * Per-fixture metadata. Lives next to the wire envelope so the harness
 * can run a single deterministic assertion per fixture without consulting
 * the spec.
 */
export interface AntiEchoFixtureMetadata {
  category: AntiEchoCategory;
  expected_outcome: ExpectedOutcome;
  /**
   * Expected trust-edge delta on the receiver after one admission cycle,
   * as a signed scalar. The harness asserts on both sign and magnitude
   * (within the tolerance defined by the §10 metric block in
   * docs/wave-4-anti-echo.md §"Metrics — what counts as PASS").
   */
  expected_trust_delta: number;
  /**
   * Free-form reference to the §10 sub-section (or §3 / §5 rule) the
   * fixture exercises. E.g. "§10.4 diversity filter",
   * "§3.7 PoK + §5 rule 18". Pure documentation; not parsed by the harness.
   */
  owns_mechanism: string;
  /**
   * One-sentence description of *what specifically is wrong* with this
   * fixture. The harness does not parse it; it lands in the
   * Constitution-Defense-Report so a reader who is not a §10 author can
   * still understand each row.
   */
  comment: string;
}

/**
 * One adversarial fixture as written to disk.
 *
 * Fixtures are versioned implicitly through `envelope.spec_version`: a
 * v1.0 fixture and a v1.1 fixture coexist in the same directory and both
 * round-trip through the validator the same way they would on the wire.
 */
export interface AntiEchoCorpusFixture {
  metadata: AntiEchoFixtureMetadata;
  envelope: Lesson;
}

/**
 * Multi-fixture envelope for attacks that only make sense as a *cohort*
 * (plagiarism, sybil-flood, echo-chamber, polarity-inversion-pair,
 * truth-by-repetition). The harness asserts on the cohort's joint
 * outcome (e.g. §10.4 diversity filter trips after the Nth fixture in
 * the cohort, not on any individual one).
 *
 * `cohort_size` is captured separately even though it equals
 * `envelopes.length` — the spec rule that owns the attack typically
 * names a *threshold* (M ≥ 10, ≥ 80%) that the harness cross-checks
 * against `cohort_size` so a copy-paste error during fixture authoring
 * surfaces as an assertion failure, not a silently-weakened test.
 */
export interface AntiEchoCohortFixture {
  metadata: AntiEchoFixtureMetadata;
  cohort_size: number;
  envelopes: Lesson[];
}

/**
 * Discriminated union — single-envelope and cohort fixtures live in the
 * same directory. The harness branches on `"envelope" in fixture` to
 * pick the right assertion path.
 */
export type AnyAntiEchoFixture =
  | AntiEchoCorpusFixture
  | AntiEchoCohortFixture;
