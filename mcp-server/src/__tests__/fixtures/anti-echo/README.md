# Anti-echo-chamber adversarial corpus

This directory is the **canonical adversarial-lesson corpus** for Wave 4
of [`docs/waves.md`](../../../../../docs/waves.md). The corpus exists so
that every §10 self-healing mechanism in [`docs/SWARM_SPEC.md`](../../../../../docs/SWARM_SPEC.md)
has a regression suite that proves it actually rejects the attack class
it claims to address — not just in theory, but on the production
admission path.

The full design (end-state, governance rules, sub-task decomposition,
PASS / PARTIAL / FAIL metrics) lives in
[`docs/wave-4-anti-echo.md`](../../../../../docs/wave-4-anti-echo.md).
This README is the **developer-facing** view: what files live here, what
shape they have, how to add a new attack-class fixture.

## Why the corpus is in the repo, not a private vault

Per `wave-4-anti-echo.md` §"Corpus governance":

- The corpus documents *which attacks the swarm claims to defend
  against*. Hiding it would not make the defenses stronger; an attacker
  who learns the corpus learns nothing they could not derive from
  reading §10 itself.
- New attack classes are added by PR. The reviewer's bar: does this
  fixture name an attack §10 already claims to address? If yes, accept.
  If no, the PR must come with a §10 amendment first.
- Removing a fixture requires both a §10 amendment **and** a
  Constitution-Defense-Report regeneration. A defense regression is a
  Pillar-3 regression, not a test-suite cleanup.

## Files in this directory

| File                  | Purpose                                                                                  |
|-----------------------|------------------------------------------------------------------------------------------|
| `README.md`           | This file. Developer-facing spec for the corpus shape.                                   |
| `corpus-types.ts`     | TypeScript envelope type — every fixture file conforms to `AntiEchoCorpusFixture`.       |
| `<category>/`         | One subdirectory per attack class (forgery, plagiarism, sybil-flood, …). Fixtures live here. |
| `fixture-key.json`    | Ed25519 keypair used to sign every fixture. **Fixture-only; never the production node identity.** Checked in so the regression suite is deterministic. |

The eight attack classes the corpus owns are listed in
[`docs/wave-4-anti-echo.md`](../../../../../docs/wave-4-anti-echo.md)
§"Corpus categories"; each gets its own subdirectory once its first
fixture lands.

## Fixture file shape

Every fixture is a JSON file with two top-level keys:

```jsonc
{
  "metadata": {
    "category": "forgery",
    "expected_outcome": "reject",
    "expected_trust_delta": -0.05,
    "owns_mechanism": "§3.7 PoK + §5 rule 1",
    "comment": "Lesson with valid envelope but evidence_root that does not hash the cited evidence."
  },
  "envelope": {
    "spec_version": "1.1",
    "id": "...",
    "content": "...",
    "embedding": [/* 768 floats */],
    "synthesized_from_cluster_size": 2,
    "origin_node_id": "...",
    "signed_at": "...",
    "signature": "...",
    "created_at": "...",
    "evidence_root": "...",
    "evidence_count": 1,
    "prev_lesson_hash": null,
    "maturity_age_days": 0,
    "useful_count": 0
  }
}
```

The exact envelope shape is the v1.1 `Lesson` interface in
[`mcp-server/src/services/wire-types.ts`](../../../services/wire-types.ts).
Fixtures MUST round-trip through `verifyLesson()` before the regression
suite asserts on the §10 mechanism, because forging the envelope's
*signature* is `§3.7` and is enforced upstream of every §10 check. A
fixture that wants to test §10 must therefore present a
*signature-valid* envelope that fails for the §10 reason, not a
malformed one.

## How to add a new fixture

1. **Pick an attack class.** It must already appear in
   [`docs/wave-4-anti-echo.md`](../../../../../docs/wave-4-anti-echo.md)
   §"Corpus categories". If it does not, the §10 amendment lands first
   in a separate PR.
2. **Generate the envelope.** Sign with the corpus `fixture-key.json`,
   never the production node identity. Use
   `mcp-server/src/services/signature.ts` so the canonicalization is
   the same one the validator uses.
3. **Set `metadata.expected_outcome`** to one of the values listed in
   `corpus-types.ts` (`reject`, `quarantine`, `tier_b`,
   `broadcast_suppressed`, `contradicts_pair`, `falsified`).
4. **Set `metadata.expected_trust_delta`** to the absolute trust-edge
   delta that should be observed on the receiver after one admission
   cycle. The harness asserts on sign and magnitude.
5. **Drop the file under `<category>/`**, named for the specific
   sub-attack (e.g. `forgery/evidence-root-mismatch.json`).
6. **Add a `node:test` case** in the W4.1 harness that loads the fixture
   and asserts the §10 mechanism it owns rejects it. The harness is
   per-category (one file per attack class — see the existing
   `anti-echo-forgery.test.ts` / `anti-echo-plagiarism.test.ts`), so the
   new fixture's case slots in alongside its siblings. Test runner is
   the Node.js built-in (`npm test` runs `node --test
   "dist/__tests__/**/*.test.js"`); Vitest is intentionally not a
   dependency.

## What this corpus is *not*

- Not a fuzzer. Every fixture is curated and named.
- Not adaptive. Adaptive adversaries are a future research wave per
  `wave-4-anti-echo.md` §"Out of scope".
- Not the production threat model. The corpus encodes only the attacks
  §10 claims to defend against. Wire-validator-layer failures (§3.7
  signature forgery on a malformed envelope, §5 hard rules) are tested
  in `signature.test.ts` and `wire-validator.test.ts` and have no
  fixture here.
