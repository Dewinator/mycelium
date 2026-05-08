#!/usr/bin/env node
// ingest-locomo.mjs — load one (or all) LoCoMo conversation(s) and ingest
// every turn as a project-scoped memory. One project per conversation
// (slug locomo-<sample_id>) so recall can be perfectly isolated per-eval.
//
// Usage:
//   node experiments/locomo/ingest-locomo.mjs --conv=conv-26
//   node experiments/locomo/ingest-locomo.mjs --all
//   node experiments/locomo/ingest-locomo.mjs --conv=conv-26 --max-turns=20    # smoke
//   node experiments/locomo/ingest-locomo.mjs --conv=conv-26 --reset           # wipe project first

import {
  loadDataset, findSample, listSampleIds, projectSlugFor, iterTurns,
  renderTurnContent, insertMemoryDirect, parseArgs,
  MemoryService, ProjectService, createEmbeddingProvider,
  SUPABASE_URL, SUPABASE_KEY,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dataset = await loadDataset();

const targets = args.all ? listSampleIds(dataset) : [args.conv ?? dataset[0].sample_id];
const maxTurns = args["max-turns"] ? Number(args["max-turns"]) : Infinity;
const reset = !!args.reset;

const embeddings = createEmbeddingProvider();
const memSvc = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const projects = new ProjectService(SUPABASE_URL, SUPABASE_KEY);

for (const sampleId of targets) {
  const sample = findSample(dataset, sampleId);
  const slug = projectSlugFor(sampleId);
  const speakerA = sample.conversation.speaker_a;
  const speakerB = sample.conversation.speaker_b;

  let project = await projects.getBySlug(slug);
  if (!project) {
    project = await projects.create(
      slug,
      `LoCoMo eval — ${sampleId}`,
      `Per-conversation memory bucket for the LoCoMo benchmark (sample ${sampleId}, ` +
        `between ${speakerA} and ${speakerB}). Each turn is a memory row.`,
      { related_repos: ["mycelium"], benchmark: "locomo", sample_id: sampleId }
    );
    console.log(`[${sampleId}] created project ${project.slug} (${project.id})`);
  } else {
    console.log(`[${sampleId}] project exists ${project.slug} (${project.id})`);
  }

  if (reset) {
    const { error } = await memSvc.db.from("memories").delete().eq("project_id", project.id);
    if (error) throw new Error(`reset failed: ${error.message}`);
    console.log(`[${sampleId}] wiped existing memories for project`);
  }

  let count = 0;
  for (const ctx of iterTurns(sample)) {
    if (count >= maxTurns) break;
    const { turn, sessionNum, dateTime } = ctx;
    const content = renderTurnContent(ctx);
    const embedding = await embeddings.embed(content);

    const tags = [
      "locomo",
      `conv:${sampleId}`,
      `session:${sessionNum}`,
      `speaker:${turn.speaker}`,
      `dia:${turn.dia_id}`,
    ];

    const row = {
      content,
      category: "general",
      tags,
      embedding,
      metadata: {
        benchmark: "locomo",
        sample_id: sampleId,
        session: sessionNum,
        date_time: dateTime,
        dia_id: turn.dia_id,
        speaker: turn.speaker,
        has_image: !!turn.img_url,
      },
      source: `locomo:${sampleId}:${turn.dia_id}`,
      project_id: project.id,
      pinned: false,
    };

    await insertMemoryDirect(memSvc, row);
    count += 1;
    if (count % 50 === 0) console.log(`[${sampleId}]   ingested ${count} turns…`);
  }
  console.log(`[${sampleId}] done — ${count} turns ingested`);
}
