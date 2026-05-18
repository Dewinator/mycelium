#!/usr/bin/env node
// enrich-locomo.mjs — second-pass enrichment on top of raw turn memories.
//
// Reads already-ingested project memories, groups them by session, then for
// each session calls a local LLM to extract:
//   1. Atomic facts  → stored as [D<sess>:FACT SPEAKER @DATE] memories
//   2. Session summary → stored as [D<sess>:SUM SUMMARY @DATE] memory
//
// These blend naturally with raw turns in run-locomo.mjs (same format) and
// dramatically improve cat1/2/3/4 recall by surfacing explicit entity–attribute
// pairs instead of relying on conversational phrasing alone.
//
// Usage:
//   node experiments/locomo/enrich-locomo.mjs --conv=conv-26
//   node experiments/locomo/enrich-locomo.mjs --all
//   node experiments/locomo/enrich-locomo.mjs --conv=conv-26 --reset   # wipe existing enriched memories first
//   node experiments/locomo/enrich-locomo.mjs --conv=conv-26 --model=qwen3:8b
//   node experiments/locomo/enrich-locomo.mjs --conv=conv-26 --provider=claude

import {
  loadDataset, findSample, listSampleIds, projectSlugFor, iterTurns,
  parseArgs, ollamaChat, claudeCliChat, insertMemoryDirect,
  MemoryService, ProjectService, createEmbeddingProvider,
  SUPABASE_URL, SUPABASE_KEY,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const dataset = await loadDataset();
const targets = args.all ? listSampleIds(dataset) : [args.conv ?? dataset[0].sample_id];
const reset = !!args.reset;
const provider = args.provider || "ollama";
const model = args.model || (provider === "claude" ? "claude-haiku-4-5-20251001" : "qwen3:8b");

const embeddings = createEmbeddingProvider();
const memSvc = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);
const projects = new ProjectService(SUPABASE_URL, SUPABASE_KEY);

// ── LLM wrapper ──────────────────────────────────────────────────────────────

async function llmChat(system, user) {
  if (provider === "claude") {
    return claudeCliChat({ model, system, user, maxTurns: 1, timeoutMs: 60000 });
  }
  return ollamaChat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    num_predict: 1024,
    temperature: 0,
  });
}

// ── Fact extraction prompt ────────────────────────────────────────────────────

function buildExtractionPrompt(speakerA, speakerB, sessionDate, turns) {
  const turnBlock = turns
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");

  const system = [
    `You extract structured facts from conversation sessions between ${speakerA} and ${speakerB}.`,
    "Output ONLY the requested format, no extra text.",
  ].join(" ");

  const user = [
    `Session date: ${sessionDate || "unknown"}`,
    `Participants: ${speakerA}, ${speakerB}`,
    "",
    "CONVERSATION:",
    turnBlock,
    "",
    "Extract:",
    "1. A SUMMARY line (max 3 sentences covering key events for both speakers, start with 'SUMMARY: ')",
    "2. FACTS lines — one atomic fact per line, format: 'FACT: <subject> | <predicate> | <value>'",
    `   Session date: ${sessionDate || "unknown"}. Include this date in facts when no specific date is mentioned.`,
    "   Cover ALL of: career/job changes, home locations and moves, hobbies and activities, relationships",
    "   (family/friends/romantic), life events (births/deaths/marriages/graduations), health conditions,",
    "   goals and plans, achievements, purchases, and scheduled events with their specific dates.",
    "   Dates and numbers are critical — always include them when mentioned (e.g. 'Alice | started job at | Google in March 2022').",
    "   Use full proper names for BOTH speakers, never pronouns. Extract facts for both participants.",
    "   Skip pure greetings, filler turns, and content-free social acknowledgements.",
    "   Maximum 15 facts.",
    "",
    "Example:",
    "SUMMARY: Sam shared progress on fitness goals and mentioned starting a new job.",
    "FACT: Sam | started new job at | Google",
    "FACT: Sam | has been doing | fitness routine since March 2023",
    "FACT: Evan | expressed support for | Sam's fitness progress",
  ].join("\n");

  return { system, user };
}

// ── Parse LLM output ──────────────────────────────────────────────────────────

function parseEnrichmentOutput(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let summary = null;
  const facts = [];

  for (const line of lines) {
    if (line.startsWith("SUMMARY:")) {
      summary = line.slice("SUMMARY:".length).trim();
    } else if (line.startsWith("FACT:")) {
      const body = line.slice("FACT:".length).trim();
      const parts = body.split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        facts.push({ subject: parts[0], predicate: parts[1], value: parts[2] });
      } else if (parts.length === 2) {
        facts.push({ subject: parts[0], predicate: parts[1], value: "" });
      }
    }
  }

  return { summary, facts };
}

// ── Session grouping ──────────────────────────────────────────────────────────

function groupTurnsBySession(sample) {
  const sessions = new Map(); // sessionNum → { dateTime, turns[] }
  for (const { sessionNum, dateTime, turn } of iterTurns(sample)) {
    if (!sessions.has(sessionNum)) {
      sessions.set(sessionNum, { dateTime, turns: [] });
    }
    sessions.get(sessionNum).turns.push(turn);
  }
  return sessions;
}

// ── Main ──────────────────────────────────────────────────────────────────────

for (const sampleId of targets) {
  const sample = findSample(dataset, sampleId);
  const slug = projectSlugFor(sampleId);
  const speakerA = sample.conversation.speaker_a;
  const speakerB = sample.conversation.speaker_b;

  const project = await projects.getBySlug(slug);
  if (!project) {
    console.error(`[${sampleId}] project not found — run ingest-locomo.mjs first`);
    continue;
  }

  if (reset) {
    const { error } = await memSvc.db
      .from("memories")
      .delete()
      .eq("project_id", project.id)
      .contains("tags", ["locomo-enriched"]);
    if (error) throw new Error(`reset enriched memories: ${error.message}`);
    console.log(`[${sampleId}] wiped existing enriched memories`);
  }

  const sessions = groupTurnsBySession(sample);
  let totalFacts = 0;
  let totalSummaries = 0;

  for (const [sessionNum, { dateTime, turns }] of sessions) {
    if (turns.length === 0) continue;

    // Skip if already enriched (idempotent)
    const { data: existing } = await memSvc.db
      .from("memories")
      .select("id")
      .eq("project_id", project.id)
      .contains("tags", ["locomo-enriched", `session:${sessionNum}`])
      .limit(1);
    if (existing && existing.length > 0) {
      continue;
    }

    const { system, user } = buildExtractionPrompt(speakerA, speakerB, dateTime, turns);

    let raw;
    try {
      raw = await llmChat(system, user);
    } catch (e) {
      console.warn(`[${sampleId}] session ${sessionNum} LLM error: ${e.message}`);
      continue;
    }

    const { summary, facts } = parseEnrichmentOutput(raw);
    const dateLabel = dateTime || "unknown-date";

    // Store session summary
    if (summary) {
      const content = `[D${sessionNum}:SUM SUMMARY @${dateLabel}] ${summary}`;
      const embedding = await embeddings.embed(content);
      await insertMemoryDirect(memSvc, {
        content,
        category: "general",
        subtype: "summary",
        tags: ["locomo", "locomo-enriched", "locomo-summary", `conv:${sampleId}`, `session:${sessionNum}`],
        embedding,
        metadata: {
          benchmark: "locomo",
          sample_id: sampleId,
          session: sessionNum,
          date_time: dateTime,
          enriched_type: "summary",
        },
        source: `locomo-enrich:${sampleId}:D${sessionNum}:SUM`,
        project_id: project.id,
        pinned: false,
      });
      totalSummaries++;
    }

    // Store each extracted fact
    for (let i = 0; i < facts.length; i++) {
      const { subject, predicate, value } = facts[i];
      const factText = value
        ? `${subject} ${predicate}: ${value}`
        : `${subject} ${predicate}`;
      const content = `[D${sessionNum}:F${i} ${subject} @${dateLabel}] ${factText}`;
      const embedding = await embeddings.embed(content);
      await insertMemoryDirect(memSvc, {
        content,
        category: "general",
        subtype: "fact",
        tags: ["locomo", "locomo-enriched", "locomo-fact", `conv:${sampleId}`, `session:${sessionNum}`],
        embedding,
        metadata: {
          benchmark: "locomo",
          sample_id: sampleId,
          session: sessionNum,
          date_time: dateTime,
          enriched_type: "fact",
          subject,
          predicate,
          value,
        },
        source: `locomo-enrich:${sampleId}:D${sessionNum}:F${i}`,
        project_id: project.id,
        pinned: false,
      });
      totalFacts++;
    }

    if (sessionNum % 5 === 0) {
      console.log(`[${sampleId}] session ${sessionNum} done (${facts.length} facts, summary: ${!!summary})`);
    }
  }

  console.log(`[${sampleId}] enrichment done — ${totalSummaries} summaries, ${totalFacts} facts`);
}
