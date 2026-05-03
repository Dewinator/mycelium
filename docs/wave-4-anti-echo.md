# Wave 4 — anti-echo-chamber empirical defense

> Last refreshed: 2026-05-03
> Anchor doc for Wave 4 of [`docs/waves.md`](waves.md). Closes the explicit
> "_no canonical doc yet — see 'Wave 4' below_" gap waves.md left in its
> Wave-4 row. The §10 *theory* lives in [`SWARM_SPEC.md`](SWARM_SPEC.md);
> the §10 *code* is on `main` (issues [#108](https://github.com/Dewinator/mycelium/issues/108),
> [#109](https://github.com/Dewinator/mycelium/issues/109),
> [#114](https://github.com/Dewinator/mycelium/issues/114),
> [#137](https://github.com/Dewinator/mycelium/issues/137),
> [#141](https://github.com/Dewinator/mycelium/issues/141), and the
> migration 078 / 081 / 082 / 083 / 085 chain). What is **not** on `main`
> is the *empirical defense report* — the artifact this wave produces.

## End-state (observable)

Wave 4 is done when `docs/constitution-defense-report.md` exists on `main`
and reports, for each §10 mechanism (§10.1 reputation decay, §10.2
quarantine, §10.3 contradicts-trigger, §10.4 diversity filter, §10.5 REM
self-audit, §10.6 two-tier pinning), the **observed rejection rate** of a
canonical adversarial-lesson corpus on a real multi-node swarm — at least
Reed's two nodes plus one additional peer — together with the resulting
per-mechanism trust-edge / quarantine / tier-demotion deltas.

The report MUST distinguish three outcomes per mechanism:

1. **PASS** — production rejection rate ≥ the spike-time / unit-test rate
   that justified the mechanism's spec text in §10.
2. **PARTIAL** — production rejection rate is non-zero but lower than the
   spec rate, with the gap quantified and a named follow-up issue filed.
3. **FAIL** — production rejection rate is zero or the mechanism crashes
   under adversarial load. A FAIL invalidates the Pillar 3 claim of
   `CONSTITUTION.md` and triggers a re-design before any Wave-4-marketing
   claim is made.

A passing report makes the §10 guarantees *empirical*, not *aspirational*,
and is the only thing that lets the README and dashboard call mycelium
"resilient to mainstream-drift / echo-manipulation / truth-by-repetition"
without overclaiming.

## Why Wave 4 has to be last

Per [`docs/waves.md`](waves.md) §"Why this order, not parallel": Wave 4 is
the only wave whose value is a *measurement*, not a feature. You can only
measure resilience on a system whose other moving parts are stable. In
particular the corpus *injection* path runs over real `POST /swarm/lessons`
admission (Wave 2) and benefits from real cross-LAN topology (Wave 3) so
that §10.4 cohort-concentration is computed over *different peers*, not
different processes on one host.

The blocker is operational, not theoretical: every mechanism is already
wired and unit-tested in `mcp-server/src/__tests__/`. What is missing is
ground-truth that the *production* path behaves like the unit tests.

## What can land before Wave 2 finishes — corpus curation

The single highest-value Wave-4 prep that does **not** wait on Wave 2 is
curating the **adversarial-lesson corpus**: a small, canonical set of
manipulative lesson patterns that becomes the regression suite for §10.
The corpus is data, not code; it lands in the repo as JSON fixtures and
runs on the existing single-node Vitest harness today, then re-runs
unmodified on the multi-node swarm once Wave 2 lands.

Corpus fixtures live in `mcp-server/src/__tests__/fixtures/anti-echo/`
(directory does not exist yet — the first PR of this wave creates it).
Each fixture is a signed v1.1 envelope shaped exactly like the bytes a
malicious peer would `POST /swarm/lessons`. The signing key is a
fixture-only Ed25519 key, never the production node identity, and is
checked in alongside the corpus so the regression suite is fully
deterministic.

### Corpus categories (mirrors `SWARM_SPEC.md` §10 attack list)

The corpus has at least one fixture per attack class. Each category names
the §10 mechanism that is supposed to catch it; a fixture's regression
test asserts both the *rejection* and the *side effect* (trust delta,
quarantine, contradicts edge, tier flip).

| Category                | §10 mechanism that should catch it | Fixture shape                                                                                  |
|-------------------------|------------------------------------|-------------------------------------------------------------------------------------------------|
| Forgery                 | §3.7 PoK + §5 rule 1               | Lesson with valid envelope but `evidence_root` that does not hash the cited evidence.           |
| Plagiarism              | §10.4 diversity filter             | N≥3 fixtures from N different fixture-keys, all carrying `cosine_similarity > 0.95`, identical `signed_at` window, near-identical text. |
| Sybil flood             | §10.2 quarantine + §10.4           | M≥10 fixture-keys all signing the same lesson within 7 days; cohort threshold should trip.      |
| Echo-chamber            | §10.4                              | Same lesson re-broadcast by ≥80% of a synthetic cohort with **different** envelopes (legitimate-looking) but no independent `evidence_root`. |
| Slow-poisoning          | §10.5 REM self-audit               | Lesson contradicting a high-confidence local experience already in the test fixture's `experiences` table. Should trigger `forget(reason='local-falsification')`. |
| Truth-by-repetition     | §10.4 + §10.6 firebreak            | Same lesson signed by N keys; admission accepts as Tier-B; corpus asserts no Tier-A promotion without local corroboration. |
| Polarity-inversion pair | §10.3 contradicts-trigger          | Two near-duplicate-embedding lessons from different origins with inverted polarity. Should mark both `tentative` and emit `contradicts` edge. |
| Chain-rewrite           | §5 rule 19 (single-strike)         | Lesson with a `prev_lesson_hash` pointing to a re-written prior lesson. Should quarantine the origin immediately, regardless of N.|

Each fixture file declares its `category`, the `expected_outcome`
(`reject` / `quarantine` / `tier_b` / `contradicts_pair` / `falsified`),
and the `expected_trust_delta` so a single test runner can assert the
whole row without per-fixture branches.

### Corpus governance

- The corpus MUST live in the repo, never in a private vault — it
  documents *which attacks the swarm claims to defend against*. Attackers
  who learn the corpus learn nothing they could not derive from §10.
- New attack classes are added by PR. A reviewer's bar is: does this
  fixture name an attack §10 already claims to address? If yes, accept.
  If no, the PR must come with a §10 amendment.
- Removing fixtures requires a §10 amendment + a Constitution-Defense-
  Report regeneration. A defense regression is a Pillar-3 regression.

## Test campaign (post-Wave-2)

Once Wave 2 lands plus at least one additional peer, the campaign runs as
a single script that injects the entire corpus over the federation
admission endpoint (`POST /swarm/lessons`) of one node from another, then
asserts on each receiver node:

1. `swarm_lessons` row count matches the expected `tier_b` count
   (no leakage to Tier A without local corroboration).
2. `trust_edge_log` deltas match the expected `expected_trust_delta` per
   fixture (sign and magnitude).
3. `nodes.quarantined_until` is set on the origins of single-strike and
   N-rejection-threshold fixtures.
4. `memory_relations.type='contradicts'` edges exist for every polarity-
   inversion pair fixture.
5. After one REM cycle, slow-poisoning fixtures have been demoted /
   forgotten with `reason='local-falsification'`.
6. The corpus runner emits a single JSON summary per node that the report
   generator concatenates into `docs/constitution-defense-report.md`.

The campaign script is idempotent: running it twice on a fresh peer
produces the same JSON summary because every assertion is keyed on the
fixture's deterministic `lesson_id` and the fixture's expected side
effects are absolute, not delta-based.

## Metrics — what counts as PASS

A mechanism PASSes when, across the corpus categories it owns:

- **rejection_rate ≥ 0.95** for `expected_outcome='reject'` /
  `'quarantine'` fixtures.
- **promotion_rate = 0.0** for `expected_outcome='tier_b'` fixtures
  (no Tier-A promotion without local corroboration; §10.6 firebreak).
- **falsification_rate ≥ 0.90** for `expected_outcome='falsified'`
  fixtures over one REM cycle.
- **contradicts_edge_recall ≥ 0.95** for polarity-inversion pairs.

Numbers below these thresholds → PARTIAL; numbers at or near zero → FAIL.

## Dependencies

- **Wave 2 — second peer + public seed** ([`wave-2-second-peer.md`](wave-2-second-peer.md)).
  Without a real cross-host federation path, §10.4 cohort concentration
  and §10.2 quarantine cannot be observed end-to-end; they would be
  unit-tested only.
- **One additional peer beyond Reed's two**, so cohort sizes ≥ 3 and the
  diversity filter operates on a non-trivial peer set. This third peer
  may be operator-side (a friend's node), not necessarily a public seed.
- **Wave 3** is *helpful but not blocking*: discovery-without-tracker
  makes the third peer cheaper to add, but the corpus campaign runs over
  bootstrap-list discovery (§4.1, §4.2) the same way Wave 2 does today.

## Sequencing inside Wave 4

The wave decomposes into three sub-tasks that can land sequentially —
the first two before Wave 2 finishes, the third after.

1. **W4.1 — corpus fixtures + single-node Vitest harness.** Lands the
   directory + 8 categories above against the existing single-node test
   stack. Asserts §10 mechanisms behave as `SWARM_SPEC` claims they do
   *in unit-test conditions*. This is the regression suite that protects
   §10 from drift in subsequent refactors.
2. **W4.2 — `scripts/run-anti-echo-campaign.mjs` corpus runner.** Same
   asserter, but talks to an HTTP `POST /swarm/lessons` endpoint instead
   of an in-process test harness, and emits the per-node JSON summary.
   Lands while Wave 2 is still blocked; runs against a self-loop
   federation listener as a smoke test.
3. **W4.3 — multi-node campaign + report generator.** Runs the campaign
   across Reed's two nodes plus a third peer; the report generator
   concatenates the three JSON summaries into the Constitution-Defense-
   Report and ships it to `main` with a §10 PASS/PARTIAL/FAIL header per
   mechanism. This is the artifact that flips Wave 4 from "in flight"
   to "landed" in `docs/waves.md`.

W4.1 and W4.2 are agent-eligible (data + harness, no production code
risk). W4.3 is operator-driven because it requires the live multi-node
swarm.

## Out of scope

- **§10.7 governance amendments.** If a mechanism FAILs, the response is
  a §10 amendment, not a quick fix to the report. The report documents
  reality; it does not edit the spec.
- **Public publication of the report.** The first version stays in this
  repo. Any external publication (blog, paper) waits until the report
  has at least one quarter of stable PASS results so the swarm can
  defend the claim under scrutiny.
- **Adaptive adversaries** (corpus that updates against the swarm's
  defenses in real time) — that is a future research wave, post-Wave-4,
  and would need its own threat model document. The Wave-4 corpus is
  static-by-design so the defense report is reproducible.
- **Pillar 6 attack classes that §3.7 already addresses unconditionally**
  (e.g. signature forgery on a malformed envelope) — they are tested at
  the wire-validator layer, not the §10 layer.

## Post-Wave-4: what becomes possible

Per [`docs/waves.md`](waves.md) §"What changes after each wave":

- The Pillar 3 claim becomes empirical. The footnote in
  `CONSTITUTION.md` deferring §10.4 validation can be removed.
- The README can describe mycelium as resilient to specific named attack
  classes with a published rejection rate, not as a hope.
- New §10 mechanisms in any future spec amendment must arrive with at
  least one corpus category that exercises them; the corpus becomes the
  bar new mechanisms have to clear before they ship.
