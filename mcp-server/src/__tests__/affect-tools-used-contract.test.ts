import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { recordExperienceSchema } from "../tools/experience.js";
import { digestSchema } from "../tools/digest.js";

// ---------------------------------------------------------------------------
// experiences.tools_used array-element contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §arousal) reads `experiences.tools_used` as a flat text[] in SQL:
//
//   tool_diversity = count(distinct tool in experiences.tools_used
//                          last 60min) / 10
//
// `count(distinct tool)` only works element-wise when the array contains
// scalar text entries. If the TS schema is silently widened to accept
// objects (e.g. z.array(z.object({ name: z.string() }))) or arbitrary
// values (z.array(z.any())), the column would receive structured/JSON-y
// blobs and the SQL DISTINCT count would either error at the array-cast
// boundary or silently collapse to 1 distinct value per row — zeroing
// out the arousal `tool_diversity` term without any test or type failure.
//
// Two schemas feed `experiences.tools_used`: record_experience (direct)
// and digest (passes input.tools_used straight through to the same
// service.record() call — see digest.ts line ~127). Pin both, plus pin
// that they remain a single source of truth.
// ---------------------------------------------------------------------------

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // record_experience's tools_used is z.array(z.string()).optional() and
  // digest's is the same with .describe() chained on. Walk through the
  // optional/default/effects wrappers until we hit the underlying ZodArray.
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 4; i++) {
    if (current instanceof z.ZodArray) return current;
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    break;
  }
  throw new Error(
    "expected ZodArray after unwrapping modifiers, got " +
      current.constructor.name
  );
}

// --- recordExperienceSchema.tools_used -------------------------------------

test("recordExperienceSchema.tools_used is an array of plain strings (text[] in SQL)", () => {
  const arr = unwrap(recordExperienceSchema.shape.tools_used);
  assert.ok(arr instanceof z.ZodArray, "tools_used must be a ZodArray");
  // The element type must be ZodString — anything else would mean the
  // column receives non-scalar entries and the §arousal count(distinct)
  // breaks element-wise.
  assert.ok(
    arr.element instanceof z.ZodString,
    `tools_used element must be ZodString, got ${arr.element.constructor.name}`
  );
});

test("recordExperienceSchema.tools_used is optional (omission is legal)", () => {
  // The service layer normalizes a missing tools_used to [] before the RPC
  // call (experiences.ts: `p_tools_used: input.tools_used ?? []`), so the
  // schema MUST allow omission for that fallback to ever fire. If a future
  // refactor makes tools_used required, the digest path's older callers
  // would break with a Zod validation error before reaching the service.
  const parsed = recordExperienceSchema.parse({ summary: "ok" });
  assert.equal(parsed.tools_used, undefined);
});

test("recordExperienceSchema.tools_used round-trips a flat string array unchanged", () => {
  // The §arousal formula counts DISTINCT entries, so case + ordering matter
  // semantically. Pin that Zod doesn't lowercase, dedup, or reorder them on
  // the way through.
  const parsed = recordExperienceSchema.parse({
    summary: "ok",
    tools_used: ["Recall", "Recall", "remember"],
  });
  assert.deepEqual(parsed.tools_used, ["Recall", "Recall", "remember"]);
});

test("recordExperienceSchema.tools_used rejects non-string elements", () => {
  // A silent widening (e.g. z.array(z.any())) would let nested objects or
  // numbers through, which would then hit the text[] column as JSON-encoded
  // blobs — silently breaking the §arousal DISTINCT count.
  assert.throws(() =>
    recordExperienceSchema.parse({
      summary: "ok",
      tools_used: [{ name: "recall" }] as unknown as string[],
    })
  );
  assert.throws(() =>
    recordExperienceSchema.parse({
      summary: "ok",
      tools_used: [42] as unknown as string[],
    })
  );
});

// --- digestSchema.tools_used -----------------------------------------------

test("digestSchema.tools_used has the same element type as recordExperienceSchema (single source of truth)", () => {
  // digest passes input.tools_used straight to experienceService.record()
  // (digest.ts line ~127). Drift between the two schemas would mean a value
  // shape that's legal at the digest boundary is illegal at the
  // record_experience boundary (or vice versa), and one of the two paths
  // would feed garbage into the §arousal column.
  const a = unwrap(recordExperienceSchema.shape.tools_used);
  const b = unwrap(digestSchema.shape.tools_used);
  assert.ok(a instanceof z.ZodArray, "record_experience tools_used must be a ZodArray");
  assert.ok(b instanceof z.ZodArray, "digest tools_used must be a ZodArray");
  assert.equal(
    (b as z.ZodArray<z.ZodTypeAny>).element.constructor.name,
    (a as z.ZodArray<z.ZodTypeAny>).element.constructor.name,
    "digest.tools_used element type drifted from record_experience.tools_used"
  );
});

test("digestSchema.tools_used round-trips a flat string array unchanged", () => {
  const parsed = digestSchema.parse({
    summary: "ok",
    tools_used: ["recall", "remember", "absorb"],
  });
  assert.deepEqual(parsed.tools_used, ["recall", "remember", "absorb"]);
});

test("digestSchema.tools_used rejects non-string elements (same as record_experience)", () => {
  assert.throws(() =>
    digestSchema.parse({
      summary: "ok",
      tools_used: [null] as unknown as string[],
    })
  );
});
