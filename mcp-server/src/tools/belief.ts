import { z } from "zod";
import type { BeliefService } from "../services/belief.js";
import { BeliefService as BeliefServiceClass } from "../services/belief.js";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService } from "../services/affect.js";
import type { NeurochemistryService } from "../services/neurochemistry.js";

/**
 * `infer_action` — Active Inference decision for "what should I do next?"
 *
 * Pipeline:
 *   1. Cheap recall to measure task familiarity (best effective_score + hit count).
 *   2. Hand those to the PyMDP sidecar which picks between recall / research /
 *      ask_teacher by minimising Expected Free Energy.
 *   3. Project the sidecar's decision back into the agent's affective state:
 *      'unknown' → curiosity↑; recall-heavy outcome → recall_rich; etc.
 *
 * Belief inference is *advisory*. If the sidecar is down, `BeliefService.fallback`
 * provides a rule-of-thumb answer so the tool never hard-fails.
 */

export const inferActionSchema = z.object({
  task_description: z
    .string()
    .describe(
      "What you are about to do. Kept short (it's used both as the recall query and for logging)."
    ),
  category: z
    .enum(["general", "people", "projects", "topics", "decisions"])
    .optional()
    .describe("Optional category filter for the recall probe."),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export async function inferAction(
  memory: MemoryService,
  belief: BeliefService,
  affect: AffectService,
  neurochem: NeurochemistryService,
  genomeLabel: string,
  input: z.infer<typeof inferActionSchema>
) {
  // ---- Step 1: recall probe --------------------------------------------
  const hits = await memory.search(
    input.task_description,
    input.category,
    input.limit,
    0.7
  );
  const topScore = hits[0]?.effective_score ?? 0;
  // Observability: feed the `recalled` stream that compute_affect() will
  // consume (docs/affect-observables.md).
  void memory.emitRecalled(hits.length, topScore, input.task_description.length, "mcp:infer_action");

  // ---- Step 1b: fetch current serotonin (modulates ask_teacher_cost) ---
  let serotonin: number | undefined;
  try {
    const nc = await neurochem.get(genomeLabel);
    if (nc.exists) serotonin = nc.serotonin.current;
  } catch { /* sidecar down or row missing — degrade to static costs */ }

  // ---- Step 2: ask the sidecar -----------------------------------------
  const remote = await belief.infer(input.task_description, topScore, hits.length, serotonin);
  const result = remote ?? BeliefServiceClass.fallback(topScore, hits.length);
  const source = remote ? "pymdp" : "fallback";

  // ---- Step 3: affect coupling -----------------------------------------
  // Empty recall → curiosity↑; unknown state → curiosity↑; known + recall → confirms rich recall.
  if (hits.length === 0) {
    void affect.apply("recall_empty", 0.4);
  } else if (result.state === "known" && result.action === "recall") {
    void affect.apply("recall_rich", 0.3);
  } else if (result.state === "unknown") {
    void affect.apply("unknown", 0.5);
  }

  const [pK, pP, pU] = result.state_prior;
  const serotoninLine = serotonin != null
    ? `5-HT=${serotonin.toFixed(2)} → ask_teacher_cost ×${(1.5 - serotonin).toFixed(2)}`
    : "5-HT unavailable → static action costs";
  const text =
    `Task: "${input.task_description}"\n` +
    `Recall probe: ${hits.length} hit(s), top score=${topScore.toFixed(3)}\n` +
    `Neurochemistry: ${serotoninLine}\n` +
    `Belief (${source}): state=${result.state}  [known=${pK.toFixed(2)} partial=${pP.toFixed(2)} unknown=${pU.toFixed(2)}]\n` +
    `Epistemic value (H): ${result.epistemic_value.toFixed(3)}\n` +
    `Recommended action: **${result.action}**\n` +
    `Rationale: ${result.rationale}`;

  return { content: [{ type: "text" as const, text }] };
}
