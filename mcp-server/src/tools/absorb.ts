import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

/**
 * `absorb` — the low-friction learning tool.
 *
 * The agent just passes text it picked up during conversation. The server
 * handles everything else: category detection, tag extraction, importance/
 * valence/arousal scoring (via heuristics), duplicate checking, Hebbian
 * seeding, and interference. This is the "just tell me and I'll file it"
 * counterpart to the more manual `remember`.
 */

export const absorbSchema = z.object({
  text: z
    .string()
    .describe(
      "What you learned or noticed — a fact, preference, decision, person detail, anything worth keeping. Write it as a clear, standalone sentence."
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional: why this matters or where it came from. Not stored separately, but appended to improve embedding quality."
    ),
});

// ---------------------------------------------------------------------------
// Category auto-detection from text signals
// ---------------------------------------------------------------------------

const CAT_PEOPLE =
  /(heißt|name ist|person|mensch|kollege|kollegin|freund|partner|chef|user|nutzer|anwender|benutzer|mag\b|bevorzugt|hasst|liebt|geboren|geburtstag|rolle|zuständig|verantwortlich|team\b|arbeitet\b|lebt\b|wohnt|called|named|person|friend|colleague|boss|partner|prefers|likes|hates|lives|works\b|birthday|role\b)/i;

const CAT_DECISIONS =
  /(entschied|beschloss|entscheidung|decision|decided|chose|choice|wir nehmen|wir nutzen|wir verwenden|ab jetzt|von nun an|going forward|we'll use|we chose|ab sofort|festgelegt|vereinbart|agreed|policy|regel\b|rule\b)/i;

const CAT_PROJECTS =
  /(projekt|project|feature|milestone|sprint|release|deploy|migration|refactor|implementier|roadmap|backlog|ticket|issue|branch|repository|repo\b|deadline|launch|version|v\d)/i;

const CAT_TOPICS =
  /(wie funktioniert|how does|erklärt|explained|architektur|architecture|pattern|konzept|concept|algorithmus|algorithm|protocol|standard|framework|library|bibliothek|theorie|theory)/i;

function detectCategory(text: string): "people" | "projects" | "topics" | "decisions" | "general" {
  // Order matters: people first (most specific), then decisions, projects, topics
  if (CAT_PEOPLE.test(text)) return "people";
  if (CAT_DECISIONS.test(text)) return "decisions";
  if (CAT_PROJECTS.test(text)) return "projects";
  if (CAT_TOPICS.test(text)) return "topics";
  return "general";
}

// ---------------------------------------------------------------------------
// Tag auto-extraction
// ---------------------------------------------------------------------------

/** Extract plausible tags from text: quoted strings, CamelCase, proper nouns */
function extractTags(text: string): string[] {
  const tags = new Set<string>();

  // Quoted strings (single or double)
  for (const m of text.matchAll(/["„"]([^"„""]{2,30})["""]/g)) {
    tags.add(m[1].toLowerCase().trim());
  }
  for (const m of text.matchAll(/['‚']([^'‚'']{2,30})['‚'']/g)) {
    tags.add(m[1].toLowerCase().trim());
  }

  // CamelCase / PascalCase identifiers (likely tool/project/class names)
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    tags.add(m[1].toLowerCase());
  }

  // Words that look like proper nouns (capitalized, not at sentence start)
  // We split by sentence-enders and check non-first words
  const sentences = text.split(/[.!?]\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).slice(1); // skip first word
    for (const w of words) {
      const cleaned = w.replace(/[^a-zA-ZäöüÄÖÜß-]/g, "");
      if (cleaned.length >= 2 && /^[A-ZÄÖÜ]/.test(cleaned) && !/^(Der|Die|Das|Ein|Eine|Und|Oder|Aber|Wenn|Weil|Dass|The|And|Or|But|When|If|This|That|It|He|She|They|We|I|My|His|Her|Its)$/.test(cleaned)) {
        tags.add(cleaned.toLowerCase());
      }
    }
  }

  return [...tags].slice(0, 8); // cap at 8 tags
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function absorb(
  service: MemoryService,
  input: z.infer<typeof absorbSchema>
) {
  // Build the content: text + context if provided
  const content = input.context
    ? `${input.text}\n\nKontext: ${input.context}`
    : input.text;

  const category = detectCategory(content);
  const tags = extractTags(content);

  // MemoryService.create() handles:
  //  - heuristic scoring (importance, valence, arousal)
  //  - embedding generation
  //  - duplicate detection (>0.92 similarity → touch instead)
  //  - Hebbian seeding (link to neighbors)
  //  - interference (weaken similar old traces)
  const memory = await service.create({
    content,
    category,
    tags,
    source: "absorb",
  });

  const wasDuplicate = memory.source !== "absorb"; // create() returns existing if duplicate
  const preview = input.text.slice(0, 80) + (input.text.length > 80 ? "..." : "");

  if (wasDuplicate) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Already knew this — reinforced existing memory instead. "${preview}" [id: ${memory.id}]`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Absorbed (${category}, ${tags.length} tags): "${preview}" [id: ${memory.id}]`,
      },
    ],
  };
}
