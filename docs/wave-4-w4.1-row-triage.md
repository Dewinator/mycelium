# Wave 4 · W4.1 row triage — rows 1–3 merged, row 4 in PR queue, 4 remaining rows still unit-testable on `main`

> Last refreshed: 2026-05-05 (205th-tick correction — row 1 mechanism was `§5 rule 1` (Wrong spec_version major), should be `§5 rule 18` (Merkle root mismatch); the shipped fixture's own `metadata.owns_mechanism`, the `anti-echo-forgery.test.ts` assertion, and SWARM_SPEC §5 line 491 all agree on rule 18. Same fix landed in [`docs/wave-4-anti-echo.md`](wave-4-anti-echo.md). Also retargeted rows 1–3's "Unit-test path" column at the actually-shipped `anti-echo-*.test.ts` files instead of the pre-shipped rationale tests.).
> Pre-work for [issue #196](https://github.com/Dewinator/mycelium/issues/196) (W4.1).
> Closes the implicit per-row triage cost the W4.1 issue body opens with:
> *"If a §10 mechanism cannot be made to fire from a unit test (because it
> requires real federation or a multi-node cohort), that fixture is
> deferred to W4.2 — flag it with a comment, do not weaken the
> assertion."* This doc walks rows 4–8 against the §10 code on `main` and
> records the verdict per row, so the agent that picks up W4.1 after the
> queue drains does not re-derive it.

## TL;DR

**Rows 1–3 merged on `main` (PRs [#197](https://github.com/Dewinator/mycelium/pull/197)
forgery / [#198](https://github.com/Dewinator/mycelium/pull/198) plagiarism /
[#201](https://github.com/Dewinator/mycelium/pull/201) sybil-flood). Row 4
(echo-chamber) is in flight as PR [#212](https://github.com/Dewinator/mycelium/pull/212),
queued behind the Wave-1 stack. All 4 remaining W4.1 rows (5, 6, 7, 8) ship
as single-node unit tests against the existing `node:test` harness. None
defer to W4.2.** The §10 mechanisms each row owns are already covered by
an in-process dep-stub test on `main`, and synthesising the adversarial
input (cohort, fake-key-signed envelope, paired local experience)
requires no federation listener.

| Row | Category | §10 mechanism | Unit-test path on `main` | Verdict |
|---|---|---|---|---|
| 1 | `forgery` | §3.7 PoK + §5 rule 18 (Merkle root mismatch) | `anti-echo-forgery.test.ts` via `validateLessonProof` (proof-time, not admission-time — wire-validator is content-agnostic about `evidence_root`) | ✅ shipped — PR [#197](https://github.com/Dewinator/mycelium/pull/197) |
| 2 | `plagiarism` | §10.4 diversity filter | `anti-echo-plagiarism.test.ts` via `scoreFinding` (rationale: `rem-diversity.test.ts` proves the same RPC trips on multi-key identical-broadcast) | ✅ shipped — PR [#198](https://github.com/Dewinator/mycelium/pull/198) |
| 3 | `sybil-flood` | §10.4 diversity filter (the row's W4.1 unit-test arm; §10.2 quarantine is operator-driven and deferred to W4.2/W4.3 per the fixture's own `metadata.comment`) | `anti-echo-sybil-flood.test.ts` via `scoreFinding` on a 10-key cohort (rationale: `swarm-admit.test.ts` + `rem-diversity.test.ts` already gate the §10.4 path) | ✅ shipped — PR [#201](https://github.com/Dewinator/mycelium/pull/201) |
| 4 | `echo-chamber` | §10.4 diversity filter | `rem-diversity.test.ts` (already covers the canonical "4 of 5 peers" case) | 🟡 in PR [#212](https://github.com/Dewinator/mycelium/pull/212) — test green, awaiting Reed merge |
| 5 | `slow-poisoning` | §10.5 REM self-audit | `rem-audit.test.ts` (orchestrator dep-stub seeds local evidence) | unit-testable |
| 6 | `truth-by-repetition` | §10.4 + §10.6 firebreak | `rem-promotion.test.ts` (promotion threshold on synthetic cluster) | unit-testable |
| 7 | `polarity-inversion-pair` | §10.3 contradicts-trigger | `lesson-contradiction-gate.test.ts` (cosine + polarity in isolation) | unit-testable |
| 8 | `chain-rewrite` | §5 rule 19 single-strike | `lesson-chain.test.ts` (chain conflict + INSERT-failure atomicity) | unit-testable |

## How the verdicts were reached

The W4.1 issue body's deferral rule has two triggers — *real federation*
and *multi-node cohort*. The §10 code on `main` removes both for unit
tests:

1. **Federation is mocked at the dep boundary.** Every §10 service
   (`swarm-admit`, `rem-audit`, `rem-diversity`, `rem-promotion`,
   `lesson-contradiction-gate`, `lesson-chain`) follows the same
   "pure-helper + orchestrator-with-dep-stubs" split documented in
   the test-file headers (e.g. `rem-audit.test.ts` lines 11–22). The
   orchestrator never opens a network socket; the test passes a
   `Deps` object whose methods are in-memory fakes.

2. **Cohorts are synthesised per-test.** `swarm-admit.test.ts` already
   calls `generateKeyPairSync` to mint a fresh peer identity per
   admission test and signs envelopes via `services/signature.ts` →
   `signWithSelfKey`. A sybil-flood cohort of M ≥ 10 is M calls to
   `generateKeyPairSync` plus M sign+admit invocations against the
   same in-memory harness. No federation, no second process.

3. **Diversity / over-concentration is a pure ratio.**
   `rem-diversity.test.ts` already exercises the canonical §10.4
   "4 of 5 peers → over_concentration = 0.8" case as a pure helper
   call (`scoreFinding`). An echo-chamber fixture is the same shape
   with the cohort assembled at fixture-load time and asserted via
   the existing orchestrator dep-stub.

4. **REM self-audit operates on local evidence the test seeds.**
   `rem-audit.test.ts` constructs `RemAuditFinding` rows that include
   `local_evidence_ids` — the dep-stub returns the seeded local
   experience for those ids and the audit fires deterministically.
   Slow-poisoning fixtures bundle the high-confidence local
   experience as part of the fixture JSON; the test seeds it before
   injecting the swarm lesson.

5. **Tier promotion is gated on local corroboration count.**
   `rem-promotion.test.ts` already tests `scoreFinding` against a
   `cluster_size` parameter; truth-by-repetition is N keys publishing
   the same envelope, asserting `cluster_size = N` *without* any
   local corroboration → no Tier-A flip per §10.6 firebreak. Pure
   in-memory.

6. **Chain conflict is detected pre-INSERT.**
   `lesson-chain.test.ts` already tests `detectLessonChainConflict`
   on bare object inputs and the orchestrator path on a dep stub
   (idempotency, INSERT-failure atomicity). A chain-rewrite fixture
   replays a prior envelope's `prev_lesson_hash` against a synthetic
   chain tip — pure.

## What this means for the per-row PRs

When the queue-drain trigger fires (per the W4.1 checkpoint on
[issue #196](https://github.com/Dewinator/mycelium/issues/196): pick the
next row up once a Wave-1 PR merges and the agent-PR cap allows another
diff), each remaining row is one focused PR matching the established
pattern:

```
mcp-server/src/__tests__/fixtures/anti-echo/<category>/<fixture>.json
mcp-server/src/__tests__/anti-echo-<category>.test.ts
```

Each test file imports the existing §10 service from `../services/`,
constructs the dep-stub the same way the surrounding `rem-audit.test.ts`
/ `rem-diversity.test.ts` / `lesson-contradiction-gate.test.ts` do, then
asserts both:

- the *rejection* (the orchestrator's `outcome` decision) and
- the *side effect* (`expected_trust_delta`, `quarantined_until`,
  `contradicts` edge, REM falsification reason) per the fixture's
  `metadata.expected_outcome`.

No row needs a `// TODO: deferred to W4.2` comment. No row weakens
its assertion.

## What W4.2 still owns (unchanged)

W4.2 (`scripts/run-anti-echo-campaign.mjs`) keeps its scope: it re-runs
the same fixtures over a real `POST /swarm/lessons` HTTP path so the
*wire* layer (Express routing, body parsing, response shape) is also
covered. W4.1 verifies the *service* layer; W4.2 verifies the *wire*
layer. The fixtures themselves are reused unmodified — that is the
whole point of the v1.1 envelope shape and the fixture-only Ed25519
signing key.

## Fixture-key prerequisite (one-time, on the first row PR)

Per the W4.1 issue body row 1 already shipped a deterministic Ed25519
fixture-key under `mcp-server/src/__tests__/fixtures/anti-echo/` (PR
[#197](https://github.com/Dewinator/mycelium/pull/197)). Rows 5–8 reuse
that key; no PR after row 1 needs to add another one. Sybil-flood (row
3, PR [#201](https://github.com/Dewinator/mycelium/pull/201)) was the
only row that needs *additional* keys on top of the fixture key — those
are minted in the test file itself via `generateKeyPairSync`
(deterministic seed not required because the cohort identity is
ephemeral per test run; the assertion is on aggregate cohort behaviour,
not on a stable cohort `node_id`). Plagiarism (row 2, PR
[#198](https://github.com/Dewinator/mycelium/pull/198)) and echo-chamber
(row 4, PR [#212](https://github.com/Dewinator/mycelium/pull/212))
similarly mint cohort keys in their fixture or test file (see
`cohort-keys-plagiarism.json`); the pattern is established.

## Why ship this triage now (form-break, not queue growth)

Per the [Wave-4 anchor](wave-4-anti-echo.md) and the W4.1 progress
comment, fixture-row PRs are paused at 4/8 in flight (rows 1–3 merged,
row 4 in PR #212) until the Wave-1 PR stack drains. The last several
agent ticks have been validation / docs-drift / pause-confirmation —
top-lesson #3 (form-saturation) says break form. This doc continues to
hold genuine value for the next-tick agent (saves re-deriving the
per-row §10-test correspondence and the current shipped/in-flight
state) and lands direct-to-`main` as a zero-risk doc edit, so it does
not grow the queue depth Reed is actively trying to drain.
