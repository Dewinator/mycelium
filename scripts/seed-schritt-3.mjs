#!/usr/bin/env node
// seed-schritt-3.mjs — example seed that demonstrates the project-scoping
// primitives end-to-end: create a project, attach decisions / experience /
// lesson / intention, and scope them all together.
//
// The content here is deliberately generic. If you want to seed your own
// setup with real decisions / hardware / model choices / agent IDs, copy
// this file to a gitignored location (e.g. scripts/local/) and customise
// there — do NOT commit setup-specific details back to the public repo.
//
// Runs against the Supabase pool configured in .mcp.json. Idempotent.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpCfg = JSON.parse(await fs.readFile(path.resolve(__dirname, "../.mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
for (const k of Object.keys(env)) process.env[k] ||= env[k];

const DIST = path.resolve(__dirname, "../mcp-server/dist");
const { MemoryService }           = await import(path.join(DIST, "services/supabase.js"));
const { ExperienceService }       = await import(path.join(DIST, "services/experiences.js"));
const { ProjectService }          = await import(path.join(DIST, "services/projects.js"));
const { createEmbeddingProvider } = await import(path.join(DIST, "services/embeddings.js"));

const SLUG = "vectormemory-schritt-3";

const embeddings  = createEmbeddingProvider();
const memories    = new MemoryService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, embeddings);
const experiences = new ExperienceService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, embeddings);
const projects    = new ProjectService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------- 1. create project (idempotent) --------
let project = await projects.getBySlug(SLUG);
if (!project) {
  project = await projects.create(
    SLUG,
    "Vectormemory — Schritt 3: JIT Tool Discovery",
    "Make small-context local models viable as full agents by indexing the tool registry as memories and looking tools up semantically at use-time, instead of prefilling the entire tool schema in every session.",
    { related_repos: ["vectormemory-openclaw"] }
  );
  console.log("Created project:", project.slug, project.id);
} else {
  console.log("Project exists:", project.slug, project.id);
}
const projectId = project.id;

// -------- 2. example decisions (remember) --------
// Architectural decisions that are safe to publish. Replace with your own
// in a local, gitignored copy of this script if you want to persist your
// own setup-specific choices.
const decisions = [
  {
    content:
      "Project scoping is opt-in on writes via nullable project_id FK on memories/experiences/intentions/lessons. Reads stay global by default — project scoping on reads is explicit at the call site (project_brief or an explicit filter). This avoids surprising empty results from implicit filtering.",
    tags: ["architecture", "project-scoping", "design"],
  },
  {
    content:
      "Per-agent active project is persisted (agent_active_project table, FK on agent_genomes.id), not session-scoped. Agents identified by genome label keep their focus across sessions until the user explicitly switches. Session-scoped projects can be added later as an additive migration if needed.",
    tags: ["architecture", "project-scoping", "agents"],
  },
  {
    content:
      "Tool discovery for small-context agents is semantic, not static. Index the tool registry once as memories with category='tool'; agents on minimal profile call find_tool(intent) at use-time. This scales with used tools, not existing tools, and keeps prefill lean enough to leave headroom for actual work.",
    tags: ["architecture", "tool-discovery", "small-models"],
  },
];

for (const d of decisions) {
  const m = await memories.create({
    content: d.content,
    category: "decisions",
    tags: d.tags,
    source: "seed-schritt-3",
    importance: 0.8,
    project_id: projectId,
  });
  console.log("  remember:", m.id, "—", m.content.slice(0, 70) + "…");
}

// -------- 3. lesson (record_lesson + scope) --------
// Anchor experience so the lesson has source_ids.
const anchorExp = await experiences.record({
  summary:
    "Designed and shipped the project-scoping layer + JIT tool discovery. The layer is opt-in on writes, transparent on reads, and sits over the existing cognitive primitives without replacing them.",
  task_type: "architecture",
  outcome: "success",
  difficulty: 0.6,
  valence: 0.5,
  arousal: 0.4,
  tags: ["architecture", "project-scoping", "tool-discovery"],
  what_worked:
    "Keeping the scoping optional — existing rows with project_id=NULL keep working. Reads stayed global by default so no surprising side effects on existing queries. The tool registry index plus a thin recall wrapper was enough to replace static schema prefill.",
  what_failed: null,
  tools_used: ["typescript", "postgresql", "pgvector", "mcp"],
});
await projects.applyScopeToRow("experiences", anchorExp.id, projectId);
console.log("  experience:", anchorExp.id);

const lessonId = await experiences.recordLesson(
  "Small-context language models plus a vector-backed tool registry can reach the same effective tool surface as large-context models, by trading a one-time static prefill of tool schemas for per-intent semantic lookup. The wins compound: agents stay lean, new tools are discoverable without re-prompting, and the dependency graph between tools and usage becomes observable via the memory layer.",
  [anchorExp.id],
  { category: "insight", confidence: 0.8 }
);
await projects.applyScopeToRow("lessons", lessonId, projectId);
console.log("  lesson:", lessonId);

// -------- 4. open intention (set_intention + scope) --------
const intentionId = await experiences.setIntention({
  intention:
    "I want the tool-discovery layer to keep improving: (a) richer trigger phrases per tool so noisy queries still hit, (b) a feedback loop that reinforces tools that agents actually picked and succeeded with, (c) a lightweight re-index trigger when the upstream tool registry changes.",
  priority: 0.7,
});
await projects.applyScopeToRow("intentions", intentionId, projectId);
console.log("  intention:", intentionId);

// -------- 5. done --------
console.log("\nSeed complete. Brief:");
const brief = await projects.brief(SLUG);
console.log("  memories:      ", brief.counts.memories);
console.log("  experiences:   ", brief.counts.experiences);
console.log("  intentions:    ", brief.counts.intentions_open + "/" + brief.counts.intentions_total);
console.log("  lessons:       ", brief.counts.lessons);
console.log("\nNext: open the dashboard, tab 'projekte', find '" + SLUG + "', click 'prompt kopieren'.");
