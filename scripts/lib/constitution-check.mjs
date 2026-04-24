/**
 * constitution-check.mjs — shared helpers around CONSTITUTION.md.
 *
 * The Constitution is the ground truth for the autonomy loop. These helpers
 * let the bootstrap, tick, auto-merger, and pre-push hook agree on one
 * definition of "is this compliant?". Pure text analysis — no network,
 * no LLM. Fail-closed: if we cannot find the file or cannot read it, every
 * check fails.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONSTITUTION_PATH = path.resolve(__dirname, "../../CONSTITUTION.md");

const PILLAR_HEADINGS = [
  "Decentralized, networked AI",
  "Agent reproduction",
  "Swarm intelligence",
  "Microtransactions",
  "Experts in the swarm",
  "Cyber security",
];

const REQUIRED_MARKERS = ["HARD RULE", ...PILLAR_HEADINGS];

export async function loadConstitution() {
  const text = await fs.readFile(CONSTITUTION_PATH, "utf8");
  return text;
}

export function pillarsMissingFrom(text) {
  return REQUIRED_MARKERS.filter((m) => !text.includes(m));
}

export async function assertConstitutionIntact() {
  const text = await loadConstitution();
  const missing = pillarsMissingFrom(text);
  if (missing.length > 0) {
    throw new Error(
      `Constitution missing required markers: ${missing.join(", ")}. ` +
      `Refusing to proceed — a weakened Constitution halts the loop.`
    );
  }
  return text;
}

/**
 * Check a git diff (unified diff text) for lines that remove or weaken
 * Constitution text. Heuristic but fail-closed: any `-` line inside
 * CONSTITUTION.md that removes a pillar heading or "HARD RULE" marker
 * is a violation.
 */
export function diffTouchesConstitution(diff) {
  if (!diff || typeof diff !== "string") return { touched: false, violations: [] };
  const inConstitution =
    diff.includes("diff --git a/CONSTITUTION.md") ||
    diff.includes("+++ b/CONSTITUTION.md") ||
    diff.includes("--- a/CONSTITUTION.md");
  if (!inConstitution) return { touched: false, violations: [] };

  const violations = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    for (const marker of REQUIRED_MARKERS) {
      if (line.includes(marker)) {
        violations.push(`removes "${marker}": ${line.slice(0, 120)}`);
      }
    }
  }
  return { touched: true, violations };
}

/**
 * Does a plan/issue/PR-body text acknowledge the Constitution? Cheap check —
 * we want at least one mention of "Constitution" plus at least one pillar
 * heading, so an autonomous author cannot silently skip the affirmation.
 */
export function textAffirmsConstitution(text) {
  if (!text) return false;
  if (!/constitution/i.test(text)) return false;
  return PILLAR_HEADINGS.some((p) => text.toLowerCase().includes(p.toLowerCase()));
}

export const PILLARS = Object.freeze([...PILLAR_HEADINGS]);
