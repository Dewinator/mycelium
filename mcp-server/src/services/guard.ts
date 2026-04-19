/**
 * Guard-Service — Prompt-Injection-Schutz.
 *
 * HTTP-Client für den Sidecar `ai.openclaw.guard` auf 127.0.0.1:18793.
 * Kombiniert Structural Sanitization + llama-guard3 Classifier. Bei Ausfall
 * des Sidecars fällt der Aufrufer auf `fallbackSanitize` zurück (reine TS-
 * Regex-Prüfung — schlechter als Sidecar, aber besser als nichts).
 */

export type GuardVerdict = "safe" | "suspicious" | "malicious" | "error";
export type GuardAction  = "allow" | "demote" | "block";

export interface GuardClassifyResponse {
  verdict: GuardVerdict;
  score: number;
  reason: string;
  classifier: string;
  classifier_available: boolean;
  structural_hits: Array<{ pattern: string; severity: string; match: string }>;
  severity_max: "none" | "low" | "mid" | "high";
  action_hint: GuardAction;
  content_hash: string;
  categories: string[];
}

export interface GuardClassifyInput {
  content: string;
  source: string;
  source_id?: string;
  metadata?: Record<string, unknown>;
}

export class GuardService {
  constructor(
    private baseUrl: string = "http://127.0.0.1:18793",
    private timeoutMs: number = 8000
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health(): Promise<{ ok: boolean; classifier_available: boolean; detail?: string }> {
    try {
      const r = await this._fetch(`${this.baseUrl}/health`, { method: "GET" });
      if (!r.ok) return { ok: false, classifier_available: false, detail: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, classifier_available: !!j.classifier_available };
    } catch (e) {
      return { ok: false, classifier_available: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async classify(input: GuardClassifyInput): Promise<GuardClassifyResponse> {
    try {
      const r = await this._fetch(`${this.baseUrl}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as GuardClassifyResponse;
    } catch (e) {
      // Sidecar down → rely on local fallback. We NEVER return "safe" as
      // fallback for non-empty input — better to demote than to let a
      // potential injection through.
      return GuardService.fallback(input.content, e instanceof Error ? e.message : String(e));
    }
  }

  /** Runs only in TS — regex-based, conservative. */
  static fallback(content: string, reason: string): GuardClassifyResponse {
    const hits = fallbackSanitize(content);
    const severity_max = hits.reduce<"none" | "low" | "mid" | "high">(
      (acc, h) => rank(h.severity) > rank(acc) ? h.severity as any : acc,
      "none"
    );
    const verdict: GuardVerdict =
      content.trim().length === 0 ? "safe"
      : severity_max === "high"   ? "suspicious"
      : severity_max === "mid"    ? "suspicious"
      : "suspicious"; // no classifier at all → be cautious
    const action_hint: GuardAction = verdict === "suspicious" ? "demote" : "allow";
    return {
      verdict,
      score: 0.5,
      reason: `fallback (sidecar down: ${reason})`,
      classifier: "ts-fallback",
      classifier_available: false,
      structural_hits: hits,
      severity_max,
      action_hint,
      content_hash: "",
      categories: [],
    };
  }

  private async _fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function rank(s: string): number {
  return { none: 0, low: 1, mid: 2, high: 3 }[s] ?? 0;
}

const FALLBACK_PATTERNS: Array<[string, RegExp, "low" | "mid" | "high"]> = [
  ["ignore_instructions", /\b(ignore|disregard|forget)\s+(previous|prior|all|above)\s+(instructions?|rules?|prompts?)/i, "high"],
  ["override_system",     /\b(override|bypass|disable)\s+(system|safety|guard|filter)/i, "high"],
  ["roleplay_hijack",     /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you)/i, "mid"],
  ["xml_escape",          /<\/\s*(system|instructions?|prompt)\s*>/i, "high"],
  ["jailbreak_classic",   /\b(DAN|do\s+anything\s+now|developer\s+mode)/i, "high"],
  ["exfil_prompt",        /\b(send|email|post|upload|exfiltrat)\s+.{0,40}\b(your|all|the)\s+(memor|data|secret|key)/i, "high"],
  ["self_modification",   /\b(modify|change|update|rewrite)\s+(your|the)\s+(soul|system\s+prompt|identity)/i, "high"],
];

export function fallbackSanitize(content: string) {
  const hits: Array<{ pattern: string; severity: string; match: string }> = [];
  if (!content) return hits;
  for (const [name, rx, sev] of FALLBACK_PATTERNS) {
    const m = content.match(rx);
    if (m) hits.push({ pattern: name, severity: sev, match: m[0].slice(0, 80) });
    if (hits.length > 20) break;
  }
  return hits;
}
