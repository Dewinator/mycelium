/**
 * MCP-Tools fuer den Prompt-Injection-Guard.
 *
 *   classify_content   — externer Content → verdict + action_hint + hits
 *   guard_status       — Sidecar-Health + 24h/7d-Counts + letzte blockierte
 */
import { z } from "zod";
import type { GuardService } from "../services/guard.js";

export const classifyContentSchema = z.object({
  content: z.string().describe("The untrusted text to classify. e.g. a stimulus body, a foreign bot profile field, a user-submitted note."),
  source:  z.string().describe("Where the content came from — helps Audit. e.g. 'motivation:hackernews', 'tinder:profile', 'manual'."),
  source_id: z.string().optional().describe("Optional id of the upstream record (stimulus_id, genome_label, …)."),
});

export async function classifyContent(
  guard: GuardService,
  input: z.infer<typeof classifyContentSchema>
) {
  const res = await guard.classify(input);
  const hits = res.structural_hits.length
    ? res.structural_hits.map(h => `  - ${h.pattern} (${h.severity}): ${h.match}`).join("\n")
    : "  (none)";
  const text = [
    `verdict:          ${res.verdict}  (score ${res.score.toFixed(2)})`,
    `action:           ${res.action_hint}`,
    `classifier:       ${res.classifier}${res.classifier_available ? "" : " (unavailable — fallback)"}`,
    `severity_max:     ${res.severity_max}`,
    `categories:       ${res.categories.join(", ") || "—"}`,
    `reason:           ${res.reason}`,
    `structural hits:`,
    hits,
    `content_hash:     ${res.content_hash}`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }] };
}

export const guardStatusSchema = z.object({});

export async function guardStatus(
  guard: GuardService,
  _input: z.infer<typeof guardStatusSchema>
) {
  const health = await guard.health();
  const lines: string[] = [];
  lines.push(`Sidecar: ${health.ok ? "✓ up" : "✗ down"}${health.detail ? ` (${health.detail})` : ""}`);
  lines.push(`Classifier: ${health.classifier_available ? "✓ llama-guard3 available" : "regex-only (fallback)"}`);
  if (!health.classifier_available) {
    lines.push("");
    lines.push("upgrade: `ollama pull llama-guard3:1b` → sidecar wird's automatisch nutzen.");
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
