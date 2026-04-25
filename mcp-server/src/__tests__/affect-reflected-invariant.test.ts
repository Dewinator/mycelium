import { test } from "node:test";
import assert from "node:assert/strict";
import { recordExperienceSchema } from "../tools/experience.js";
import { digestSchema } from "../tools/digest.js";

// ---------------------------------------------------------------------------
// experiences.reflected client-input invariant
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §curiosity) reads `experiences.reflected` to compute cluster_gaps:
//
//   cluster_gaps = count(experiences WHERE NOT reflected
//                        AND created_at > now()-'48h')
//                / greatest(1, count(experiences WHERE created_at > now()-'48h'))
//
// `reflected` must only flip from FALSE → TRUE inside the SQL `record_lesson`
// RPC (migration 015), which is the canonical signal that an episode has
// been distilled into a lesson. If a client could initialize a brand-new
// experience with `reflected: true`, the §curiosity formula would treat it
// as already-distilled and zero out the cluster_gaps numerator — silently
// pinning curiosity at its baseline even when episodic backlog is real.
//
// The defense is layered:
//   1. The TS schemas (record_experience + digest) MUST NOT define a
//      `reflected` field.
//   2. Zod's default object-parse strips unknown keys, so a malicious or
//      buggy caller passing `reflected: true` through MCP gets it silently
//      dropped before reaching the service.
//
// This test pins both layers. If a future refactor adds `reflected` to
// either schema (e.g. "let's let clients mark old episodes reflected to
// avoid re-clustering"), this test fails loudly and forces a design
// conversation about the §curiosity term first.
// ---------------------------------------------------------------------------

test("recordExperienceSchema does not define a `reflected` field", () => {
  // Same defensive pattern as affect-tools-used-contract.test.ts: pin the
  // shape, not just the runtime parse, so that adding the field with any
  // wrapper (optional/default/effects) is caught by the type-level shape
  // inspection.
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      recordExperienceSchema.shape,
      "reflected"
    ),
    false,
    "recordExperienceSchema.shape must not contain `reflected` — see §curiosity"
  );
});

test("digestSchema does not define a `reflected` field", () => {
  // digest.ts builds the experienceService.record() argument object
  // explicitly (digest.ts ~line 119), so it does not currently propagate
  // any extra digest-input fields. Still, pin the schema directly: if a
  // future refactor switches to `service.record({ ...input })`, an unknown
  // `reflected` from the digest boundary would otherwise leak into the
  // service call.
  assert.equal(
    Object.prototype.hasOwnProperty.call(digestSchema.shape, "reflected"),
    false,
    "digestSchema.shape must not contain `reflected` — see §curiosity"
  );
});

test("recordExperienceSchema strips a stray `reflected` key from caller input", () => {
  // Defense-in-depth: even if a client sends an undeclared `reflected: true`
  // (e.g. an older MCP client speaking a future-shape API by mistake), Zod's
  // default strip behavior must drop it before the service layer sees it.
  // If a future refactor switches to .passthrough() / .strict() this test
  // catches the regression: passthrough would let `reflected` leak through;
  // strict would throw, which is *also* a behavior change worth a review.
  const parsed = recordExperienceSchema.parse({
    summary: "test episode",
    reflected: true,
  } as unknown as { summary: string });
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "reflected"),
    false,
    "parsed payload must not surface `reflected` — §curiosity relies on it being SQL-only"
  );
});

test("digestSchema strips a stray `reflected` key from caller input", () => {
  const parsed = digestSchema.parse({
    summary: "test digest",
    reflected: true,
  } as unknown as { summary: string });
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "reflected"),
    false,
    "parsed payload must not surface `reflected` — §curiosity relies on it being SQL-only"
  );
});
