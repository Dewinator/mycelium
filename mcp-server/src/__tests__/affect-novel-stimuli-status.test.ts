import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { listStimuliSchema } from "../tools/motivation.js";

// ---------------------------------------------------------------------------
// stimuli.status enum — `new` literal contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §arousal) reads `stimuli.status='new'` as an exact-string filter to
// compute the novel-stimuli component of arousal:
//
//   novel_stimuli = count(stimuli WHERE status='new'
//                                 AND collected_at > now()-'6h') / 20
//   arousal = clamp(0.5 * min(event_rate, 1.0)
//                 + 0.3 * min(tool_diversity, 1.0)
//                 + 0.2 * min(novel_stimuli, 1.0))
//
// `listStimuliSchema.status` is the only place in the TypeScript MCP
// surface that enumerates the valid `stimuli.status` values. A silent
// rename here (e.g. `"new"` → `"fresh"`) would type-check, would not
// break any existing handler test (they don't pass status='new'
// explicitly), and would not surface in the motivation_stats RPC either
// — but it would silently zero out the `novel_stimuli` term of arousal
// the moment the sidecar starts writing the renamed value into the
// stimuli table. The arousal formula would then sit at most at
// 0.5 * event_rate + 0.3 * tool_diversity, losing 20% of its dynamic
// range without any failing test.
//
// Pin the literal so any rename forces a deliberate, paired update of
// the SQL spec, the migration, and the sidecar.
// ---------------------------------------------------------------------------

function unwrapEnum(schema: z.ZodTypeAny): readonly string[] {
  // listStimuliSchema.status is z.enum([...]).optional() — walk past the
  // ZodOptional / ZodDefault wrappers until we reach the underlying
  // ZodEnum, mirroring the helper used in affect-enum-contracts.test.ts.
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 4; i++) {
    if (current instanceof z.ZodEnum) return current.options as readonly string[];
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
    "expected ZodEnum after unwrapping modifiers, got " + current.constructor.name
  );
}

test("listStimuliSchema.status enum contains the 'new' literal compute_affect §arousal reads", () => {
  // novel_stimuli numerator =
  //   count(stimuli WHERE status='new' AND collected_at > now()-'6h')
  // If 'new' disappears from this enum the §arousal term silently
  // collapses to 0 — symptom: arousal stuck below ~0.8 even during a
  // burst of fresh external stimuli.
  const opts = new Set(unwrapEnum(listStimuliSchema.shape.status));
  assert.ok(
    opts.has("new"),
    "stimuli.status enum missing 'new' — breaks arousal.novel_stimuli numerator"
  );
});

test("listStimuliSchema.status enum is exactly the 5 lifecycle values currently produced", () => {
  // Pin the full membership so a rename or addition forces an explicit
  // review of the formula spec. The lifecycle is: new → scored →
  // task_generated → (acted | dismissed). compute_affect only reads
  // 'new' today, but a future tuning pass might split novel_stimuli into
  // a weighted progression across the lifecycle, so we pin the whole
  // set rather than only the one literal we currently consume.
  const opts = [...unwrapEnum(listStimuliSchema.shape.status)].sort();
  assert.deepEqual(opts, ["acted", "dismissed", "new", "scored", "task_generated"]);
});

test("listStimuliSchema.status 'new' is a non-empty lowercase token (matches SQL convention)", () => {
  // The spec doc and migration convention use lowercase string literals
  // in WHERE clauses (`status='new'`). A drift to 'New' or 'NEW' would
  // silently miss the case-sensitive equality filter. Pin the casing
  // expectation explicitly so an over-zealous "consistency" rename
  // can't slip through.
  const opts = unwrapEnum(listStimuliSchema.shape.status);
  const literal = opts.find((v) => v === "new");
  assert.equal(literal, "new");
  assert.ok(literal!.length > 0);
  assert.match(literal!, /^[a-z][a-z0-9_]*$/);
});

test("listStimuliSchema.status accepts 'new' through Zod parse (round-trip)", () => {
  // Defensive: a future maintainer might wrap the enum in a transform
  // that lowercases / normalises input. The §arousal SQL filter uses
  // exact-string equality on the raw column value, so the wire string
  // must round-trip unchanged from MCP input through Zod.
  const parsed = listStimuliSchema.parse({ status: "new" });
  assert.equal(parsed.status, "new");
});

test("listStimuliSchema.status keeps 'new' distinct from the other lifecycle states", () => {
  // Sanity: the lifecycle values must remain pairwise distinct so that
  // §arousal's novel_stimuli term can isolate freshly-collected stimuli
  // from already-processed ones. A copy-paste edit that aliased 'new'
  // to one of the post-processing states would silently inflate
  // novel_stimuli with old, already-acted-on rows.
  const opts = unwrapEnum(listStimuliSchema.shape.status);
  assert.equal(new Set(opts).size, opts.length, "stimuli.status enum has duplicates");
});
