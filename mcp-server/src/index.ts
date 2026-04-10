#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEmbeddingProvider } from "./services/embeddings.js";
import { MemoryService } from "./services/supabase.js";
import { rememberSchema, remember } from "./tools/remember.js";
import { recallSchema, recall } from "./tools/recall.js";
import { forgetSchema, forget } from "./tools/forget.js";
import { updateSchema, update } from "./tools/update.js";
import { listSchema, list } from "./tools/list.js";
import { importSchema, importMarkdown } from "./tools/import.js";
import {
  pinSchema,
  pin,
  introspectSchema,
  introspect,
  consolidateSchema,
  consolidate,
  forgetWeakSchema,
  forgetWeak,
  markUsefulSchema,
  markUseful,
  dedupSchema,
  dedup,
} from "./tools/cognitive.js";
import { ExperienceService } from "./services/experiences.js";
import {
  recordExperienceSchema,
  recordExperience,
  recallExperiencesSchema,
  recallExperiences,
  reflectSchema,
  reflect,
  recordLessonSchema,
  recordLesson,
  reinforceLessonSchema,
  reinforceLesson,
  promoteTraitSchema,
  promoteTrait,
  soulStateSchema,
  soulState,
  markExperienceUsefulSchema,
  markExperienceUseful,
  dedupLessonsSchema,
  dedupLessons,
  promotionCandidatesSchema,
  promotionCandidates,
} from "./tools/experience.js";
import {
  moodSchema, mood,
  setIntentionSchema, setIntention,
  recallIntentionsSchema, recallIntentions,
  updateIntentionStatusSchema, updateIntentionStatus,
  recallPersonSchema, recallPerson,
  findConflictsSchema, findConflicts,
  resolveConflictSchema, resolveConflict,
  synthesizeConflictSchema, synthesizeConflict,
  primeContextSchema, primeContext,
  narrateSelfSchema, narrateSelf,
} from "./tools/soul.js";
import { absorbSchema, absorb } from "./tools/absorb.js";
import { digestSchema, digest } from "./tools/digest.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!SUPABASE_KEY) {
  console.error(
    "SUPABASE_KEY is required. Set it as an environment variable or in your MCP server config."
  );
  process.exit(1);
}

const embeddings = createEmbeddingProvider();
const memoryService = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const experienceService = new ExperienceService(SUPABASE_URL, SUPABASE_KEY, embeddings);

const server = new McpServer({
  name: "vector-memory",
  version: "0.1.0",
});

/** Wrap tool handlers with error handling — returns MCP error response instead of crashing */
function withErrorHandling(
  fn: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>
) {
  return async (input: Record<string, unknown>) => {
    try {
      return await fn(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Tool error:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

server.tool(
  "remember",
  "Store a new memory with automatic embedding generation. Use for important facts, decisions, people info, or project details.",
  rememberSchema.shape,
  withErrorHandling((input) => remember(memoryService, rememberSchema.parse(input)))
);

server.tool(
  "absorb",
  "Low-friction learning: pass any text you picked up during conversation — a fact, preference, decision, person detail. The server auto-detects category, extracts tags, scores importance, checks for duplicates. USE THIS whenever you notice something worth remembering — don't wait to be asked.",
  absorbSchema.shape,
  withErrorHandling((input) => absorb(memoryService, absorbSchema.parse(input)))
);

server.tool(
  "recall",
  "Search memories using semantic similarity and keyword matching. Returns the most relevant memories for a query.",
  recallSchema.shape,
  withErrorHandling((input) => recall(memoryService, recallSchema.parse(input)))
);

server.tool(
  "forget",
  "Delete a specific memory by its UUID.",
  forgetSchema.shape,
  withErrorHandling((input) => forget(memoryService, forgetSchema.parse(input)))
);

server.tool(
  "update_memory",
  "Update an existing memory. If content changes, the embedding is automatically regenerated.",
  updateSchema.shape,
  withErrorHandling((input) => update(memoryService, updateSchema.parse(input)))
);

server.tool(
  "list_memories",
  "List stored memories, optionally filtered by category. Returns most recent first.",
  listSchema.shape,
  withErrorHandling((input) => list(memoryService, listSchema.parse(input)))
);

server.tool(
  "pin_memory",
  "Pin (or unpin) a memory so it is never soft-forgotten and gets a salience boost in recall.",
  pinSchema.shape,
  withErrorHandling((input) => pin(memoryService, pinSchema.parse(input)))
);

server.tool(
  "introspect_memory",
  "Inspect the cognitive state of a memory: strength, decay, access count, salience.",
  introspectSchema.shape,
  withErrorHandling((input) => introspect(memoryService, introspectSchema.parse(input)))
);

server.tool(
  "consolidate_memories",
  "Promote frequently-rehearsed episodic memories into the semantic stage (slower decay).",
  consolidateSchema.shape,
  withErrorHandling((input) => consolidate(memoryService, consolidateSchema.parse(input)))
);

server.tool(
  "mark_useful",
  "Signal that a recalled memory was actually used in an answer. Strongest learning signal — boosts strength substantially and increments useful_count.",
  markUsefulSchema.shape,
  withErrorHandling((input) => markUseful(memoryService, markUsefulSchema.parse(input)))
);

server.tool(
  "dedup_memories",
  "Cluster near-duplicate memories and merge them into the strongest representative. Co-activation links are transferred. Originals are archived.",
  dedupSchema.shape,
  withErrorHandling((input) => dedup(memoryService, dedupSchema.parse(input)))
);

server.tool(
  "forget_weak_memories",
  "Soft-forget memories whose effective strength has decayed below a threshold. Originals are archived, not deleted.",
  forgetWeakSchema.shape,
  withErrorHandling((input) => forgetWeak(memoryService, forgetWeakSchema.parse(input)))
);

// --- experience / soul layer ------------------------------------------------
server.tool(
  "record_experience",
  "Record an episodic experience: what happened, how hard it felt, what worked, what failed, and the emotional tone. Use after completing any non-trivial task — these episodes feed the agent's evolving 'soul'.",
  recordExperienceSchema.shape,
  withErrorHandling((input) => recordExperience(experienceService, recordExperienceSchema.parse(input)))
);

server.tool(
  "recall_experiences",
  "Semantic search over past episodes (and distilled lessons). Use before a task to surface 'have I been here before, and how did it go?'",
  recallExperiencesSchema.shape,
  withErrorHandling((input) => recallExperiences(experienceService, recallExperiencesSchema.parse(input)))
);

server.tool(
  "reflect",
  "REM-sleep step: find clusters of unreflected episodes that share a pattern. Returns clusters so you can synthesise a lesson per cluster via record_lesson.",
  reflectSchema.shape,
  withErrorHandling((input) => reflect(experienceService, reflectSchema.parse(input)))
);

server.tool(
  "record_lesson",
  "Store a synthesised lesson distilled from a cluster of episodes. Marks the source episodes as reflected.",
  recordLessonSchema.shape,
  withErrorHandling((input) => recordLesson(experienceService, recordLessonSchema.parse(input)))
);

server.tool(
  "reinforce_lesson",
  "Add new episodes to an existing lesson (when a recurring pattern shows up again).",
  reinforceLessonSchema.shape,
  withErrorHandling((input) => reinforceLesson(experienceService, reinforceLessonSchema.parse(input)))
);

server.tool(
  "promote_lesson_to_trait",
  "Graduate a well-evidenced lesson into a stable soul trait — part of the agent's enduring identity.",
  promoteTraitSchema.shape,
  withErrorHandling((input) => promoteTrait(experienceService, promoteTraitSchema.parse(input)))
);

server.tool(
  "soul_state",
  "Return a snapshot of the current 'soul': counts, success rate, drift, top lessons, traits, promotion candidates.",
  soulStateSchema.shape,
  withErrorHandling((input) => soulState(experienceService, soulStateSchema.parse(input)))
);

server.tool(
  "mark_experience_useful",
  "Strongest learning signal: this past experience actually informed a current decision. Increments useful_count.",
  markExperienceUsefulSchema.shape,
  withErrorHandling((input) => markExperienceUseful(experienceService, markExperienceUsefulSchema.parse(input)))
);

server.tool(
  "dedup_lessons",
  "Merge near-identical lessons. After several reflect runs, lessons can drift toward similar phrasings — this consolidates them.",
  dedupLessonsSchema.shape,
  withErrorHandling((input) => dedupLessons(experienceService, dedupLessonsSchema.parse(input)))
);

server.tool(
  "promotion_candidates",
  "List lessons that meet the threshold (sufficient evidence + confidence) for graduation into stable soul traits.",
  promotionCandidatesSchema.shape,
  withErrorHandling((input) => promotionCandidates(experienceService, promotionCandidatesSchema.parse(input)))
);

// --- soul layer (mood, intentions, people, conflicts, prime, narrate) -------
server.tool(
  "mood",
  "Return the agent's current emotional state, derived from recent experiences (rolling window).",
  moodSchema.shape,
  withErrorHandling((input) => mood(experienceService, moodSchema.parse(input)))
);

server.tool(
  "set_intention",
  "Declare a forward-looking goal in first person. Subsequent experiences that semantically match will automatically advance its progress.",
  setIntentionSchema.shape,
  withErrorHandling((input) => setIntention(experienceService, setIntentionSchema.parse(input)))
);

server.tool(
  "recall_intentions",
  "List or semantically search the agent's intentions (goals).",
  recallIntentionsSchema.shape,
  withErrorHandling((input) => recallIntentions(experienceService, recallIntentionsSchema.parse(input)))
);

server.tool(
  "update_intention_status",
  "Mark an intention as fulfilled, abandoned, or paused.",
  updateIntentionStatusSchema.shape,
  withErrorHandling((input) => updateIntentionStatus(experienceService, updateIntentionStatusSchema.parse(input)))
);

server.tool(
  "recall_person",
  "Return the relationship history with a specific person: encounters, success rate, mood mix, recent episodes.",
  recallPersonSchema.shape,
  withErrorHandling((input) => recallPerson(experienceService, recallPersonSchema.parse(input)))
);

server.tool(
  "find_conflicts",
  "Detect inner contradictions: pairs of active traits that are semantically close but polarity-opposed.",
  findConflictsSchema.shape,
  withErrorHandling((input) => findConflicts(experienceService, findConflictsSchema.parse(input)))
);

server.tool(
  "resolve_conflict",
  "Resolve a trait conflict by archiving the loser; the winner absorbs its evidence.",
  resolveConflictSchema.shape,
  withErrorHandling((input) => resolveConflict(experienceService, resolveConflictSchema.parse(input)))
);

server.tool(
  "synthesize_conflict",
  "Resolve a trait conflict by creating a new synthesised trait that supersedes both parents (which are archived).",
  synthesizeConflictSchema.shape,
  withErrorHandling((input) => synthesizeConflict(experienceService, synthesizeConflictSchema.parse(input)))
);

server.tool(
  "prime_context",
  "THE auto-prime entry point. Returns a complete first-person system-prompt prefix: current mood, identity traits, active intentions, inner tensions, and (if a task description is provided) semantically relevant past experiences and memories. Use this BEFORE starting any non-trivial task.",
  primeContextSchema.shape,
  withErrorHandling((input) => primeContext(experienceService, memoryService, primeContextSchema.parse(input)))
);

server.tool(
  "narrate_self",
  "Return a coherent first-person self-narration: who I am, what I want, what I have learned, who I am bonded with, what tensions I hold, and how fast I am evolving.",
  narrateSelfSchema.shape,
  withErrorHandling((input) => narrateSelf(experienceService, narrateSelfSchema.parse(input)))
);

server.tool(
  "digest",
  "END-OF-CONVERSATION soul development. Call this ONCE at the end of every conversation. It automatically: (1) records the experience, (2) stores extracted facts, (3) runs REM-sleep reflection to find patterns, (4) creates or reinforces lessons, (5) promotes mature lessons to soul traits, (6) consolidates memories. Pass a first-person summary of what happened, the outcome, and optionally facts you picked up. This is how the soul grows.",
  digestSchema.shape,
  withErrorHandling((input) => digest(experienceService, memoryService, digestSchema.parse(input)))
);

server.tool(
  "import_markdown",
  "Import existing openClaw markdown memory files into the vector database. Supports dry_run mode.",
  importSchema.shape,
  withErrorHandling((input) => importMarkdown(memoryService, importSchema.parse(input)))
);

async function main() {
  // Verify Supabase is reachable before accepting connections
  const dbHealthy = await memoryService.healthCheck();
  if (!dbHealthy) {
    console.error(
      "WARNING: Supabase is not reachable at " + SUPABASE_URL +
      ". Memory operations will fail until the database is available."
    );
  }

  // Verify Ollama is reachable
  try {
    await embeddings.embed("health check");
    console.error("Ollama embedding provider: OK");
  } catch (err) {
    console.error(
      "WARNING: Ollama is not reachable. Embedding generation will fail. " +
      "Ensure Ollama is running: ollama serve"
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vector-memory MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
