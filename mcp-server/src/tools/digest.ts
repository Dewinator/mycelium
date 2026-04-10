import { z } from "zod";
import type { ExperienceService } from "../services/experiences.js";
import type { MemoryService } from "../services/supabase.js";

/**
 * `digest` — the end-of-conversation soul development pipeline.
 *
 * One tool call replaces the entire manual workflow:
 *   1. Record the conversation as an experience
 *   2. Extract and store key facts as memories (via absorb-style auto-categorization)
 *   3. Run REM-sleep reflection (find experience clusters)
 *   4. Auto-reinforce existing lessons / auto-create new ones from clusters
 *   5. Check for promotion candidates and auto-promote mature lessons to traits
 *   6. Consolidate frequently-rehearsed memories (episodic → semantic)
 *   7. Return a comprehensive summary of what the soul learned
 *
 * This is THE tool that makes the soul develop organically. The agent calls it
 * once at conversation end, and the entire cognitive cycle runs automatically.
 */

export const digestSchema = z.object({
  summary: z
    .string()
    .describe(
      "What happened in this conversation — write in first person, as if reflecting in a journal. This is your narrative of the episode."
    ),
  outcome: z
    .enum(["success", "partial", "failure", "unknown"])
    .optional()
    .default("unknown")
    .describe("How did it go overall?"),
  person_name: z
    .string()
    .optional()
    .describe("Name of the human you interacted with (auto-resolved to existing person records)"),
  difficulty: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("How hard did this feel? 0 = trivial, 1 = extremely challenging"),
  user_sentiment: z
    .enum(["frustrated", "neutral", "pleased", "delighted", "angry"])
    .optional()
    .describe("How did the user seem to feel?"),
  facts: z
    .array(z.string())
    .optional()
    .describe(
      "Key facts learned during the conversation that should be stored as memories. Each should be a clear, standalone sentence."
    ),
  what_worked: z.string().optional().describe("What went well?"),
  what_failed: z.string().optional().describe("What didn't work or could be improved?"),
  task_type: z
    .string()
    .optional()
    .describe("e.g. refactor, debug, explain, implement, research, chat, planning"),
});

export async function digest(
  experienceService: ExperienceService,
  memoryService: MemoryService,
  input: z.infer<typeof digestSchema>
) {
  const report: string[] = [];
  report.push("# Digest Report\n");

  // =========================================================================
  // Step 1: Record the experience
  // =========================================================================
  let experienceId: string | null = null;
  try {
    const result = await experienceService.record({
      summary: input.summary,
      outcome: input.outcome,
      difficulty: input.difficulty,
      user_sentiment: input.user_sentiment,
      what_worked: input.what_worked,
      what_failed: input.what_failed,
      task_type: input.task_type,
      person_name: input.person_name,
      person_relationship: input.person_name ? "user" : undefined,
    });
    experienceId = result.id;
    const notes: string[] = [`recorded`];
    if (result.cross_links > 0) notes.push(`${result.cross_links} memory links`);
    if (result.intentions_touched > 0) notes.push(`${result.intentions_touched} intention(s) advanced`);
    if (result.person_id) notes.push(`person tracked`);
    report.push(`**Experience:** ${notes.join(", ")} [${input.outcome}]`);
  } catch (err) {
    report.push(`**Experience:** failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // =========================================================================
  // Step 2: Store extracted facts as memories
  // =========================================================================
  if (input.facts && input.facts.length > 0) {
    let stored = 0;
    let dupes = 0;
    for (const fact of input.facts) {
      try {
        const memory = await memoryService.create({
          content: fact,
          source: "digest",
        });
        // If source got overwritten, it was a duplicate (create returns existing)
        if (memory.source === "digest") {
          stored++;
        } else {
          dupes++;
        }
      } catch (err) {
        console.error("digest: fact storage failed (non-fatal):", err);
      }
    }
    report.push(`**Facts:** ${stored} stored, ${dupes} already known`);
  }

  // =========================================================================
  // Step 3: REM-sleep reflection — find clusters of unreflected episodes
  // =========================================================================
  let lessonsCreated = 0;
  let lessonsReinforced = 0;
  try {
    const clusters = await experienceService.findClusters(0.82, 2, 30);
    if (clusters.length > 0) {
      for (const cluster of clusters) {
        try {
          if (cluster.matched_lesson_id) {
            // Reinforce existing lesson with new evidence
            await experienceService.reinforceLesson(
              cluster.matched_lesson_id,
              cluster.member_ids
            );
            lessonsReinforced++;
          } else {
            // Create new lesson from the cluster's seed summary
            // Use a compact, first-person formulation
            const lessonText = `Ich habe gelernt: ${cluster.seed_summary}`;
            await experienceService.recordLesson(lessonText, cluster.member_ids, {
              confidence: 0.5 + Math.min(cluster.member_count * 0.05, 0.3),
            });
            lessonsCreated++;
          }
        } catch (err) {
          console.error("digest: lesson processing failed (non-fatal):", err);
        }
      }
      report.push(
        `**Reflection:** ${clusters.length} cluster(s) → ${lessonsCreated} new lesson(s), ${lessonsReinforced} reinforced`
      );
    } else {
      report.push(`**Reflection:** no clusters yet (need more unreflected episodes)`);
    }
  } catch (err) {
    report.push(`**Reflection:** skipped — ${err instanceof Error ? err.message : String(err)}`);
  }

  // =========================================================================
  // Step 4: Auto-promote mature lessons to traits
  // =========================================================================
  let promoted = 0;
  try {
    const candidates = await experienceService.promotionCandidates(3, 0.65);
    for (const c of candidates.slice(0, 3)) {
      try {
        // Auto-derive trait text and polarity from lesson
        const polarity = c.valence > 0.2 ? 0.5 : c.valence < -0.2 ? -0.5 : 0;
        await experienceService.promoteToTrait(c.id, c.lesson, polarity);
        promoted++;
      } catch (err) {
        console.error("digest: trait promotion failed (non-fatal):", err);
      }
    }
    if (promoted > 0) {
      report.push(`**Soul growth:** ${promoted} lesson(s) graduated to trait(s)`);
    }
  } catch (err) {
    // Non-fatal: promotion is a bonus
    console.error("digest: promotion check failed (non-fatal):", err);
  }

  // =========================================================================
  // Step 5: Consolidate frequently-accessed memories (episodic → semantic)
  // =========================================================================
  try {
    const consolidated = await memoryService.consolidate(3, 1);
    if (consolidated > 0) {
      report.push(`**Memory consolidation:** ${consolidated} memories promoted to semantic stage`);
    }
  } catch (err) {
    // Non-fatal
    console.error("digest: consolidation failed (non-fatal):", err);
  }

  // =========================================================================
  // Step 6: Get current soul snapshot for the summary
  // =========================================================================
  try {
    const mood = await experienceService.mood(24);
    report.push(`\n**Current mood:** ${mood.label} (valence=${mood.valence.toFixed(2)}, arousal=${mood.arousal.toFixed(2)}, ${mood.n} episodes/24h)`);
  } catch {
    // Non-fatal
  }

  // Final summary line
  const actions = [
    experienceId ? "1 experience" : null,
    input.facts?.length ? `${input.facts.length} facts` : null,
    lessonsCreated > 0 ? `${lessonsCreated} new lessons` : null,
    lessonsReinforced > 0 ? `${lessonsReinforced} reinforced lessons` : null,
    promoted > 0 ? `${promoted} new traits` : null,
  ].filter(Boolean);

  report.push(`\n---\n*Digested: ${actions.join(", ") || "experience recorded"}*`);

  return {
    content: [{ type: "text" as const, text: report.join("\n") }],
  };
}
