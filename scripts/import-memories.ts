#!/usr/bin/env npx tsx

/**
 * Standalone import script for migrating openClaw markdown memories
 * into the Supabase vector database.
 *
 * Usage:
 *   npx tsx scripts/import-memories.ts [memory-dir] [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory
 *   npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory --dry-run
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Ollama } from "ollama";

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const BATCH_DELAY_MS = 50; // delay between embeddings to avoid overloading

// ── Category detection ──────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  people: "people",
  projects: "projects",
  topics: "topics",
  decisions: "decisions",
};

function detectCategory(filePath: string, baseDir: string): string {
  const relative = filePath.slice(baseDir.length + 1);
  const topDir = relative.split("/")[0];
  return CATEGORY_MAP[topDir] ?? "general";
}

// ── Find markdown files ─────────────────────────────────

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findMarkdownFiles(fullPath)));
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const memoryDir = resolve(args.find((a) => !a.startsWith("--")) ?? ".");

  if (!SUPABASE_KEY && !dryRun) {
    console.error("Error: SUPABASE_KEY is required. Set it in your environment.");
    console.error("  export SUPABASE_KEY=your_jwt_secret");
    process.exit(1);
  }

  console.log(`\n=== openClaw Memory Import ===`);
  console.log(`Directory: ${memoryDir}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE IMPORT"}\n`);

  const files = await findMarkdownFiles(memoryDir);
  if (files.length === 0) {
    console.log("No markdown files found.");
    process.exit(0);
  }

  console.log(`Found ${files.length} markdown files.\n`);

  if (dryRun) {
    for (const file of files) {
      const category = detectCategory(file, memoryDir);
      const content = await readFile(file, "utf-8");
      const lines = content.trim().split("\n").length;
      console.log(`  ${basename(file)} → ${category} (${lines} lines)`);
    }
    console.log(`\nDry run complete. ${files.length} files would be imported.`);
    return;
  }

  // Live import
  const db = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ollama = new Ollama({ host: OLLAMA_URL });

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const name = basename(file, ".md");
    const content = await readFile(file, "utf-8");

    if (content.trim().length === 0) {
      console.log(`  SKIP (empty): ${name}`);
      skipped++;
      continue;
    }

    // Check for duplicates by source path
    const { data: existing } = await db
      .from("memories")
      .select("id")
      .eq("source", file)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`  SKIP (exists): ${name}`);
      skipped++;
      continue;
    }

    try {
      // Generate embedding
      const response = await ollama.embed({
        model: EMBEDDING_MODEL,
        input: content,
      });
      const embedding = response.embeddings[0];

      const category = detectCategory(file, memoryDir);

      const { error } = await db.from("memories").insert({
        content,
        category,
        tags: [name],
        embedding: JSON.stringify(embedding),
        metadata: { imported_from: file, original_name: name },
        source: file,
      });

      if (error) throw new Error(error.message);

      imported++;
      console.log(`  OK: ${name} → ${category}`);

      // Small delay to avoid overwhelming Ollama
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    } catch (err) {
      failed++;
      console.error(
        `  FAIL: ${name} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  console.log(`\n=== Import Complete ===`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${files.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
