/**
 * HTTP client for the PyMDP belief sidecar (Ebene 3 der Cognitive Architecture).
 *
 * Sidecar runs as `ai.openclaw.belief` LaunchAgent on 127.0.0.1:18790 and
 * exposes an Active Inference agent that selects between recall / research /
 * ask_teacher based on the current recall evidence and a generative model
 * of task familiarity.
 *
 * The client is deliberately tolerant — if the sidecar is down, `infer`
 * returns a null result and the caller falls back to a simple heuristic.
 * Belief inference is an optimisation, not load-bearing.
 */

export type BeliefAction = "recall" | "research" | "ask_teacher";
export type BeliefState = "known" | "partial" | "unknown";

export interface BeliefInferResponse {
  action: BeliefAction;
  action_index: number;
  state: BeliefState;
  state_prior: number[];        // [P(known), P(partial), P(unknown)]
  policy_posterior: number[];   // softmax over -EFE
  efe_per_policy: number[];     // lower is better
  epistemic_value: number;      // entropy of prior
  rationale: string;
}

export class BeliefService {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl = "http://127.0.0.1:18790", timeoutMs = 4000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this._fetch(`${this.baseUrl}/health`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async infer(
    taskDescription: string,
    recallScore: number,
    numHits: number,
    serotonin?: number
  ): Promise<BeliefInferResponse | null> {
    try {
      const body: Record<string, unknown> = {
        task_description: taskDescription,
        recall_score: Math.max(0, Math.min(1, recallScore)),
        num_hits: Math.max(0, Math.floor(numHits)),
      };
      if (typeof serotonin === "number") body.serotonin = Math.max(0, Math.min(1, serotonin));
      const res = await this._fetch(`${this.baseUrl}/infer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`belief sidecar /infer → HTTP ${res.status}: ${body}`);
        return null;
      }
      return (await res.json()) as BeliefInferResponse;
    } catch (err) {
      console.error(
        "belief sidecar unreachable (non-fatal):",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  /** Fallback inference when the sidecar is unreachable. Simple thresholds. */
  static fallback(recallScore: number, numHits: number): BeliefInferResponse {
    const score = Math.max(0, Math.min(1, recallScore));
    if (numHits === 0) {
      return {
        action: "research",
        action_index: 1,
        state: "unknown",
        state_prior: [0.05, 0.15, 0.8],
        policy_posterior: [0.2, 0.5, 0.3],
        efe_per_policy: [0, 0, 0],
        epistemic_value: 0.61,
        rationale: "Fallback (sidecar unreachable): no hits → research.",
      };
    }
    if (score >= 0.85) {
      return {
        action: "recall",
        action_index: 0,
        state: "known",
        state_prior: [0.8, 0.15, 0.05],
        policy_posterior: [0.7, 0.2, 0.1],
        efe_per_policy: [0, 0, 0],
        epistemic_value: 0.4,
        rationale: "Fallback: high recall score → recall.",
      };
    }
    if (score >= 0.6) {
      return {
        action: "research",
        action_index: 1,
        state: "partial",
        state_prior: [0.2, 0.6, 0.2],
        policy_posterior: [0.3, 0.5, 0.2],
        efe_per_policy: [0, 0, 0],
        epistemic_value: 0.7,
        rationale: "Fallback: moderate recall score → research.",
      };
    }
    return {
      action: "ask_teacher",
      action_index: 2,
      state: "unknown",
      state_prior: [0.05, 0.25, 0.7],
      policy_posterior: [0.1, 0.3, 0.6],
      efe_per_policy: [0, 0, 0],
      epistemic_value: 0.5,
      rationale: "Fallback: weak recall → ask_teacher.",
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
