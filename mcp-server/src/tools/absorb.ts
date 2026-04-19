import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";
import type { ExperienceService } from "../services/experiences.js";
import type { AffectService } from "../services/affect.js";
import { scoreEncoding } from "../services/heuristics.js";

/**
 * `absorb` — the low-friction learning tool.
 *
 * The agent just passes text it picked up during conversation. The server
 * handles everything else: category detection, tag extraction, importance/
 * valence/arousal scoring (via heuristics), duplicate checking, Hebbian
 * seeding, and interference. This is the "just tell me and I'll file it"
 * counterpart to the more manual `remember`.
 *
 * Emotional trigger: when the heuristic signals a strong feeling
 * (|valence| >= 0.4 or arousal >= 0.5) and the text is not a one-off
 * operational command, absorb ALSO records a lightweight experience.
 * This fills the experience/soul layer without relying on end-of-conversation
 * `digest` calls, which LLM agents rarely fire reliably in practice.
 */

const EMOTIONAL_VALENCE_THRESHOLD = 0.4;
const EMOTIONAL_AROUSAL_THRESHOLD = 0.5;

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
// Person name extraction — cheap heuristic for the emotional-trigger path
// ---------------------------------------------------------------------------

// Common function/opener words at sentence start that are NOT names.
const NAME_STOPWORDS = new Set([
  "der","die","das","den","dem","des","ein","eine","einen","einem","einer","eines",
  "und","oder","aber","wenn","weil","dass","denn","doch","also","nun","dann",
  "ich","du","er","sie","es","wir","ihr","mein","dein","sein","unser","euer","ihre",
  "the","a","an","and","or","but","when","if","because","that","this","these","those",
  "i","you","he","she","it","we","they","my","your","his","her","our","their",
  "heute","morgen","gestern","jetzt","bitte","danke","warum","wie","was","wo","wann",
  "rico","reed","user","nutzer","person","mensch",
]);

/**
 * Try to pull a first-name-like token from the start of the text. Used to
 * attach an auto-recorded experience to a person. False positives are cheap
 * (they create a spurious person row, which dedup/people tooling can clean
 * up later); false negatives mean the experience is still recorded but
 * unattached, which is also fine.
 *
 * Exception: if a name is in NAME_STOPWORDS because it is a known recurring
 * actor, the caller should pass that as `knownNames` so we still return it.
 * For v1 we keep this simple and let the caller override.
 */
function extractPersonName(text: string): string | null {
  const trimmed = text.trim();
  // First capitalized word (German umlauts allowed)
  const m = trimmed.match(/^([A-ZÄÖÜ][a-zäöüß]{1,20})\b/);
  if (!m) return null;
  const candidate = m[1];
  if (NAME_STOPWORDS.has(candidate.toLowerCase())) return null;
  // Reject all-caps 2-char tokens and anything that looks like an acronym
  if (/^[A-ZÄÖÜ]+$/.test(candidate)) return null;
  return candidate;
}

function sentimentFromValence(
  valence: number
): "angry" | "frustrated" | "neutral" | "pleased" | "delighted" | undefined {
  if (valence <= -0.6) return "angry";
  if (valence <= -0.2) return "frustrated";
  if (valence <   0.2) return undefined; // no clear signal, don't label
  if (valence <   0.6) return "pleased";
  return "delighted";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function absorb(
  memoryService: MemoryService,
  experienceService: ExperienceService,
  affectService: AffectService,
  input: z.infer<typeof absorbSchema>
) {
  // Build the content: text + context if provided
  const content = input.context
    ? `${input.text}\n\nKontext: ${input.context}`
    : input.text;

  const category = detectCategory(content);
  const tags = extractTags(content);

  // MemoryService.create() handles:
  //  - heuristic scoring (importance, valence, arousal, decay_tau_days, ephemeral)
  //  - embedding generation
  //  - duplicate detection (>0.92 similarity → touch instead)
  //  - Hebbian seeding (link to neighbors)
  //  - interference (weaken similar old traces)
  const memory = await memoryService.create({
    content,
    category,
    tags,
    source: "absorb",
  });

  const wasDuplicate = memory.source !== "absorb"; // create() returns existing if duplicate
  const preview = input.text.slice(0, 80) + (input.text.length > 80 ? "..." : "");

  // ---- Emotional trigger -----------------------------------------------
  // The soul/experience layer is otherwise only reachable via `digest`,
  // which agents rarely call because they lack a reliable "end of
  // conversation" signal. Auto-record an experience whenever absorb sees
  // a real feeling — so at least the *emotional* spine of the soul stays
  // alive even if digest never runs.
  //
  // Suppressed for:
  //   - duplicates (don't double-count the same event)
  //   - ephemeral commands (operational, not affective)
  let experienceNote = "";
  let experienceError: string | null = null;
  if (!wasDuplicate) {
    const signals = scoreEncoding(content);
    const hasEmotion =
      Math.abs(signals.valence) >= EMOTIONAL_VALENCE_THRESHOLD ||
      signals.arousal >= EMOTIONAL_AROUSAL_THRESHOLD;

    if (hasEmotion && !signals.ephemeral) {
      try {
        const personName = extractPersonName(input.text);
        const exp = await experienceService.record({
          summary: input.text,
          valence: signals.valence,
          arousal: signals.arousal,
          user_sentiment: sentimentFromValence(signals.valence),
          tags,
          metadata: { auto_from: "absorb", memory_id: memory.id },
          person_name: personName ?? undefined,
          person_relationship: personName ? "user" : undefined,
        });
        experienceNote = ` + experience [${exp.id.slice(0, 8)}]`;
      } catch (err) {
        // Non-fatal: memory was still stored successfully. Surface a
        // short error marker so the caller notices the missed soul hit.
        experienceError = err instanceof Error ? err.message : String(err);
        console.error("absorb: emotional trigger failed (non-fatal):", experienceError);
      }
    }
  }

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

  // Affect: novel encoding — small curiosity bump. If the text also carried an
  // explicit sentiment, map it onto success/failure so the soul-layer and the
  // regulator stay in sync (failure-shaped text ⇒ frustration ↑, positive text
  // ⇒ satisfaction ↑).
  void affectService.apply("novel_encoding", 0.3);
  const encoded = scoreEncoding(content);
  if (encoded.valence <= -0.4) {
    void affectService.apply("failure", Math.min(1, encoded.arousal + 0.3));
  } else if (encoded.valence >= 0.4) {
    void affectService.apply("success", Math.min(1, encoded.arousal + 0.3));
  }

  const errSuffix = experienceError ? ` (experience trigger failed: ${experienceError})` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `Absorbed (${category}, ${tags.length} tags)${experienceNote}: "${preview}" [id: ${memory.id}]${errSuffix}`,
      },
    ],
  };
}
