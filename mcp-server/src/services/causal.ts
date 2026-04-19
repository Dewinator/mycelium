import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Causal annotation layer on top of experiences.
 *
 * Not a Pearl-style causal model — this is an explicit annotation scheme:
 * the agent (or the user) marks "A caused B", "A enabled B", "A prevented B"
 * between existing experience episodes. `suggest_causes` proposes plausible
 * candidates via time-window + semantic similarity; humans or the agent's
 * digest loop promote them into recorded edges.
 */

export type CausalRelation = "caused" | "enabled" | "prevented" | "contributed";
export type CausalSource =
  | "auto_suggest"
  | "digest_extracted"
  | "explicit"
  | "user_confirmed";

export interface CauseSuggestion {
  cause_id: string;
  summary: string;
  similarity: number;
  age_hours: number;
  outcome: string;
  confidence_hint: number;
}

export interface CausalChainNode {
  experience_id: string;
  summary: string;
  outcome: string;
  depth: number;
  relation: string | null;
  edge_confidence: number;
  path_confidence: number;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export class CausalService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async suggestCauses(
    effectId: string,
    windowHours = 48,
    minSimilarity = 0.55,
    max = 5
  ): Promise<CauseSuggestion[]> {
    const { data, error } = await this.db.rpc("suggest_causes", {
      p_effect_id: effectId,
      p_window_hours: windowHours,
      p_min_similarity: minSimilarity,
      p_max_results: max,
    });
    if (error) throw new Error(`suggest_causes failed: ${fmtErr(error)}`);
    return (data ?? []) as CauseSuggestion[];
  }

  async recordCause(
    causeId: string,
    effectId: string,
    relation: CausalRelation = "caused",
    confidence = 0.6,
    source: CausalSource = "explicit",
    note?: string
  ): Promise<string> {
    const { data, error } = await this.db.rpc("record_cause", {
      p_cause_id: causeId,
      p_effect_id: effectId,
      p_relation: relation,
      p_confidence: confidence,
      p_source: source,
      p_note: note ?? null,
    });
    if (error) throw new Error(`record_cause failed: ${fmtErr(error)}`);
    return data as string;
  }

  async causalChain(
    rootId: string,
    direction: "causes" | "effects" = "causes",
    maxDepth = 3
  ): Promise<CausalChainNode[]> {
    const { data, error } = await this.db.rpc("causal_chain", {
      p_root_id: rootId,
      p_direction: direction,
      p_max_depth: maxDepth,
    });
    if (error) throw new Error(`causal_chain failed: ${fmtErr(error)}`);
    return (data ?? []) as CausalChainNode[];
  }

  /**
   * Auto-ingest from digest: run suggest_causes for a freshly-recorded
   * experience and write high-confidence candidates as `digest_extracted`
   * edges. Returns how many edges were written. Errors are swallowed and
   * logged — this is opportunistic, not load-bearing.
   */
  async autoIngest(
    effectId: string,
    windowHours = 48,
    minSimilarity = 0.65,
    minConfidenceHint = 0.7,
    maxEdges = 3
  ): Promise<number> {
    try {
      const candidates = await this.suggestCauses(
        effectId,
        windowHours,
        minSimilarity,
        maxEdges
      );
      const strong = candidates.filter(
        (c) => c.confidence_hint >= minConfidenceHint
      );
      let written = 0;
      for (const c of strong) {
        try {
          await this.recordCause(
            c.cause_id,
            effectId,
            "contributed", // auto-extracted: conservative relation label
            c.confidence_hint,
            "digest_extracted"
          );
          written += 1;
        } catch (err) {
          console.error("record_cause (auto) failed:", fmtErr(err));
        }
      }
      return written;
    } catch (err) {
      console.error("causal auto-ingest failed (non-fatal):", fmtErr(err));
      return 0;
    }
  }
}
