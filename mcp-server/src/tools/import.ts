import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { MemoryService } from "../services/supabase.js";

export const importSchema = z.object({
  directory: z
    .string()
    .describe("Path to the openClaw memory directory (e.g. ~/.openclaw/workspace/memory)"),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Preview without importing"),
});

const CATEGORY_MAP: Record<string, string> = {
  people: "people",
  projects: "projects",
  topics: "topics",
  decisions: "decisions",
};

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
    // Directory doesn't exist or isn't readable
  }
  return files;
}

function detectCategory(filePath: string, baseDir: string): string {
  const relative = filePath.slice(baseDir.length + 1);
  const topDir = relative.split("/")[0];
  return CATEGORY_MAP[topDir] ?? "general";
}

export async function importMarkdown(
  service: MemoryService,
  input: z.infer<typeof importSchema>
) {
  const files = await findMarkdownFiles(input.directory);

  if (files.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No markdown files found in ${input.directory}`,
        },
      ],
    };
  }

  if (input.dry_run) {
    const preview = files
      .map((f) => `  ${basename(f)} → ${detectCategory(f, input.directory)}`)
      .join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Dry run: ${files.length} files would be imported:\n${preview}`,
        },
      ],
    };
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      if (content.trim().length === 0) continue;

      const category = detectCategory(file, input.directory);
      const name = basename(file, ".md");

      await service.create({
        content,
        category,
        tags: [name],
        source: file,
        metadata: { imported_from: file, original_name: name },
      });
      imported++;
    } catch (err) {
      failed++;
      errors.push(`${basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let text = `Imported ${imported}/${files.length} files.`;
  if (failed > 0) {
    text += `\n${failed} failed:\n${errors.join("\n")}`;
  }

  return { content: [{ type: "text" as const, text }] };
}
