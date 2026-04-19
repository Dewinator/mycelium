import { PostgrestClient } from "@supabase/postgrest-js";
import type { EmbeddingProvider } from "./embeddings.js";

/**
 * Experience / soul layer service.
 *
 * Three layers, all sharing one embedding space (so similarity across
 * experiences ↔ lessons ↔ traits is meaningful):
 *
 *   experiences  — raw episodes (one per task / interaction)
 *   lessons      — distilled patterns from clusters of episodes
 *   soul_traits  — stable, repeatedly-reinforced lessons → identity
 *
 * The embedding for an experience is generated from a *narrative summary*
 * (`summary` field) — that is the canonical description of the episode.
 * For lessons we embed the lesson text itself.
 */

export interface RecordExperienceInput {
  summary: string;
  session_id?: string;
  task_type?: string;
  details?: string;
  outcome?: "success" | "partial" | "failure" | "unknown";
  difficulty?: number;
  confidence_before?: number;
  confidence_after?: number;
  user_sentiment?: "frustrated" | "neutral" | "pleased" | "delighted" | "angry";
  valence?: number;
  arousal?: number;
  what_worked?: string;
  what_failed?: string;
  tools_used?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Optional person involved — auto-resolved or created by name. */
  person_name?: string;
  person_description?: string;
  person_relationship?: string;
}

export interface RecallExperienceResult {
  kind: "experience" | "lesson";
  id: string;
  content: string;
  outcome: string | null;
  difficulty: number | null;
  valence: number;
  arousal: number;
  similarity: number;
  evidence_count: number;
  created_at: string;
}

export interface ExperienceCluster {
  seed_id: string;
  seed_summary: string;
  member_ids: string[];
  member_count: number;
  avg_difficulty: number;
  avg_valence: number;
  outcomes: string[];
  /** Closest existing lesson, if any (auto-suggested by find_experience_clusters). */
  matched_lesson_id: string | null;
  matched_lesson_text: string | null;
  matched_similarity: number | null;
}

export interface SimilarLesson {
  id: string;
  lesson: string;
  similarity: number;
  evidence_count: number;
  category: string;
}

export interface PromotionCandidate {
  id: string;
  lesson: string;
  category: string;
  evidence_count: number;
  confidence: number;
  valence: number;
  created_at: string;
}

export interface SoulDrift {
  recent_days: number;
  recent_n: number;
  older_n: number;
  drift: number | null;
  computed_at: string;
}

export interface Mood {
  window_hours: number;
  n: number;
  valence: number;
  arousal: number;
  label: string;
  computed_at: string;
}

export interface Intention {
  id: string;
  intention: string;
  status: "active" | "fulfilled" | "abandoned" | "paused";
  priority: number;
  progress: number;
  evidence_count: number;
  similarity?: number | null;
  target_date: string | null;
  created_at: string;
}

export interface Person {
  id: string;
  name: string;
  relationship: string | null;
  encounter_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface TraitConflict {
  a_id: string;
  a_trait: string;
  a_polarity: number;
  a_evidence: number;
  b_id: string;
  b_trait: string;
  b_polarity: number;
  b_evidence: number;
  similarity: number;
  polarity_diff: number;
}

export interface PrimeContextStatic {
  mood: Mood;
  top_traits: Array<{ id: string; trait: string; polarity: number; evidence_count: number; weight: number }>;
  active_intentions: Array<{ id: string; intention: string; priority: number; progress: number; evidence_count: number; target_date: string | null }>;
  open_conflicts: Array<{ a_trait: string; a_polarity: number; b_trait: string; b_polarity: number; similarity: number; polarity_diff: number }>;
  recent_pattern: { last_n: number; success_rate: number | null; avg_difficulty: number };
  generated_at: string;
}

export interface NarrateSelf {
  mood: Mood;
  identity_traits: Array<{ trait: string; polarity: number; evidence_count: number }>;
  aspirations: Array<{ intention: string; priority: number; progress: number }>;
  recent_lessons: Array<{ lesson: string; evidence_count: number }>;
  closest_relationships: Array<{ name: string; relationship: string | null; encounter_count: number; last_seen_at: string }>;
  inner_tensions: Array<{ a: string; b: string; gap: number }>;
  drift_7d: SoulDrift;
  generated_at: string;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export class ExperienceService {
  private db: PostgrestClient;
  private embeddings: EmbeddingProvider;

  constructor(supabaseUrl: string, supabaseKey: string, embeddings: EmbeddingProvider) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.embeddings = embeddings;
  }

  /**
   * Record a new episode. Embedding is generated from `summary`, then the
   * episode is auto-linked to its semantic neighbors in the memories table
   * via `link_experience_to_memories` (Hebbian cross-layer fusion).
   */
  async record(input: RecordExperienceInput): Promise<{
    id: string;
    cross_links: number;
    intentions_touched: number;
    person_id: string | null;
  }> {
    const embedding = await this.embeddings.embed(input.summary);
    const { data, error } = await this.db.rpc("record_experience", {
      p_summary:           input.summary,
      p_embedding:         embedding,
      p_session_id:        input.session_id ?? null,
      p_task_type:         input.task_type ?? null,
      p_details:           input.details ?? null,
      p_outcome:           input.outcome ?? "unknown",
      p_difficulty:        input.difficulty ?? 0.5,
      p_confidence_before: input.confidence_before ?? null,
      p_confidence_after:  input.confidence_after ?? null,
      p_user_sentiment:    input.user_sentiment ?? null,
      p_valence:           input.valence ?? 0,
      p_arousal:           input.arousal ?? 0,
      p_what_worked:       input.what_worked ?? null,
      p_what_failed:       input.what_failed ?? null,
      p_tools_used:        input.tools_used ?? [],
      p_tags:              input.tags ?? [],
      p_metadata:          input.metadata ?? {},
    });
    if (error) throw new Error(`record_experience failed: ${fmtErr(error)}`);
    const id = data as string;

    // Side effects below are all best-effort (non-fatal): the experience itself
    // is saved, the soul-layer enrichments compose around it.

    // (a) cross-layer Hebbian links to semantically nearby memories
    let crossLinks = 0;
    try {
      const { data: linkCount, error: linkErr } = await this.db.rpc(
        "link_experience_to_memories",
        { p_experience_id: id, p_embedding: embedding, p_top_k: 3, p_min_similarity: 0.55 }
      );
      if (linkErr) console.error("link_experience_to_memories failed (non-fatal):", linkErr.message);
      else crossLinks = (linkCount as number) ?? 0;
    } catch (err) {
      console.error("link_experience_to_memories threw (non-fatal):", err);
    }

    // (b) intention auto-evaluation — does this episode advance any active goal?
    let intentionsTouched = 0;
    try {
      const { data: touched, error: intErr } = await this.db.rpc(
        "evaluate_intentions_for_experience",
        { p_experience_id: id, p_embedding: embedding, p_threshold: 0.65, p_step: 0.10 }
      );
      if (intErr) console.error("evaluate_intentions_for_experience failed (non-fatal):", intErr.message);
      else intentionsTouched = (touched as number) ?? 0;
    } catch (err) {
      console.error("evaluate_intentions_for_experience threw (non-fatal):", err);
    }

    // (c) person resolution + attachment
    let personId: string | null = null;
    if (input.person_name) {
      try {
        const personEmbedding = await this.embeddings.embed(
          [input.person_name, input.person_description].filter(Boolean).join(" — ")
        );
        const { data: pid, error: pErr } = await this.db.rpc("resolve_or_create_person", {
          p_name:         input.person_name,
          p_description:  input.person_description ?? null,
          p_embedding:    personEmbedding,
          p_relationship: input.person_relationship ?? null,
        });
        if (pErr) {
          console.error("resolve_or_create_person failed (non-fatal):", pErr.message);
        } else {
          personId = pid as string;
          await this.db.rpc("attach_person_to_experience", {
            p_experience_id: id,
            p_person_id:     personId,
          });
        }
      } catch (err) {
        console.error("person resolution threw (non-fatal):", err);
      }
    }

    return { id, cross_links: crossLinks, intentions_touched: intentionsTouched, person_id: personId };
  }

  // -------------------------------------------------------------------------
  // Mood
  // -------------------------------------------------------------------------
  async mood(windowHours = 24): Promise<Mood> {
    const { data, error } = await this.db.rpc("current_mood", { window_hours: windowHours });
    if (error) throw new Error(`current_mood failed: ${fmtErr(error)}`);
    return data as Mood;
  }

  // -------------------------------------------------------------------------
  // Intentions
  // -------------------------------------------------------------------------
  async setIntention(input: {
    intention: string;
    priority?: number;
    target_date?: string;
  }): Promise<string> {
    const embedding = await this.embeddings.embed(input.intention);
    const { data, error } = await this.db.rpc("set_intention", {
      p_intention:   input.intention,
      p_embedding:   embedding,
      p_priority:    input.priority ?? 0.5,
      p_target_date: input.target_date ?? null,
    });
    if (error) throw new Error(`set_intention failed: ${fmtErr(error)}`);
    return data as string;
  }

  async updateIntentionStatus(id: string, status: Intention["status"]): Promise<void> {
    const { error } = await this.db.rpc("update_intention_status", { p_id: id, p_status: status });
    if (error) throw new Error(`update_intention_status failed: ${fmtErr(error)}`);
  }

  async recallIntentions(opts: { query?: string; status?: string; limit?: number } = {}): Promise<Intention[]> {
    const queryEmbedding = opts.query ? await this.embeddings.embed(opts.query) : null;
    const { data, error } = await this.db.rpc("recall_intentions", {
      query_embedding: queryEmbedding,
      filter_status:   opts.status ?? "active",
      match_count:     opts.limit ?? 10,
    });
    if (error) throw new Error(`recall_intentions failed: ${fmtErr(error)}`);
    return (data ?? []) as Intention[];
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  async recallPerson(personId: string, limit = 10): Promise<unknown> {
    const { data, error } = await this.db.rpc("recall_person", {
      p_person_id: personId,
      p_limit:     limit,
    });
    if (error) throw new Error(`recall_person failed: ${fmtErr(error)}`);
    return data;
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------
  async findConflicts(simThreshold = 0.65, polarityGap = 0.5): Promise<TraitConflict[]> {
    const { data, error } = await this.db.rpc("find_trait_conflicts", {
      similarity_threshold: simThreshold,
      polarity_gap:         polarityGap,
    });
    if (error) throw new Error(`find_trait_conflicts failed: ${fmtErr(error)}`);
    return (data ?? []) as TraitConflict[];
  }

  async resolveConflict(winnerId: string, loserId: string): Promise<void> {
    const { error } = await this.db.rpc("resolve_trait_conflict", {
      p_winner_id: winnerId,
      p_loser_id:  loserId,
    });
    if (error) throw new Error(`resolve_trait_conflict failed: ${fmtErr(error)}`);
  }

  async synthesizeConflict(
    aId: string,
    bId: string,
    newTrait: string,
    polarity = 0
  ): Promise<string> {
    const embedding = await this.embeddings.embed(newTrait);
    const { data, error } = await this.db.rpc("synthesize_trait_conflict", {
      p_a_id:      aId,
      p_b_id:      bId,
      p_new_trait: newTrait,
      p_polarity:  polarity,
      p_embedding: embedding,
    });
    if (error) throw new Error(`synthesize_trait_conflict failed: ${fmtErr(error)}`);
    return data as string;
  }

  // -------------------------------------------------------------------------
  // Prime / Narrate — output channels for the soul
  // -------------------------------------------------------------------------
  async primeContextStatic(): Promise<PrimeContextStatic> {
    const { data, error } = await this.db.rpc("prime_context_static");
    if (error) throw new Error(`prime_context_static failed: ${fmtErr(error)}`);
    return data as PrimeContextStatic;
  }

  async narrateSelf(): Promise<NarrateSelf> {
    const { data, error } = await this.db.rpc("narrate_self");
    if (error) throw new Error(`narrate_self failed: ${fmtErr(error)}`);
    return data as NarrateSelf;
  }

  async narrateNeurochem(label: string): Promise<{ exists: boolean; text: string }> {
    const { data, error } = await this.db.rpc("narrate_neurochem", { p_label: label });
    if (error) throw new Error(`narrate_neurochem failed: ${fmtErr(error)}`);
    return data as { exists: boolean; text: string };
  }

  /** Strongest signal: this past episode actually informed a later decision. */
  async markUseful(experienceId: string): Promise<void> {
    const { error } = await this.db.rpc("mark_experience_useful", {
      p_experience_id: experienceId,
    });
    if (error) throw new Error(`mark_experience_useful failed: ${fmtErr(error)}`);
  }

  /** Find existing lessons whose embedding is close to the query text. */
  async findSimilarLesson(query: string, threshold = 0.8): Promise<SimilarLesson[]> {
    const embedding = await this.embeddings.embed(query);
    const { data, error } = await this.db.rpc("find_similar_lesson", {
      query_embedding:      embedding,
      similarity_threshold: threshold,
    });
    if (error) throw new Error(`find_similar_lesson failed: ${fmtErr(error)}`);
    return (data ?? []) as SimilarLesson[];
  }

  async dedupLessons(threshold = 0.92): Promise<number> {
    const { data, error } = await this.db.rpc("dedup_lessons", { similarity_threshold: threshold });
    if (error) throw new Error(`dedup_lessons failed: ${fmtErr(error)}`);
    return (data as number) ?? 0;
  }

  async promotionCandidates(minEvidence = 4, minConfidence = 0.7): Promise<PromotionCandidate[]> {
    const { data, error } = await this.db.rpc("find_promotion_candidates", {
      min_evidence:    minEvidence,
      min_confidence:  minConfidence,
    });
    if (error) throw new Error(`find_promotion_candidates failed: ${fmtErr(error)}`);
    return (data ?? []) as PromotionCandidate[];
  }

  async drift(recentDays = 7): Promise<SoulDrift> {
    const { data, error } = await this.db.rpc("soul_drift", { recent_days: recentDays });
    if (error) throw new Error(`soul_drift failed: ${fmtErr(error)}`);
    return data as SoulDrift;
  }

  /** Semantic recall over experiences (and optionally lessons). */
  async recall(
    query: string,
    opts: { limit?: number; outcome?: string; includeLessons?: boolean } = {}
  ): Promise<RecallExperienceResult[]> {
    const embedding = await this.embeddings.embed(query);
    const { data, error } = await this.db.rpc("recall_experiences", {
      query_embedding: embedding,
      query_text:      query,
      match_count:     opts.limit ?? 8,
      filter_outcome:  opts.outcome ?? null,
      include_lessons: opts.includeLessons ?? true,
    });
    if (error) throw new Error(`recall_experiences failed: ${fmtErr(error)}`);
    return (data ?? []) as RecallExperienceResult[];
  }

  /** REM-sleep clustering: find groups of similar unreflected episodes. */
  async findClusters(
    similarityThreshold = 0.85,
    minClusterSize = 2,
    maxAgeDays = 30
  ): Promise<ExperienceCluster[]> {
    const { data, error } = await this.db.rpc("find_experience_clusters", {
      similarity_threshold: similarityThreshold,
      min_cluster_size:     minClusterSize,
      max_age_days:         maxAgeDays,
    });
    if (error) throw new Error(`find_experience_clusters failed: ${fmtErr(error)}`);
    return (data ?? []) as ExperienceCluster[];
  }

  /** Store a synthesised lesson (LLM-written) and mark sources reflected. */
  async recordLesson(
    lesson: string,
    sourceIds: string[],
    opts: { category?: string; confidence?: number } = {}
  ): Promise<string> {
    const embedding = await this.embeddings.embed(lesson);
    const { data, error } = await this.db.rpc("record_lesson", {
      p_lesson:     lesson,
      p_embedding:  embedding,
      p_source_ids: sourceIds,
      p_category:   opts.category ?? "general",
      p_confidence: opts.confidence ?? 0.6,
    });
    if (error) throw new Error(`record_lesson failed: ${fmtErr(error)}`);
    return data as string;
  }

  async reinforceLesson(lessonId: string, sourceIds: string[]): Promise<void> {
    const { error } = await this.db.rpc("reinforce_lesson", {
      p_lesson_id:  lessonId,
      p_source_ids: sourceIds,
    });
    if (error) throw new Error(`reinforce_lesson failed: ${fmtErr(error)}`);
  }

  async promoteToTrait(
    lessonId: string,
    trait: string,
    polarity = 0
  ): Promise<string> {
    const embedding = await this.embeddings.embed(trait);
    const { data, error } = await this.db.rpc("promote_lesson_to_trait", {
      p_lesson_id: lessonId,
      p_trait:     trait,
      p_polarity:  polarity,
      p_embedding: embedding,
    });
    if (error) throw new Error(`promote_lesson_to_trait failed: ${fmtErr(error)}`);
    return data as string;
  }

  /** Single-roundtrip dashboard snapshot. */
  async stats(): Promise<unknown> {
    const { data, error } = await this.db.rpc("soul_stats");
    if (error) throw new Error(`soul_stats failed: ${fmtErr(error)}`);
    return data;
  }
}
