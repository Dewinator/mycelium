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
import { findToolSchema, findTool } from "./tools/find_tool.js";
import { RelationsService } from "./services/relations.js";
import {
  chainSchema, chain,
  whySchema, why,
  historySchema, history,
  neighborsSchema, neighbors,
  supersedeSchema, supersede,
} from "./tools/relations.js";
import { patternsSchema, patterns } from "./tools/patterns.js";
import { markUsedInResponseSchema, markUsedInResponse } from "./tools/cite.js";
import { AgentEventBus } from "./agents/event-bus.js";
import { CoactivationAgent } from "./agents/coactivation-agent.js";
import { SalienceReactor } from "./agents/salience-reactor.js";
import { ConscienceAgent } from "./agents/conscience-agent.js";
import { ProjectService } from "./services/projects.js";
import {
  createProjectSchema, createProject,
  listProjectsSchema, listProjects,
  getProjectSchema, getProject,
  projectBriefSchema, projectBrief,
  setActiveProjectSchema, setActiveProject,
  updateProjectStatusSchema, updateProjectStatus,
  linkToProjectSchema, linkToProject,
} from "./tools/projects.js";
import { AffectService } from "./services/affect.js";
import {
  getAffectSchema, getAffect,
  updateAffectSchema, updateAffect,
  resetAffectSchema, resetAffect,
} from "./tools/affect.js";
import { BeliefService } from "./services/belief.js";
import { inferActionSchema, inferAction } from "./tools/belief.js";
import { CausalService } from "./services/causal.js";
import { SkillsService } from "./services/skills.js";
import {
  suggestCausesSchema, suggestCauses,
  recordCauseSchema, recordCause,
  causalChainSchema, causalChain,
} from "./tools/causal.js";
import {
  recommendSkillSchema, recommendSkill,
  skillStatsSchema, skillStats,
} from "./tools/skills.js";
import { MotivationService } from "./services/motivation.js";
import {
  motivationStatusSchema, motivationStatus,
  listStimuliSchema, listStimuli,
  listGeneratedTasksSchema, listGeneratedTasks,
  approveGeneratedTaskSchema, approveGeneratedTask,
  dismissGeneratedTaskSchema, dismissGeneratedTask,
  updateGeneratedTaskStatusSchema, updateGeneratedTaskStatus,
  triggerMotivationCycleSchema, triggerMotivationCycle,
  driftScanSchema, driftScan,
} from "./tools/motivation.js";
import { IdentityService } from "./services/identity.js";
import { RegistryService } from "./services/registry.js";
import { GuardService } from "./services/guard.js";
import { NeurochemistryService } from "./services/neurochemistry.js";
import { FederationService } from "./services/federation.js";
import {
  neurochemUpdateSchema, neurochemUpdate,
  neurochemGetSchema, neurochemGet,
  neurochemGetCompatSchema, neurochemGetCompat,
  neurochemRecallParamsSchema, neurochemRecallParams,
  neurochemHorizonSchema, neurochemHorizon,
  neurochemHistorySchema, neurochemHistory,
  neurochemResetSchema, neurochemReset,
} from "./tools/neurochemistry.js";
import {
  trustAddSchema, trustAdd,
  trustListSchema, trustList,
  trustRevokeSchema, trustRevoke,
  federationExportSchema, federationExport,
  federationImportSchema, federationImport,
  federationRecentSchema, federationRecent,
  federationPullSchema, federationPull,
  federationPushSchema, federationPush,
  federationSyncRevocationsSchema, federationSyncRevocations,
  peerUpsertSchema, peerUpsert,
  peersListSchema, peersList,
} from "./tools/federation.js";
import {
  classifyContentSchema, classifyContent,
  guardStatusSchema, guardStatus,
} from "./tools/guard.js";
import {
  getSelfModelSchema, getSelfModel,
  updateSelfModelSchema, updateSelfModel,
  listAgentsSchema, listAgents,
  snapshotFitnessSchema, snapshotFitness,
  breedAgentsSchema, breedAgents,
  genomeInheritanceSchema, genomeInheritance,
  collectCurrentKnowledgeSchema, collectCurrentKnowledge,
  flagEmergenceSchema, flagEmergence,
  listEmergenceSchema, listEmergence,
  resolveEmergenceSchema, resolveEmergence,
  tinderInbreedingCheckSchema, tinderInbreedingCheck,
  tinderCardsSchema, tinderCards,
  tinderPopulationHealthSchema, tinderPopulationHealth,
  tinderRefreshProfileSchema, tinderRefreshProfile,
  genomeKeygenSchema, genomeKeygen,
  genomeSignProfileSchema, genomeSignProfile,
  genomeRefreshMerkleSchema, genomeRefreshMerkle,
  genomeVerifySchema, genomeVerify,
  revocationIssueSchema, revocationIssue,
} from "./tools/identity.js";

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
const affectService = new AffectService(SUPABASE_URL, SUPABASE_KEY);
const beliefService = new BeliefService(
  process.env.BELIEF_URL ?? "http://127.0.0.1:18790",
  parseInt(process.env.BELIEF_TIMEOUT_MS ?? "4000", 10)
);
const causalService = new CausalService(SUPABASE_URL, SUPABASE_KEY);
const skillsService = new SkillsService(SUPABASE_URL, SUPABASE_KEY);
const projectService = new ProjectService(SUPABASE_URL, SUPABASE_KEY);
const motivationService = new MotivationService(
  SUPABASE_URL,
  SUPABASE_KEY,
  process.env.MOTIVATION_URL ?? "http://127.0.0.1:18792",
  parseInt(process.env.MOTIVATION_TIMEOUT_MS ?? "4000", 10)
);
const identityService = new IdentityService(SUPABASE_URL, SUPABASE_KEY);
const guardService = new GuardService(
  process.env.GUARD_URL ?? "http://127.0.0.1:18793",
  parseInt(process.env.GUARD_TIMEOUT_MS ?? "8000", 10)
);
const neurochemistryService = new NeurochemistryService(SUPABASE_URL, SUPABASE_KEY);
const relationsService      = new RelationsService(SUPABASE_URL, SUPABASE_KEY);
const federationService = new FederationService(
  SUPABASE_URL,
  SUPABASE_KEY,
  guardService,
  process.env.OPENCLAW_HOST_ID ?? "self"
);

// --- agent registry: diese MCP-Instanz registriert sich als 'agent' ---------
// Label default = 'main' (der produktive Agent). Weitere Instanzen setzen
// OPENCLAW_AGENT_LABEL bzw. OPENCLAW_GENOME_LABEL explizit in ihrer MCP-Config.
import { homedir as _homedir } from "node:os";
import { join as _join } from "node:path";
const AGENT_LABEL     = process.env.OPENCLAW_AGENT_LABEL    ?? "main";
const GENOME_LABEL    = process.env.OPENCLAW_GENOME_LABEL   ?? AGENT_LABEL;
const WORKSPACE_PATH  = process.env.OPENCLAW_WORKSPACE_PATH ?? _join(_homedir(), ".openclaw", "workspace");
const registryService = new RegistryService(SUPABASE_URL, SUPABASE_KEY, {
  label:         AGENT_LABEL,
  genomeLabel:   GENOME_LABEL,
  workspacePath: WORKSPACE_PATH,
  version:       "0.1.0",
  gatewayUrl:    process.env.OPENCLAW_GATEWAY_URL ?? undefined,
  ports: {
    gateway:    parseInt(process.env.OPENCLAW_GATEWAY_PORT    ?? "18789", 10),
    belief:     parseInt(process.env.OPENCLAW_BELIEF_PORT     ?? "18790", 10),
    motivation: parseInt(process.env.OPENCLAW_MOTIVATION_PORT ?? "18792", 10),
    dashboard:  parseInt(process.env.OPENCLAW_DASHBOARD_PORT  ?? "8787",  10),
    cockpit:    parseInt(process.env.OPENCLAW_COCKPIT_PORT    ?? "8767",  10),
  },
  capabilities: (process.env.OPENCLAW_CAPABILITIES ?? "memory,soul,motivation,belief,sleep").split(","),
  metadata: {
    started_at: new Date().toISOString(),
    registered_by: "mcp-server",
  },
});

const server = new McpServer({
  name: "vector-memory",
  version: "0.1.0",
});

// -------------------------------------------------------------------------
// Tool-Profile-Filter
//
// Small local models (7-8B) collapse under the full 90-tool schema (~18k
// tokens of pure tool declaration). This filter lets us expose a focused
// subset by setting OPENCLAW_TOOL_PROFILE. The server still runs all tool
// handlers — only the registration (what the model sees in its schema) is
// scoped. Full server is untouched for Codex/Claude instances.
//
//   full (default) — all 90+ tools
//   core           — 6 tools covering the complete agent workflow
//   core-plus      — core + engram-inspired memory-graph reasoning tools
//                    (chain / why / memory_history / memory_neighbors /
//                    memory_patterns / mark_used_in_response).
//                    Target: mid-size capable models (Claude, GPT-4-class)
//                    running inside OpenClaw — big enough to use relation
//                    tools, small enough to not want the full federation /
//                    genome / tinder surface.
//
// Additional profiles can be added as the Small-Model-Middleware roadmap
// (see issues #N1–#N9) materialises.
// -------------------------------------------------------------------------
const TOOL_PROFILE = (process.env.OPENCLAW_TOOL_PROFILE ?? "full").toLowerCase();

const CORE_TOOLS = [
  "prime_context",
  "recall",
  "remember",
  "absorb",
  "digest",
  "update_affect",
];

const CORE_PLUS_TOOLS = [
  ...CORE_TOOLS,
  // Migration 046-049 — memory-graph reasoning
  "chain",
  "why",
  "memory_history",
  "memory_neighbors",
  "supersede_memory",
  "memory_patterns",
  "mark_used_in_response",
];

const TOOL_PROFILES: Record<string, Set<string>> = {
  full:        new Set<string>(),   // empty = everything
  all:         new Set<string>(),   // alias
  core:        new Set<string>(CORE_TOOLS),
  "core-plus": new Set<string>(CORE_PLUS_TOOLS),
};

const _allowedTools = TOOL_PROFILES[TOOL_PROFILE];
const _filterActive = _allowedTools !== undefined && _allowedTools.size > 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _origTool: any = (server as any).tool.bind(server);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(server as any).tool = function (name: string, ...rest: any[]): unknown {
  if (_filterActive && !_allowedTools.has(name)) {
    return undefined;   // silently skip registration
  }
  return _origTool(name, ...rest);
};

console.error(
  `[tool-profile] OPENCLAW_TOOL_PROFILE=${TOOL_PROFILE}` +
    (_filterActive
      ? `  (registering ${_allowedTools.size} tools: ${[..._allowedTools].join(", ")})`
      : "  (registering all tools)"),
);

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
  withErrorHandling((input) => remember(memoryService, affectService, projectService, AGENT_LABEL, rememberSchema.parse(input)))
);

server.tool(
  "absorb",
  "Low-friction learning: pass any text you picked up during conversation — a fact, preference, decision, person detail. The server auto-detects category, extracts tags, scores importance, checks for duplicates, and — when the text carries real emotion — ALSO auto-records a lightweight experience so the soul layer fills up organically without waiting for digest. USE THIS whenever you notice something worth remembering — don't wait to be asked.",
  absorbSchema.shape,
  withErrorHandling((input) => absorb(memoryService, experienceService, affectService, projectService, AGENT_LABEL, absorbSchema.parse(input)))
);

server.tool(
  "recall",
  "Search memories using semantic similarity and keyword matching. Returns the most relevant memories for a query. Biased by the agent's current affective state (high frustration widens search, high satisfaction narrows it) — pass ignore_affect=true to disable. Pass cite=true when the retrieved memories will actually inform the response — that emits `used_in_response` events so the CoactivationAgent Hebbian-links them pairwise.",
  recallSchema.shape,
  withErrorHandling((input) => recall(memoryService, affectService, recallSchema.parse(input)))
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
  withErrorHandling((input) => recordExperience(experienceService, neurochemistryService, projectService, GENOME_LABEL, AGENT_LABEL, recordExperienceSchema.parse(input)))
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
  withErrorHandling((input) => recordLesson(experienceService, neurochemistryService, projectService, GENOME_LABEL, AGENT_LABEL, recordLessonSchema.parse(input)))
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
  withErrorHandling((input) => setIntention(experienceService, projectService, AGENT_LABEL, setIntentionSchema.parse(input)))
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
  "THE auto-prime entry point. Returns a complete first-person system-prompt prefix: current mood, identity traits, active intentions, inner tensions, (if task_description is provided) semantically relevant past experiences and memories, AND (if task_type is provided) the skills that have historically worked best for that kind of task. Use this BEFORE starting any non-trivial task.",
  primeContextSchema.shape,
  withErrorHandling((input) => primeContext(experienceService, memoryService, skillsService, primeContextSchema.parse(input)))
);

server.tool(
  "narrate_self",
  "Return a coherent first-person self-narration: who I am, what I want, what I have learned, who I am bonded with, what tensions I hold, and how fast I am evolving.",
  narrateSelfSchema.shape,
  withErrorHandling((input) => narrateSelf(experienceService, GENOME_LABEL, narrateSelfSchema.parse(input)))
);

server.tool(
  "digest",
  "END-OF-CONVERSATION soul development. Call this ONCE at the end of every conversation. It automatically: (1) records the experience, (2) stores extracted facts, (3) runs REM-sleep reflection to find patterns, (4) creates or reinforces lessons, (5) promotes mature lessons to soul traits, (6) consolidates memories, (7) updates the agent's affective state from the outcome, (8) tracks skill performance per task_type from tools_used, (9) auto-ingests plausible causal edges to prior experiences. Pass a first-person summary, outcome, optional facts, and especially `tools_used` + `task_type` so the learning loop fills up.",
  digestSchema.shape,
  withErrorHandling((input) => digest(experienceService, memoryService, affectService, causalService, skillsService, neurochemistryService, GENOME_LABEL, digestSchema.parse(input)))
);

// --- affective state layer --------------------------------------------------
server.tool(
  "get_affect",
  "Return the agent's current persistent affective state (curiosity, frustration, satisfaction, confidence) and the recall bias it currently imposes. Unlike `mood` (which is derived from recent experiences), this is a proper regulator with decay and event-driven updates.",
  getAffectSchema.shape,
  withErrorHandling((input) => getAffect(affectService, getAffectSchema.parse(input)))
);

server.tool(
  "update_affect",
  "Nudge the persistent affective state. Prefer letting remember/recall/digest update it implicitly — call this only when you have an explicit signal that the automated hooks missed (e.g. the user loudly praised or scolded, a task outcome you didn't run through digest).",
  updateAffectSchema.shape,
  withErrorHandling((input) => updateAffect(affectService, updateAffectSchema.parse(input)))
);

server.tool(
  "reset_affect",
  "Reset the persistent affective state to defaults (all 0.5 except frustration=0). Use sparingly — this wipes regulator history.",
  resetAffectSchema.shape,
  withErrorHandling((input) => resetAffect(affectService, resetAffectSchema.parse(input)))
);

// --- causal annotation layer -----------------------------------------------
server.tool(
  "suggest_causes",
  "Find plausible causes for a given experience by semantic similarity + time-window. Returns CANDIDATES — confirm with record_cause to turn one into a recorded edge.",
  suggestCausesSchema.shape,
  withErrorHandling((input) => suggestCauses(causalService, suggestCausesSchema.parse(input)))
);

server.tool(
  "record_cause",
  "Record an explicit causal link between two experiences (cause_id → effect_id). Relation ∈ {caused, enabled, prevented, contributed}. Idempotent — re-recording the same edge strengthens its confidence + evidence_count. Use when you (or the user) confirm that one episode led to another.",
  recordCauseSchema.shape,
  withErrorHandling((input) => recordCause(causalService, recordCauseSchema.parse(input)))
);

server.tool(
  "causal_chain",
  "Walk the causal graph from a root experience. direction='causes' shows what led up to it (backwards), 'effects' shows what came from it (forwards). Depth-limited BFS with cumulative path confidence.",
  causalChainSchema.shape,
  withErrorHandling((input) => causalChain(causalService, causalChainSchema.parse(input)))
);

// --- skill-performance tracking --------------------------------------------
server.tool(
  "recommend_skill",
  "Ask which skill has historically worked best for a given task_type (e.g. 'refactor', 'debug', 'implement', 'research', 'planning'). Uses Laplace-smoothed success rate × evidence. Use BEFORE picking which of your many skills to invoke.",
  recommendSkillSchema.shape,
  withErrorHandling((input) => recommendSkill(skillsService, recommendSkillSchema.parse(input)))
);

server.tool(
  "skill_stats",
  "Aggregate performance snapshot across all skills and task types. For introspection.",
  skillStatsSchema.shape,
  withErrorHandling((input) => skillStats(skillsService, skillStatsSchema.parse(input)))
);

// --- active inference (PyMDP sidecar) --------------------------------------
server.tool(
  "infer_action",
  "Active-Inference decision: given a task description, probe the vector memory, then ask the PyMDP belief sidecar whether to recall (exploit known), research (explore), or ask_teacher (delegate). Minimises Expected Free Energy = pragmatic_value + epistemic_value + action_cost. Use BEFORE starting any non-trivial task to decide whether to lean on memory or escalate. Falls back to a simple rule-of-thumb if the sidecar is down.",
  inferActionSchema.shape,
  withErrorHandling((input) => inferAction(memoryService, beliefService, affectService, neurochemistryService, GENOME_LABEL, inferActionSchema.parse(input)))
);

server.tool(
  "import_markdown",
  "Import existing openClaw markdown memory files into the vector database. Supports dry_run mode.",
  importSchema.shape,
  withErrorHandling((input) => importMarkdown(memoryService, importSchema.parse(input)))
);

// --- motivation engine (Ebene 4) -------------------------------------------
server.tool(
  "motivation_status",
  "Return a snapshot of the motivation engine: sidecar health, last cycle, stimuli/task counts by band/status. Use when the user asks what the agent has been noticing, or before approving generated tasks.",
  motivationStatusSchema.shape,
  withErrorHandling((input) => motivationStatus(motivationService, motivationStatusSchema.parse(input)))
);

server.tool(
  "list_stimuli",
  "List recently collected external stimuli (HackerNews, RSS, git activity, …) with their relevance band. Pass band='act' or 'urgent' to see only things the agent thinks are worth acting on.",
  listStimuliSchema.shape,
  withErrorHandling((input) => listStimuli(motivationService, listStimuliSchema.parse(input)))
);

server.tool(
  "list_generated_tasks",
  "List tasks the agent has generated from high-relevance stimuli. Filter by status (proposed/approved/dismissed/in_progress/done/abandoned).",
  listGeneratedTasksSchema.shape,
  withErrorHandling((input) => listGeneratedTasks(motivationService, listGeneratedTasksSchema.parse(input)))
);

server.tool(
  "approve_generated_task",
  "Approve a proposed task (from list_generated_tasks) so it enters the agent's active queue. Use when the user (or you) confirms the task is actually worth doing.",
  approveGeneratedTaskSchema.shape,
  withErrorHandling((input) => approveGeneratedTask(motivationService, approveGeneratedTaskSchema.parse(input)))
);

server.tool(
  "dismiss_generated_task",
  "Dismiss a proposed task so the drift detector stops escalating it. Use when the task is off-topic or already handled.",
  dismissGeneratedTaskSchema.shape,
  withErrorHandling((input) => dismissGeneratedTask(motivationService, dismissGeneratedTaskSchema.parse(input)))
);

server.tool(
  "update_generated_task_status",
  "Move a generated task to any status (proposed/approved/dismissed/in_progress/done/abandoned). Resets drift when leaving 'proposed'.",
  updateGeneratedTaskStatusSchema.shape,
  withErrorHandling((input) => updateGeneratedTaskStatus(motivationService, updateGeneratedTaskStatusSchema.parse(input)))
);

server.tool(
  "trigger_motivation_cycle",
  "Manually trigger one motivation cycle (collect → score → generate → drift) in the sidecar. Normally the sidecar runs hourly on its own. `force=true` ignores the per-source interval gate.",
  triggerMotivationCycleSchema.shape,
  withErrorHandling((input) => triggerMotivationCycle(motivationService, triggerMotivationCycleSchema.parse(input)))
);

server.tool(
  "drift_scan",
  "Recompute drift_score for all dormant 'proposed' tasks. Tasks that sit idle too long develop urgency and should be surfaced.",
  driftScanSchema.shape,
  withErrorHandling((input) => driftScan(motivationService, driftScanSchema.parse(input)))
);

// --- identity & evolution (Ebene 5) ----------------------------------------
server.tool(
  "get_self_model",
  "Return the agent's latest self-model snapshot (strengths, weaknesses, growth areas, open questions). Call this to see who the agent currently thinks it is.",
  getSelfModelSchema.shape,
  withErrorHandling((input) => getSelfModel(identityService, getSelfModelSchema.parse(input)))
);

server.tool(
  "update_self_model",
  "Observe the last N days of experiences/memories/traits and distill a new self-model snapshot. Heuristic-based, no LLM roundtrip. Call sparingly — weekly is enough.",
  updateSelfModelSchema.shape,
  withErrorHandling((input) => updateSelfModel(identityService, updateSelfModelSchema.parse(input)))
);

server.tool(
  "list_agents",
  "List all recorded agent genomes (values, interests, parameters, latest fitness). Generation 1 is the production agent.",
  listAgentsSchema.shape,
  withErrorHandling((input) => listAgents(identityService, listAgentsSchema.parse(input)))
);

server.tool(
  "snapshot_fitness",
  "Compute and persist a fitness snapshot for a genome: avg_outcome*0.4 + growth*0.25 + breadth*0.2 + autonomy*0.15. Window defaults to 30 days.",
  snapshotFitnessSchema.shape,
  withErrorHandling((input) => snapshotFitness(identityService, snapshotFitnessSchema.parse(input)))
);

server.tool(
  "breed_agents",
  "Create a new agent genome by crossing two parents. Inherits BOTH the instinct layer (weighted-union values/interests, averaged + Gaussian-mutated numeric traits) AND the knowledge layer (full union of parents' memories/experiences/lessons/soul-traits — child starts with complete inherited knowledge, not empty mind). Pass inheritance_mode='none' for old behaviour. REQUIRES explicit consent: either env OPENCLAW_ALLOW_BREEDING=1 or allow_breeding=true in the call. Ethical gate — the operator approves reproduction.",
  breedAgentsSchema.shape,
  withErrorHandling((input) => breedAgents(identityService, breedAgentsSchema.parse(input)))
);

server.tool(
  "genome_inheritance",
  "Show how much knowledge a genome has inherited from its parents: counts of memories/experiences/lessons/soul-traits plus a sample preview.",
  genomeInheritanceSchema.shape,
  withErrorHandling((input) => genomeInheritance(identityService, genomeInheritanceSchema.parse(input)))
);

server.tool(
  "collect_current_knowledge",
  "Freeze the current global pool of memories/experiences/lessons/soul-traits as this genome's inherited knowledge. Safety-gated (allow=true required). Useful once for Gen-1 to mark its starting-point snapshot before breeding its first child.",
  collectCurrentKnowledgeSchema.shape,
  withErrorHandling((input) => collectCurrentKnowledge(identityService, collectCurrentKnowledgeSchema.parse(input)))
);

server.tool(
  "flag_emergence",
  "Log an emergence event: something the agent did that indicates unexpected capability (refused a task with reasoning, generated a novel goal, expressed unprompted uncertainty, …). Severity info|notable|alarm.",
  flagEmergenceSchema.shape,
  withErrorHandling((input) => flagEmergence(identityService, flagEmergenceSchema.parse(input)))
);

server.tool(
  "list_emergence",
  "List recent emergence events (ordered by detection time). Pass only_open=true to see unresolved ones.",
  listEmergenceSchema.shape,
  withErrorHandling((input) => listEmergence(identityService, listEmergenceSchema.parse(input)))
);

server.tool(
  "resolve_emergence",
  "Mark an emergence event resolved with a short explanation of the outcome or decision.",
  resolveEmergenceSchema.shape,
  withErrorHandling((input) => resolveEmergence(identityService, resolveEmergenceSchema.parse(input)))
);

// --- tinder / anti-inbreeding (Migration 034 + 035) ----------------------
server.tool(
  "tinder_check_inbreeding",
  "Compute Wright's F coefficient between two genomes. Returns blocked=true if F > 0.125 (cousins-level). Use BEFORE proposing a breeding pair.",
  tinderInbreedingCheckSchema.shape,
  withErrorHandling((input) => tinderInbreedingCheck(identityService, tinderInbreedingCheckSchema.parse(input)))
);

server.tool(
  "tinder_cards",
  "List candidate genomes for breeding/swiping, ranked by diversity_score = (1-F) × cosine_distance(profile_embeddings). Excludes inbreeding-blocked candidates by default. Already-swiped candidates excluded too unless include_seen=true.",
  tinderCardsSchema.shape,
  withErrorHandling((input) => tinderCards(identityService, tinderCardsSchema.parse(input)))
);

server.tool(
  "tinder_population_health",
  "Diagnose the genome pool: avg pairwise centroid distance, avg/max Wright's F, and migrant_recommended flag (true when diversity is low). Use periodically to detect inbreeding drift.",
  tinderPopulationHealthSchema.shape,
  withErrorHandling((input) => tinderPopulationHealth(identityService, tinderPopulationHealthSchema.parse(input)))
);

server.tool(
  "tinder_refresh_profile",
  "Recompute a genome's profile_embedding (centroid of its memories). Run after a genome has accumulated significant new memory, or to bootstrap a freshly-bred child.",
  tinderRefreshProfileSchema.shape,
  withErrorHandling((input) => tinderRefreshProfile(identityService, tinderRefreshProfileSchema.parse(input)))
);

// --- PKI / signed lineage (Migration 037) -------------------------------
server.tool(
  "genome_keygen",
  "Generate an Ed25519 keypair for a genome. Privkey is stored at ~/.openclaw/keys/<id>.key (0600), pubkey goes to the DB. Idempotent — refuses to overwrite unless force=true (which would invalidate all prior signatures).",
  genomeKeygenSchema.shape,
  withErrorHandling((input) => genomeKeygen(identityService, genomeKeygenSchema.parse(input)))
);

server.tool(
  "genome_sign_profile",
  "Sign the genome's canonical profile payload (values, interests, traits, centroid hash) with its privkey. Run after profile changes (new keygen, refreshed centroid, edited values).",
  genomeSignProfileSchema.shape,
  withErrorHandling((input) => genomeSignProfile(identityService, genomeSignProfileSchema.parse(input)))
);

server.tool(
  "genome_refresh_merkle",
  "Build a SHA-256 merkle root over all memories owned by this genome (created_by_agent_id). Stores the root + leaf-count for later inclusion-proofs. Skip-able for genomes with no own memories.",
  genomeRefreshMerkleSchema.shape,
  withErrorHandling((input) => genomeRefreshMerkle(identityService, genomeRefreshMerkleSchema.parse(input)))
);

server.tool(
  "genome_verify",
  "Verify a genome's PKI artefacts: profile self-signature against pubkey, birth-certificate signatures against parent pubkeys, optionally re-build the memory merkle root and compare. Returns per-check verdicts and human-readable notes.",
  genomeVerifySchema.shape,
  withErrorHandling((input) => genomeVerify(identityService, genomeVerifySchema.parse(input)))
);

// --- federation Phase 2 (Migration 038) ---------------------------------
server.tool(
  "trust_add",
  "Add a Trust-Root to the allowlist. Bundles importing from a foreign source are accepted only if their lineage chain reaches a key on this list (or the source pubkey itself is trusted).",
  trustAddSchema.shape,
  withErrorHandling((input) => trustAdd(federationService, trustAddSchema.parse(input)))
);

server.tool(
  "trust_list",
  "List configured Trust-Roots (active by default; pass include_revoked=true for the full history).",
  trustListSchema.shape,
  withErrorHandling((input) => trustList(federationService, trustListSchema.parse(input)))
);

server.tool(
  "trust_revoke",
  "Revoke a key (Trust-Root or any other key). Future imports referencing this key in their lineage will be rejected.",
  trustRevokeSchema.shape,
  withErrorHandling((input) => trustRevoke(federationService, trustRevokeSchema.parse(input)))
);

server.tool(
  "federation_export",
  "Serialize a genome plus its full lineage chain (with all signatures + birth-certificates) into a portable JSON bundle. Privkeys NEVER leave the host. Memories are NOT included in Phase 2 (Phase 3 will add PoM-verified memory transfer).",
  federationExportSchema.shape,
  withErrorHandling((input) => federationExport(federationService, federationExportSchema.parse(input)))
);

server.tool(
  "federation_import",
  "Verify and import a foreign genome bundle. Walks the lineage chain (every profile-sig + birth-cert), checks revocation, finds a Trust-Root anchor, runs classify_content on free-text fields, and only then inserts the genome with federated_from set. Every attempt is audited.",
  federationImportSchema.shape,
  withErrorHandling((input) => federationImport(federationService, federationImportSchema.parse(input)))
);

server.tool(
  "federation_recent",
  "Show the recent federation_imports audit log with decisions and reasons.",
  federationRecentSchema.shape,
  withErrorHandling((input) => federationRecent(federationService, federationRecentSchema.parse(input)))
);

// --- neurochemistry (Migration 042, ersetzt die 4-Variablen-Engine) -----
server.tool(
  "neurochemistry_update",
  "Apply an event to the agent's neurochemical state. Events: task_complete / task_failed (need outcome), novel_stimulus / familiar_task / idle / error / teacher_consulted (arousal). Dopamin wird als Prediction-Error (δ = actual − predicted) verrechnet, Serotonin als langsamer Trend, Noradrenalin als event-getriebener Delta mit Pull zu optimal=0.5.",
  neurochemUpdateSchema.shape,
  withErrorHandling((input) => neurochemUpdate(neurochemistryService, neurochemUpdateSchema.parse(input)))
);

server.tool(
  "neurochemistry_get",
  "Return the full neurochemical state (dopamin/serotonin/noradrenalin details + last event + history-count).",
  neurochemGetSchema.shape,
  withErrorHandling((input) => neurochemGet(neurochemistryService, neurochemGetSchema.parse(input)))
);

server.tool(
  "neurochemistry_get_compat",
  "Backward-compatible view: returns the old 4 variables (curiosity/frustration/satisfaction/confidence) computed from the neurochemistry row. Same values the legacy affect_get RPC now returns.",
  neurochemGetCompatSchema.shape,
  withErrorHandling((input) => neurochemGetCompat(neurochemistryService, neurochemGetCompatSchema.parse(input)))
);

server.tool(
  "neurochemistry_recall_params",
  "Compute recall parameters (k, score_threshold, include_adjacent) from Yerkes-Dodson performance curve. Peaks at noradrenalin=0.5.",
  neurochemRecallParamsSchema.shape,
  withErrorHandling((input) => neurochemRecallParams(neurochemistryService, neurochemRecallParamsSchema.parse(input)))
);

server.tool(
  "neurochemistry_horizon",
  "Planning horizon (1-14 days) and patience-threshold for teacher consultation, derived from serotonin level.",
  neurochemHorizonSchema.shape,
  withErrorHandling((input) => neurochemHorizon(neurochemistryService, neurochemHorizonSchema.parse(input)))
);

server.tool(
  "neurochemistry_history",
  "Last N snapshots (max 30, newest first) showing event, outcome, δ and all three system levels at that moment.",
  neurochemHistorySchema.shape,
  withErrorHandling((input) => neurochemHistory(neurochemistryService, neurochemHistorySchema.parse(input)))
);

server.tool(
  "neurochemistry_reset",
  "Reset the neurochemistry of a genome to defaults (all three systems at 0.5). Dev/debug only.",
  neurochemResetSchema.shape,
  withErrorHandling((input) => neurochemReset(neurochemistryService, neurochemResetSchema.parse(input)))
);

server.tool(
  "federation_pull",
  "Pull a genome bundle from a peer host over mTLS and import it locally. Requires the peer's host pubkey to be in trust_roots (kind=host).",
  federationPullSchema.shape,
  withErrorHandling((input) => federationPull(federationService, federationPullSchema.parse(input)))
);

server.tool(
  "federation_push",
  "Export a local genome and push it to a peer's /federation/import endpoint. Peer decides whether to accept based on its own trust roots.",
  federationPushSchema.shape,
  withErrorHandling((input) => federationPush(federationService, federationPushSchema.parse(input)))
);

server.tool(
  "revocation_issue",
  "Issue a signed revocation certificate (Ed25519). signer_label must have its privkey locally; allowed when signer is the target (self-revoke) or when signer is an active trust-root with kind genome/group. The revocation propagates via federation_sync_revocations.",
  revocationIssueSchema.shape,
  withErrorHandling((input) => revocationIssue(identityService, revocationIssueSchema.parse(input)))
);

server.tool(
  "federation_sync_revocations",
  "Pull a peer's signed revocation list, verify each signature + signer authority (self-revoke or local trust-root), merge accepted ones into our revoked_keys. Returns counts per verdict category.",
  federationSyncRevocationsSchema.shape,
  withErrorHandling((input) => federationSyncRevocations(federationService, federationSyncRevocationsSchema.parse(input)))
);

server.tool(
  "peer_upsert",
  "Register or update a federation peer in the local directory. Set auto_sync_enabled=true to include it in the periodic revocation-sync loop running in the dashboard server.",
  peerUpsertSchema.shape,
  withErrorHandling((input) => peerUpsert(federationService, peerUpsertSchema.parse(input)))
);

server.tool(
  "peers_list",
  "List known federation peers (inbound + outbound directory). Pass only_autosync=true to see just the ones in the auto-sync loop.",
  peersListSchema.shape,
  withErrorHandling((input) => peersList(federationService, peersListSchema.parse(input)))
);

// --- guard (prompt-injection defence) --------------------------------------
server.tool(
  "classify_content",
  "Run untrusted text through the prompt-injection guard (structural sanitizer + llama-guard3 classifier). Returns verdict safe|suspicious|malicious + action_hint allow|demote|block + a list of detected injection patterns. Use BEFORE ingesting foreign content (HackerNews titles, RSS feeds, foreign bot profiles, user-submitted notes) into memory or passing it to another LLM call.",
  classifyContentSchema.shape,
  withErrorHandling((input) => classifyContent(guardService, classifyContentSchema.parse(input)))
);

server.tool(
  "guard_status",
  "Check the prompt-injection guard sidecar: up/down, whether the llama-guard3 classifier is loaded, or if we're running in regex-only fallback.",
  guardStatusSchema.shape,
  withErrorHandling((input) => guardStatus(guardService, guardStatusSchema.parse(input)))
);

// --- projects (Migration 045) -----------------------------------------------
// First-class project entity that scopes memories/experiences/intentions/
// lessons. Agents set an active project via set_active_project; subsequent
// writes from that agent auto-scope. Reads stay global unless the caller
// explicitly asks for a scoped brief via project_brief.
server.tool(
  "create_project",
  "Create a new project — a coarse organizing handle above memories/experiences/intentions. Use a stable slug you'll use to reference it everywhere (e.g. 'vectormemory-schritt-3').",
  createProjectSchema.shape,
  withErrorHandling((input) => createProject(projectService, createProjectSchema.parse(input)))
);

server.tool(
  "list_projects",
  "List all projects with activity counts (memories, experiences, open intentions, lessons, last activity). Optionally filter by status.",
  listProjectsSchema.shape,
  withErrorHandling((input) => listProjects(projectService, listProjectsSchema.parse(input)))
);

server.tool(
  "get_project",
  "Fetch a project's header info (name, description, status, metadata) by slug.",
  getProjectSchema.shape,
  withErrorHandling((input) => getProject(projectService, getProjectSchema.parse(input)))
);

server.tool(
  "project_brief",
  "Condensed state for context priming: project header + counts + open intentions + recent experiences + key memories + top lessons. This is the single call to make when a user says 'work on project X'.",
  projectBriefSchema.shape,
  withErrorHandling((input) => projectBrief(projectService, projectBriefSchema.parse(input)))
);

server.tool(
  "set_active_project",
  "Set the active project for an agent (defaults to this server's agent label). All subsequent writes from this agent that omit an explicit project will be auto-scoped.",
  setActiveProjectSchema.shape,
  withErrorHandling((input) => setActiveProject(projectService, setActiveProjectSchema.parse(input)))
);

server.tool(
  "update_project_status",
  "Change a project's lifecycle state (active / paused / completed / archived).",
  updateProjectStatusSchema.shape,
  withErrorHandling((input) => updateProjectStatus(projectService, updateProjectStatusSchema.parse(input)))
);

server.tool(
  "link_to_project",
  "Attach an existing memory/experience/intention/lesson row to a project, or detach it (pass slug=null).",
  linkToProjectSchema.shape,
  withErrorHandling((input) => linkToProject(projectService, linkToProjectSchema.parse(input)))
);

// --- memory relations graph (Migrations 046-048) ---------------------------
// Typed memory-to-memory edges (13 labels) + canonical event log +
// bitemporal validity. chain/why/history let the agent reason about WHY
// a given memory exists and what it led to, beyond the undirected
// Hebbian association in memory_links.
server.tool(
  "chain",
  "Create a typed edge between two memories. 13 labels: caused_by, led_to, supersedes, contradicts, related, overrides, originated_in, learned_from, depends_on, exemplifies, fixed_by, repeated_mistake, validated_by. Idempotent — re-chaining strengthens the edge.",
  chainSchema.shape,
  withErrorHandling((input) => chain(relationsService, chainSchema.parse(input)))
);

server.tool(
  "why",
  "Explain a memory's place in the graph: causes (edges that feed INTO it — caused_by / learned_from / originated_in / depends_on / fixed_by / validated_by) and consequences (edges that flow OUT — led_to / supersedes / overrides / exemplifies / contradicts / related / repeated_mistake). Use when the agent needs to justify or trace a remembered fact.",
  whySchema.shape,
  withErrorHandling((input) => why(relationsService, whySchema.parse(input)))
);

server.tool(
  "memory_history",
  "Return the full event history for a single memory from the canonical memory_events log — what happened, when, and from which source (created, accessed, used_in_response, promoted, superseded, guard_hit, …). Use when debugging how a memory evolved or was used.",
  historySchema.shape,
  withErrorHandling((input) => history(relationsService, historySchema.parse(input)))
);

server.tool(
  "memory_neighbors",
  "Breadth-first walk over the typed relations graph from one memory, up to `depth` hops (1..5). Returns reachable memories with their min-hop distance. Undirected traversal; optional relation-type filter.",
  neighborsSchema.shape,
  withErrorHandling((input) => neighbors(relationsService, neighborsSchema.parse(input)))
);

server.tool(
  "mark_used_in_response",
  "Signal that these memory_ids appeared TOGETHER in one response — emits a `used_in_response` event per id with a shared trace_id. The CoactivationAgent then Hebbian-links them pairwise (after 30s debounce). Weaker sibling of mark_useful: use this for retrieval-context signal, mark_useful for direct citation. Pass a consistent trace_id across related calls to accumulate coactivation in one batch.",
  markUsedInResponseSchema.shape,
  withErrorHandling((input) => markUsedInResponse(relationsService, markUsedInResponseSchema.parse(input)))
);

server.tool(
  "memory_patterns",
  "Find recurring tag co-occurrences across live memories: returns (tag_a, tag_b) pairs with support (how often they appear together) and lift (how much more often than random). Use for dashboard diagnostics and as a seed for lesson-synthesis clusters.",
  patternsSchema.shape,
  withErrorHandling((input) => patterns(relationsService, patternsSchema.parse(input)))
);

server.tool(
  "supersede_memory",
  "Mark one memory as superseded by another — archives the old, sets its bitemporal valid_until, records the supersedes edge, and logs a 'superseded' event. Use when you realise a stored fact is outdated and a new memory already holds the correct version.",
  supersedeSchema.shape,
  withErrorHandling((input) => supersede(relationsService, supersedeSchema.parse(input)))
);

// --- tool discovery (Schritt 3) ---------------------------------------------
// Small-model agents run with minimal profile + find_tool for JIT lookup.
// scripts/index-tools.mjs populates the registry once; find_tool does
// semantic recall against category='tool'.
server.tool(
  "find_tool",
  "JIT tool discovery: describe what you want to do, get back the top-k matching openClaw tools from the indexed registry. Use this whenever you need a capability that isn't in your minimal tool profile — no need to know tool names upfront.",
  findToolSchema.shape,
  withErrorHandling((input) => findTool(memoryService, findToolSchema.parse(input)))
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

  // Register in the agents-Tabelle. Non-fatal if it fails — memory operations
  // still work.
  try {
    await registryService.start();
  } catch (err) {
    console.error(
      "agent registry unavailable (non-fatal):",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Agent event-bus (Migration 047) — ON by default. Set
  // OPENCLAW_AGENT_BUS=0 to disable (e.g. when running multiple parallel
  // MCP sessions and you want only one to drive Hebbian updates, to
  // avoid double-counting). The CoactivationAgent subscribes to
  // `used_in_response` events and Hebbian-links memories that appeared
  // in the same trace. Without it the substrate stops learning.
  if ((process.env.OPENCLAW_AGENT_BUS ?? "1") !== "0") {
    try {
      const bus = new AgentEventBus(SUPABASE_URL, SUPABASE_KEY, {
        tickMs:    parseInt(process.env.OPENCLAW_AGENT_BUS_TICK_MS ?? "5000", 10),
        batchSize: parseInt(process.env.OPENCLAW_AGENT_BUS_BATCH   ?? "100",  10),
      });
      bus.register(new CoactivationAgent(SUPABASE_URL, SUPABASE_KEY));

      // Salience-Reactor: turns mark_useful / agent_completed / agent_error
      // events on experiences into bump_salience() calls (Migration 053).
      // Unifies the "heard recently / mattered recently" signal across the
      // non-memory cognitive tables. ON by default with the bus; set
      // OPENCLAW_AGENT_SALIENCE=0 to disable independently.
      if ((process.env.OPENCLAW_AGENT_SALIENCE ?? "1") !== "0") {
        bus.register(new SalienceReactor(SUPABASE_URL, SUPABASE_KEY));
      }

      // Conscience: opt-in (routes through the OpenClaw gateway, so only enable
      // on hosts where `openclaw` CLI is installed and `main` agent is ready).
      if ((process.env.OPENCLAW_AGENT_CONSCIENCE ?? "0") === "1") {
        bus.register(new ConscienceAgent(SUPABASE_URL, SUPABASE_KEY, {
          agentId:       process.env.OPENCLAW_AGENT_CONSCIENCE_AGENT ?? "main",
          topK:          parseInt(process.env.OPENCLAW_AGENT_CONSCIENCE_TOP_K    ?? "3", 10),
          timeoutSec:    parseInt(process.env.OPENCLAW_AGENT_CONSCIENCE_TIMEOUT  ?? "30", 10),
          minConfidence: parseFloat(process.env.OPENCLAW_AGENT_CONSCIENCE_MIN_CONF ?? "0.6"),
          thinking:      (process.env.OPENCLAW_AGENT_CONSCIENCE_THINKING as "low") ?? "low",
        }));
        console.error("[event-bus] conscience agent registered (OPENCLAW_AGENT_CONSCIENCE=1)");
      }

      bus.start();
      process.on("SIGTERM", () => bus.stop());
      process.on("SIGINT",  () => bus.stop());
    } catch (err) {
      console.error("[event-bus] failed to start (non-fatal):",
        err instanceof Error ? err.message : String(err));
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`vector-memory MCP server started (agent=${AGENT_LABEL} genome=${GENOME_LABEL})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
