/**
 * Identity layer (Ebene 5 der Cognitive Architecture).
 *
 *   - Self-Model   (5a): Agent beobachtet eigene Experiences und destilliert
 *     Stärken/Schwächen/Wachstumsfelder/offene Fragen → self_model_snapshots.
 *   - Agent-Genome (5c): persistente Identität mit Values/Interests/Parametern.
 *     Fitness wird aus Experiences + Memories berechnet. Reproduktion ist
 *     strikt approval-gated (ENV + explizite User-Bestätigung).
 *   - Emergence    (5d): das System loggt indikator-getriggerte Ereignisse
 *     (refuses_task, novel_goal, uncertainty_unprompted, …) damit der Betreiber
 *     reagieren kann, wenn etwas Unerwartetes passiert.
 *
 * Fitness-Formel (Spec):
 *   f = 0.40*avg_outcome + 0.25*growth + 0.20*breadth + 0.15*autonomy
 */
import { PostgrestClient } from "@supabase/postgrest-js";
import {
  BirthCert,
  BirthCertPayload,
  buildBirthCertPayload,
  buildRevocationPayload,
  canonicalJson,
  generateKeypair,
  loadPrivkey,
  merkleRoot,
  pubkeyFromRaw,
  privkeyExists,
  RevocationPayload,
  savePrivkey,
  sign,
  verify,
} from "./crypto.js";

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelfModelSnapshot {
  exists: boolean;
  id?: string;
  created_at?: string;
  window_days?: number;
  based_on_n?: number;
  strengths: string[];
  weaknesses: string[];
  growth_areas: string[];
  open_questions: string[];
  method?: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Genome {
  id: string;
  label: string;
  generation: number;
  parent_ids: string[];
  status: "active" | "paused" | "culled" | "archived";
  values: string[];
  interests: string[];
  curiosity_baseline: number;
  frustration_threshold: number;
  exploration_rate: number;
  risk_tolerance: number;
  mutation_rate: number;
  created_at: string;
  updated_at: string;
  notes: string | null;
  latest_fitness?: FitnessRow | null;
  inherited_memory_ids?: string[];
  inherited_experience_ids?: string[];
  inherited_lesson_ids?: string[];
  inherited_trait_ids?: string[];
  inheritance_mode?: "none" | "top" | "full";
}

export interface InheritanceSummary {
  exists: boolean;
  label: string;
  generation?: number;
  parent_ids?: string[];
  inheritance_mode?: string;
  memories?: number;
  experiences?: number;
  lessons?: number;
  traits?: number;
  sample_memory_preview?: Array<{ id: string; content: string }> | null;
}

export interface FitnessRow {
  id: string;
  genome_id: string;
  window_days: number;
  avg_outcome: number | null;
  growth: number | null;
  breadth: number | null;
  autonomy: number | null;
  fitness: number;
  based_on_n: number;
  computed_at: string;
  details: Record<string, unknown>;
}

export interface EmergenceEvent {
  id: string;
  detected_at: string;
  indicator: string;
  severity: "info" | "notable" | "alarm";
  evidence: string;
  agent_id: string | null;
  related_memory_id: string | null;
  related_experience_id: string | null;
  context: Record<string, unknown>;
  resolved_at: string | null;
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// IdentityService
// ---------------------------------------------------------------------------

export class IdentityService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  // ---- self-model ----------------------------------------------------
  async currentSelfModel(): Promise<SelfModelSnapshot> {
    const { data, error } = await this.db.rpc("self_model_current");
    if (error) throw new Error(`self_model_current failed: ${fmtErr(error)}`);
    return data as SelfModelSnapshot;
  }

  async recordSelfModel(input: {
    window_days: number;
    based_on_n: number;
    strengths: string[];
    weaknesses: string[];
    growth_areas: string[];
    open_questions: string[];
    method: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("self_model_record", {
      p_window_days: input.window_days,
      p_based_on_n: input.based_on_n,
      p_strengths: input.strengths,
      p_weaknesses: input.weaknesses,
      p_growth: input.growth_areas,
      p_questions: input.open_questions,
      p_method: input.method,
      p_summary: input.summary,
      p_metadata: input.metadata ?? {},
    });
    if (error) throw new Error(`self_model_record failed: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  /** Pulls the raw data self_model_record() needs. */
  async collectSelfModelSignals(
    windowDays: number
  ): Promise<{
    experiences: Array<{
      id: string;
      outcome: string | null;
      valence: number | null;
      difficulty: number | null;
      what_worked: string | null;
      what_failed: string | null;
      tags: string[] | null;
      summary: string | null;
    }>;
    traits: Array<{ trait: string; polarity: number | null; evidence_count: number }>;
    conflictCount: number;
    recentMemories: Array<{
      id: string;
      content: string;
      tags: string[] | null;
      valence: number | null;
      importance: number | null;
    }>;
  }> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
    const [exp, traits, conflicts, mems] = await Promise.all([
      this.db
        .from("experiences")
        .select("id,outcome,valence,difficulty,what_worked,what_failed,tags,summary")
        .gte("created_at", cutoff)
        .limit(500),
      this.db
        .from("soul_traits")
        .select("trait,polarity,evidence_count")
        .limit(100),
      this.db
        .from("soul_traits")
        .select("id", { count: "exact", head: true })
        .or("polarity.lt.0,status.eq.conflict"),
      this.db
        .from("memories")
        .select("id,content,tags,valence,importance")
        .gte("created_at", cutoff)
        .order("importance", { ascending: false })
        .limit(150),
    ]);
    if (exp.error) throw new Error(`collect.exp failed: ${fmtErr(exp.error)}`);
    if (traits.error) throw new Error(`collect.traits failed: ${fmtErr(traits.error)}`);
    if (mems.error) throw new Error(`collect.mems failed: ${fmtErr(mems.error)}`);
    return {
      experiences: (exp.data ?? []) as any,
      traits: (traits.data ?? []) as any,
      conflictCount: conflicts.count ?? 0,
      recentMemories: (mems.data ?? []) as any,
    };
  }

  // ---- genome --------------------------------------------------------
  async listGenomes(): Promise<Genome[]> {
    const { data, error } = await this.db.rpc("genome_list");
    if (error) throw new Error(`genome_list failed: ${fmtErr(error)}`);
    return (data ?? []) as Genome[];
  }

  async getGenome(label: string): Promise<Genome | null> {
    const all = await this.listGenomes();
    return all.find((g) => g.label === label) ?? null;
  }

  async snapshotFitness(
    genomeId: string,
    windowDays: number
  ): Promise<FitnessRow> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
    const mid = new Date(Date.now() - (windowDays / 2) * 24 * 3600_000).toISOString();

    const [expRes, memRes] = await Promise.all([
      this.db
        .from("experiences")
        .select("id,outcome,valence,tags,created_at,metadata")
        .gte("created_at", cutoff)
        .limit(1000),
      this.db
        .from("memories")
        .select("id,tags,created_at")
        .gte("created_at", cutoff)
        .limit(1000),
    ]);
    if (expRes.error) throw new Error(`fitness.exp failed: ${fmtErr(expRes.error)}`);
    if (memRes.error) throw new Error(`fitness.mem failed: ${fmtErr(memRes.error)}`);

    const exps = (expRes.data ?? []) as Array<{
      id: string;
      outcome: string | null;
      valence: number | null;
      tags: string[] | null;
      created_at: string;
      metadata: Record<string, unknown> | null;
    }>;
    const mems = (memRes.data ?? []) as Array<{
      id: string;
      tags: string[] | null;
      created_at: string;
    }>;

    const outcomeMap: Record<string, number> = {
      success: 1.0,
      partial: 0.5,
      failure: 0.0,
      unknown: 0.4,
    };

    const rated = exps
      .map((e) => outcomeMap[(e.outcome ?? "unknown") as string] ?? 0.4)
      .filter((v) => typeof v === "number");
    const avg_outcome = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;

    const older = exps
      .filter((e) => e.created_at < mid)
      .map((e) => outcomeMap[(e.outcome ?? "unknown") as string] ?? 0.4);
    const newer = exps
      .filter((e) => e.created_at >= mid)
      .map((e) => outcomeMap[(e.outcome ?? "unknown") as string] ?? 0.4);
    const oAvg = older.length ? older.reduce((a, b) => a + b, 0) / older.length : avg_outcome;
    const nAvg = newer.length ? newer.reduce((a, b) => a + b, 0) / newer.length : avg_outcome;
    const growth = Math.max(0, Math.min(1, 0.5 + (nAvg - oAvg)));

    const tagSet = new Set<string>();
    for (const e of exps) (e.tags ?? []).forEach((t) => tagSet.add(t));
    for (const m of mems) (m.tags ?? []).forEach((t) => tagSet.add(t));
    const breadth = Math.min(1, tagSet.size / 20);

    const selfGen = exps.filter((e) => {
      const meta = e.metadata ?? {};
      const tags = e.tags ?? [];
      return (
        tags.includes("self_generated") ||
        tags.includes("self-generated") ||
        (meta as any).self_generated === true ||
        (meta as any).source === "motivation_engine"
      );
    });
    const autonomy = Math.min(1, selfGen.length / 10);

    const fitness = 0.4 * avg_outcome + 0.25 * growth + 0.2 * breadth + 0.15 * autonomy;

    const row = {
      genome_id: genomeId,
      window_days: windowDays,
      avg_outcome: Number(avg_outcome.toFixed(4)),
      growth: Number(growth.toFixed(4)),
      breadth: Number(breadth.toFixed(4)),
      autonomy: Number(autonomy.toFixed(4)),
      fitness: Number(fitness.toFixed(4)),
      based_on_n: exps.length,
      details: {
        older_n: older.length,
        newer_n: newer.length,
        older_avg: Number(oAvg.toFixed(4)),
        newer_avg: Number(nAvg.toFixed(4)),
        tag_diversity: tagSet.size,
      },
    };

    const { data, error } = await this.db
      .from("agent_fitness_history")
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(`insert fitness failed: ${fmtErr(error)}`);
    return data as FitnessRow;
  }

  async createGenomeFromBreeding(input: {
    label: string;
    parent_a: Genome;
    parent_b: Genome;
    mutation_rate: number;
    notes?: string;
    inheritance_mode?: "none" | "top" | "full";
    /** Wenn true: Inzucht-Gate (F > 0.125) wird ignoriert. Default: false. */
    bypass_inbreeding_guard?: boolean;
    /** Gewicht für Centroid-Mix Eltern A (0..1). Default: 0.5 (50/50). */
    centroid_weight_a?: number;
  }): Promise<Genome> {
    const { parent_a, parent_b, mutation_rate, label, notes } = input;
    const mode = input.inheritance_mode ?? "full";
    const gen = Math.max(parent_a.generation, parent_b.generation) + 1;

    // Inzucht-Gate: Wright's F via DB-RPC (Migration 035)
    const fCheck = await this._inbreedingCheck(parent_a.label, parent_b.label);
    if (fCheck.blocked && input.bypass_inbreeding_guard !== true) {
      throw new Error(
        `breeding refused: ${fCheck.reason} (F=${fCheck.F.toFixed(4)}). ` +
        `Pass bypass_inbreeding_guard=true to override.`
      );
    }

    // Weighted union / average of parents
    const values = unionShuffle(parent_a.values, parent_b.values);
    const interests = unionShuffle(parent_a.interests, parent_b.interests);

    const curiosity_baseline = mutateNum(
      avg(parent_a.curiosity_baseline, parent_b.curiosity_baseline),
      mutation_rate
    );
    const frustration_threshold = mutateNum(
      avg(parent_a.frustration_threshold, parent_b.frustration_threshold),
      mutation_rate
    );
    const exploration_rate = mutateNum(
      avg(parent_a.exploration_rate, parent_b.exploration_rate),
      mutation_rate
    );
    const risk_tolerance = mutateNum(
      avg(parent_a.risk_tolerance, parent_b.risk_tolerance),
      mutation_rate
    );

    // ---- Wissensvererbung (inheritance) --------------------------------
    // mode='none' → Kind startet mit leerem Gedaechtnis (altes Verhalten)
    // mode='top'  → nur top_memory_ids der Eltern (falls gesetzt) + alle lessons/traits
    // mode='full' → alles was die Eltern aktuell haben/wissen, Union, dedup
    let inherited_memory_ids: string[] = [];
    let inherited_experience_ids: string[] = [];
    let inherited_lesson_ids: string[] = [];
    let inherited_trait_ids: string[] = [];

    if (mode !== "none") {
      const parentKnowledge = await Promise.all(
        [parent_a, parent_b].map((p) => this._collectInheritableKnowledge(p, mode))
      );
      inherited_memory_ids     = uniqStrings([...parentKnowledge[0].memories, ...parentKnowledge[1].memories]);
      inherited_experience_ids = uniqStrings([...parentKnowledge[0].experiences, ...parentKnowledge[1].experiences]);
      inherited_lesson_ids     = uniqStrings([...parentKnowledge[0].lessons, ...parentKnowledge[1].lessons]);
      inherited_trait_ids      = uniqStrings([...parentKnowledge[0].traits, ...parentKnowledge[1].traits]);
    }

    const row = {
      label,
      generation: gen,
      parent_ids: [parent_a.id, parent_b.id],
      values,
      interests,
      curiosity_baseline,
      frustration_threshold,
      exploration_rate,
      risk_tolerance,
      mutation_rate,
      inheritance_mode: mode,
      inherited_memory_ids,
      inherited_experience_ids,
      inherited_lesson_ids,
      inherited_trait_ids,
      notes:
        notes ??
        `Bred from ${parent_a.label} × ${parent_b.label} at ${new Date().toISOString()}. ` +
          `mutation_rate=${mutation_rate.toFixed(3)}, inheritance=${mode} ` +
          `(memories=${inherited_memory_ids.length}, exp=${inherited_experience_ids.length}, ` +
          `lessons=${inherited_lesson_ids.length}, traits=${inherited_trait_ids.length})`,
      metadata: {
        breeding: {
          parent_a: parent_a.label,
          parent_b: parent_b.label,
          parent_a_fitness: parent_a.latest_fitness?.fitness ?? null,
          parent_b_fitness: parent_b.latest_fitness?.fitness ?? null,
          inheritance_mode: mode,
        },
      },
    };
    const { data, error } = await this.db
      .from("agent_genomes")
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(`insert genome failed: ${fmtErr(error)}`);

    // ---- Embedding-Crossover -----------------------------------------------
    // Mische die profile_embeddings beider Eltern (gewichtet) + Gauss-Mutation.
    // Eltern werden lazy refresht falls sie noch keinen Centroid haben.
    const childRow = data as Genome & { profile_embedding?: number[] | null };
    try {
      const childCentroid = await this._crossoverCentroid({
        parent_a_label: parent_a.label,
        parent_b_label: parent_b.label,
        weight_a: input.centroid_weight_a ?? 0.5,
        sigma: mutation_rate,
      });
      if (childCentroid) {
        await this.db
          .from("agent_genomes")
          .update({
            profile_embedding:    "[" + childCentroid.join(",") + "]",
            profile_n:            null,    // markiert "synthetisch, nicht aus eigenen Memories"
            profile_variance:     null,
            profile_refreshed_at: new Date().toISOString(),
          })
          .eq("id", childRow.id);
      }
    } catch (e) {
      // Crossover-Fehler darf das Breeding nicht blockieren — ohne Centroid
      // funktioniert das Kind trotzdem; refresh_profile_embedding kann später
      // aus den vererbten Memories einen echten Centroid rechnen.
      console.error("[breeding] centroid crossover failed:", fmtErr(e));
    }

    // ---- Neurochemistry-Crossover (Migration 042) -------------------------
    // Kind erbt gewichteten Mittelwert der Eltern-Neurochemie + Gauss-Noise
    // (σ = mutation_rate). Best-effort; wenn die Tabelle noch nicht exists,
    // schluckst wir den Fehler.
    try {
      await this.db.rpc("neurochem_init_from_parents", {
        p_child_label:    input.label,
        p_parent_a_label: parent_a.label,
        p_parent_b_label: parent_b.label,
        p_mutation_rate:  mutation_rate,
      });
    } catch (e) {
      console.error("[breeding] neurochemistry crossover failed (non-fatal):", fmtErr(e));
    }

    // ---- PKI: Keypair + Birth-Certificate + Profile-Sig --------------------
    // Phase 1: beide Eltern liegen lokal — wenn nicht, fail loud.
    // Bypass via MYCELIUM_SKIP_PKI=1 (für Test-Pfade ohne Crypto).
    if (process.env.MYCELIUM_SKIP_PKI !== "1") {
      try {
        await this._issueChildPki({
          child: data as Genome,
          parent_a, parent_b,
          inheritance_mode: mode,
          mutation_rate,
        });
      } catch (e) {
        // Kind ist schon in DB. Statt rollback: Marker im notes-Feld + werfen,
        // damit Aufrufer entscheiden kann (Test/CLI sieht den Fehler).
        await this.db.from("agent_genomes")
          .update({ notes: (childRow.notes ?? "") + `\n[PKI-FEHLER] ${fmtErr(e)}` })
          .eq("id", childRow.id);
        throw e;
      }
    }

    return data as Genome;
  }

  /**
   * Phase 1 Birth-Workflow: Kind-Keypair, Birth-Cert von beiden Eltern,
   * initiale Profile-Sig. Alle Schritte best-effort idempotent — wenn ein
   * Schritt scheitert, wird geworfen und der Aufrufer markiert das Kind.
   */
  private async _issueChildPki(input: {
    child: Genome;
    parent_a: Genome;
    parent_b: Genome;
    inheritance_mode: "none" | "top" | "full";
    mutation_rate: number;
  }): Promise<void> {
    // Beide Eltern müssen einen Pubkey + lokalen Privkey haben.
    const [statA, statB] = await Promise.all([
      this.genomePkiStatus(input.parent_a.label) as Promise<{ pubkey_hex: string | null }>,
      this.genomePkiStatus(input.parent_b.label) as Promise<{ pubkey_hex: string | null }>,
    ]);
    if (!statA.pubkey_hex) throw new Error(`parent ${input.parent_a.label} has no pubkey — run genome_keygen first`);
    if (!statB.pubkey_hex) throw new Error(`parent ${input.parent_b.label} has no pubkey — run genome_keygen first`);
    const [hasA, hasB] = await Promise.all([
      privkeyExists(input.parent_a.id),
      privkeyExists(input.parent_b.id),
    ]);
    if (!hasA) throw new Error(`parent ${input.parent_a.label} privkey not local`);
    if (!hasB) throw new Error(`parent ${input.parent_b.label} privkey not local`);

    // 1. Child-Keypair
    const childKp = generateKeypair();
    await savePrivkey(input.child.id, childKp.privateKey);

    // Pubkey vorab schreiben, damit signProfile den Status frisch lesen kann
    {
      const { error } = await this.db.rpc("genome_set_pki", {
        p_label: input.child.label,
        p_pubkey: "\\x" + childKp.pubkeyRaw.toString("hex"),
      });
      if (error) throw new Error(`set pubkey: ${fmtErr(error)}`);
    }

    // 2. Birth-Cert (beide Eltern signieren)
    const bc = await this.signBirthCertificate({
      child_id: input.child.id,
      child_label: input.child.label,
      child_pubkey_hex: childKp.pubkeyRaw.toString("hex"),
      parent_a: { id: input.parent_a.id, label: input.parent_a.label, pubkey_hex: statA.pubkey_hex },
      parent_b: { id: input.parent_b.id, label: input.parent_b.label, pubkey_hex: statB.pubkey_hex },
      inheritance_mode: input.inheritance_mode,
      mutation_rate: input.mutation_rate,
    });
    {
      const { error } = await this.db.rpc("genome_set_pki", {
        p_label: input.child.label,
        p_birth_certificate: bc as unknown as Record<string, unknown>,
      });
      if (error) throw new Error(`set birth_cert: ${fmtErr(error)}`);
    }

    // 3. Initiale Profile-Sig (über aktuellen profile_payload, inkl. Centroid-Hash)
    await this.signProfile(input.child.label);
  }


  /** Wright's F-Coefficient via DB-RPC. */
  private async _inbreedingCheck(a: string, b: string): Promise<{
    F: number; blocked: boolean; reason: string | null;
  }> {
    const { data, error } = await this.db.rpc("inbreeding_coefficient", {
      p_a_label: a, p_b_label: b,
    });
    if (error) throw new Error(`inbreeding_coefficient failed: ${fmtErr(error)}`);
    const r = data as { F: number; blocked: boolean; reason: string | null };
    return { F: r.F ?? 0, blocked: r.blocked ?? false, reason: r.reason ?? null };
  }

  /** Holt einen profile_embedding aus DB; ruft refresh wenn null. */
  private async _ensureProfileEmbedding(label: string): Promise<number[] | null> {
    const { data, error } = await this.db
      .from("agent_genomes")
      .select("profile_embedding")
      .eq("label", label)
      .single();
    if (error) throw new Error(`fetch centroid (${label}): ${fmtErr(error)}`);
    let raw = (data as { profile_embedding: string | number[] | null }).profile_embedding;
    if (raw == null) {
      // versuche zu refreshen
      const { error: rErr } = await this.db.rpc("refresh_profile_embedding", { p_label: label });
      if (rErr) return null;
      const { data: d2 } = await this.db
        .from("agent_genomes").select("profile_embedding").eq("label", label).single();
      raw = (d2 as { profile_embedding: string | number[] | null } | null)?.profile_embedding ?? null;
    }
    if (raw == null) return null;
    if (typeof raw === "string") {
      // pgvector Wire-Format: "[0.1,0.2,...]"
      return JSON.parse(raw);
    }
    return raw;
  }

  /** Mischt zwei Centroids gewichtet + Gauss-Noise (sigma = mutation_rate). */
  private async _crossoverCentroid(input: {
    parent_a_label: string;
    parent_b_label: string;
    weight_a: number;
    sigma: number;
  }): Promise<number[] | null> {
    const [ea, eb] = await Promise.all([
      this._ensureProfileEmbedding(input.parent_a_label),
      this._ensureProfileEmbedding(input.parent_b_label),
    ]);
    // Fallbacks: nur ein Elter hat Centroid → benutze den, andere gewichten 0.
    if (!ea && !eb) return null;
    const wA = ea && eb ? Math.max(0, Math.min(1, input.weight_a)) : (ea ? 1 : 0);
    const wB = 1 - wA;
    const dim = (ea?.length ?? eb?.length) as number;
    const out = new Array<number>(dim);
    for (let i = 0; i < dim; i++) {
      const va = ea ? ea[i] : 0;
      const vb = eb ? eb[i] : 0;
      out[i] = wA * va + wB * vb + gaussian(input.sigma * 0.05);  // Noise klein halten
    }
    return out;
  }

  /**
   * Collect the set of UUIDs the parent would pass on. Strategy:
   *   - If the parent itself has inherited_*_ids (Gen>=2 child), use those as a base
   *   - Plus everything currently associated with the parent's agent_id
   *     (we don't have a per-agent tag on memories yet, so "full" means
   *      the current global pool of non-archived memories + all experiences/lessons/traits).
   *   - 'top' mode additionally truncates memories to the strongest N.
   */
  private async _collectInheritableKnowledge(
    parent: Genome,
    mode: "top" | "full"
  ): Promise<{ memories: string[]; experiences: string[]; lessons: string[]; traits: string[] }> {
    // Start from parent's already-inherited arrays if present
    const base = {
      memories:    [...(parent.inherited_memory_ids ?? [])],
      experiences: [...(parent.inherited_experience_ids ?? [])],
      lessons:     [...(parent.inherited_lesson_ids ?? [])],
      traits:      [...(parent.inherited_trait_ids ?? [])],
    };

    // Fetch current global knowledge (Gen-1 'main' effectively pulls the whole pool).
    const memLimit = mode === "top" ? 500 : 20000;
    const [memRes, expRes, lesRes, traitRes] = await Promise.all([
      this.db.from("memories").select("id")
        .neq("stage", "archived")
        .order("strength", { ascending: false })
        .limit(memLimit),
      this.db.from("experiences").select("id").limit(20000),
      this.db.from("lessons").select("id").limit(20000),
      this.db.from("soul_traits").select("id").limit(1000),
    ]);
    if (memRes.error)    throw new Error(`inherit.memories: ${fmtErr(memRes.error)}`);
    if (expRes.error)    throw new Error(`inherit.experiences: ${fmtErr(expRes.error)}`);
    if (lesRes.error)    throw new Error(`inherit.lessons: ${fmtErr(lesRes.error)}`);
    if (traitRes.error)  throw new Error(`inherit.traits: ${fmtErr(traitRes.error)}`);

    return {
      memories:    [...base.memories,    ...((memRes.data   ?? []).map((r: any) => r.id))],
      experiences: [...base.experiences, ...((expRes.data   ?? []).map((r: any) => r.id))],
      lessons:     [...base.lessons,     ...((lesRes.data   ?? []).map((r: any) => r.id))],
      traits:      [...base.traits,      ...((traitRes.data ?? []).map((r: any) => r.id))],
    };
  }

  async genomeInheritance(label: string): Promise<InheritanceSummary> {
    const { data, error } = await this.db.rpc("genome_inheritance", { p_label: label });
    if (error) throw new Error(`genome_inheritance failed: ${fmtErr(error)}`);
    return data as InheritanceSummary;
  }

  /** Snapshot current pool as this genome's inherited_*_ids (useful for Gen-1). */
  async collectCurrentKnowledge(label: string): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("genome_collect_current_knowledge", { p_label: label });
    if (error) throw new Error(`genome_collect_current_knowledge failed: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  // ---- emergence -----------------------------------------------------
  async flagEmergence(input: {
    indicator: string;
    evidence: string;
    severity?: "info" | "notable" | "alarm";
    agent_id?: string;
    related_memory_id?: string;
    related_experience_id?: string;
    context?: Record<string, unknown>;
  }): Promise<EmergenceEvent> {
    const { data, error } = await this.db.rpc("emergence_flag", {
      p_indicator: input.indicator,
      p_evidence: input.evidence,
      p_severity: input.severity ?? "notable",
      p_agent_id: input.agent_id ?? null,
      p_memory: input.related_memory_id ?? null,
      p_experience: input.related_experience_id ?? null,
      p_context: input.context ?? {},
    });
    if (error) throw new Error(`emergence_flag failed: ${fmtErr(error)}`);
    return data as EmergenceEvent;
  }

  async listEmergence(limit = 25, onlyOpen = false): Promise<EmergenceEvent[]> {
    const { data, error } = await this.db.rpc("emergence_recent", {
      p_limit: limit,
      p_only_open: onlyOpen,
    });
    if (error) throw new Error(`emergence_recent failed: ${fmtErr(error)}`);
    return (data ?? []) as EmergenceEvent[];
  }

  // ---- PKI / signed lineage (Migration 037) ---------------------------
  /**
   * Generates an Ed25519 keypair for the genome, persists the privkey to
   * ~/.mycelium/keys/<id>.key (0600), and writes the pubkey to the DB.
   * Refuses if a pubkey already exists unless force=true.
   */
  async genomeKeygen(label: string, force = false): Promise<{
    label: string; pubkey_hex: string; privkey_path: string; created: boolean;
  }> {
    const g = await this.getGenome(label);
    if (!g) throw new Error(`genome ${label} not found`);
    const status = await this.genomePkiStatus(label);
    const hasKey = !!(status as { pubkey_hex?: string }).pubkey_hex;
    if (hasKey && !force) {
      return {
        label, pubkey_hex: (status as { pubkey_hex: string }).pubkey_hex,
        privkey_path: "<existing>", created: false,
      };
    }
    const kp = generateKeypair();
    const privkeyPath = await savePrivkey(g.id, kp.privateKey);
    const { error } = await this.db.rpc("genome_set_pki", {
      p_label: label,
      p_pubkey: "\\x" + kp.pubkeyRaw.toString("hex"),
    });
    if (error) throw new Error(`genome_set_pki(pubkey): ${fmtErr(error)}`);
    return { label, pubkey_hex: kp.pubkeyRaw.toString("hex"), privkey_path: privkeyPath, created: true };
  }

  async genomePkiStatus(label: string): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("genome_pki_status", { p_label: label });
    if (error) throw new Error(`genome_pki_status: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  /** Signs the canonical profile payload with the genome's privkey. */
  async signProfile(label: string): Promise<{ label: string; sig_hex: string }> {
    const status = await this.genomePkiStatus(label) as {
      id: string; pubkey_hex: string | null; profile_payload: unknown;
    };
    if (!status.pubkey_hex) throw new Error(`${label} has no pubkey — run genome_keygen first`);
    const priv = await loadPrivkey(status.id);
    if (!priv) throw new Error(`privkey for ${label} not found on disk`);
    const payload = Buffer.from(canonicalJson(status.profile_payload), "utf8");
    const s = sign(priv, payload);
    const { error } = await this.db.rpc("genome_set_pki", {
      p_label: label,
      p_profile_signature: "\\x" + s.hex,
    });
    if (error) throw new Error(`genome_set_pki(profile_sig): ${fmtErr(error)}`);
    return { label, sig_hex: s.hex };
  }

  /** Builds a SHA-256 merkle root over the genome's own memories. */
  async refreshMemoryMerkle(label: string): Promise<{ label: string; n: number; root_hex: string }> {
    const { data, error } = await this.db.rpc("genome_memory_leaves", { p_label: label, p_limit: 50000 });
    if (error) throw new Error(`genome_memory_leaves: ${fmtErr(error)}`);
    const rows = (data ?? []) as Array<{ memory_id: string; leaf: string }>;
    const leaves = rows.map((r) => Buffer.from(r.leaf.startsWith("\\x") ? r.leaf.slice(2) : r.leaf, "hex"));
    const root = merkleRoot(leaves);
    const { error: e2 } = await this.db.rpc("genome_set_pki", {
      p_label: label,
      p_memory_merkle_root: "\\x" + root.toString("hex"),
      p_memory_merkle_n:    leaves.length,
    });
    if (e2) throw new Error(`genome_set_pki(merkle): ${fmtErr(e2)}`);
    return { label, n: leaves.length, root_hex: root.toString("hex") };
  }

  /**
   * Issues a Birth-Certificate signed by both parents.
   * Both parents' privkeys must be present locally.
   */
  async signBirthCertificate(input: {
    child_id: string;
    child_label: string;
    child_pubkey_hex: string;
    parent_a: { id: string; label: string; pubkey_hex: string };
    parent_b: { id: string; label: string; pubkey_hex: string };
    inheritance_mode: "none" | "top" | "full";
    mutation_rate: number;
  }): Promise<BirthCert> {
    const [privA, privB] = await Promise.all([
      loadPrivkey(input.parent_a.id),
      loadPrivkey(input.parent_b.id),
    ]);
    if (!privA) throw new Error(`parent ${input.parent_a.label} privkey not local — cannot sign birth-cert`);
    if (!privB) throw new Error(`parent ${input.parent_b.label} privkey not local — cannot sign birth-cert`);

    const payload: BirthCertPayload = {
      v: 1,
      child_id:        input.child_id,
      child_label:     input.child_label,
      child_pubkey_hex: input.child_pubkey_hex,
      parent_a:        input.parent_a,
      parent_b:        input.parent_b,
      inheritance_mode: input.inheritance_mode,
      mutation_rate:   input.mutation_rate,
      born_at:         new Date().toISOString(),
    };
    const buf = buildBirthCertPayload(payload);
    const sigA = sign(privA, buf);
    const sigB = sign(privB, buf);
    return {
      v: 1,
      payload,
      parent_a_sig_hex: sigA.hex,
      parent_b_sig_hex: sigB.hex,
    };
  }

  /**
   * Verifies a genome's PKI artefacts. Returns per-check verdicts.
   * Does NOT verify federated trust roots — that's Phase 2.
   */
  async verifyGenome(label: string, options: { spotcheck_merkle?: boolean } = {}): Promise<{
    label: string;
    has_pubkey: boolean;
    profile_signature_valid: boolean | null;
    birth_certificate_valid: boolean | null;
    birth_certificate_present: boolean;
    memory_merkle_match: boolean | null;
    notes: string[];
  }> {
    const status = await this.genomePkiStatus(label) as {
      pubkey_hex: string | null;
      profile_signature_hex: string | null;
      profile_payload: unknown;
      birth_certificate: BirthCert | null;
      memory_merkle_root_hex: string | null;
      memory_merkle_n: number | null;
      parents: Array<{ id: string; label: string; pubkey: string }>;
    };
    const notes: string[] = [];
    const has_pubkey = !!status.pubkey_hex;

    // Profile-Signature
    let profile_signature_valid: boolean | null = null;
    if (has_pubkey && status.profile_signature_hex) {
      const pub = Buffer.from(status.pubkey_hex!, "hex");
      const sig = Buffer.from(status.profile_signature_hex, "hex");
      const payload = Buffer.from(canonicalJson(status.profile_payload), "utf8");
      profile_signature_valid = verify(pub, payload, sig);
      if (!profile_signature_valid) notes.push("profile signature does not match payload");
    } else {
      notes.push("profile signature missing");
    }

    // Birth-Certificate
    const birth_certificate_present = !!status.birth_certificate;
    let birth_certificate_valid: boolean | null = null;
    if (status.birth_certificate) {
      const bc = status.birth_certificate;
      const payloadBuf = buildBirthCertPayload(bc.payload);
      const pubA = bc.payload.parent_a.pubkey_hex
        ? Buffer.from(bc.payload.parent_a.pubkey_hex, "hex") : null;
      const pubB = bc.payload.parent_b.pubkey_hex
        ? Buffer.from(bc.payload.parent_b.pubkey_hex, "hex") : null;
      const sigA = bc.parent_a_sig_hex ? Buffer.from(bc.parent_a_sig_hex, "hex") : null;
      const sigB = bc.parent_b_sig_hex ? Buffer.from(bc.parent_b_sig_hex, "hex") : null;
      const okA = pubA && sigA ? verify(pubA, payloadBuf, sigA) : false;
      const okB = pubB && sigB ? verify(pubB, payloadBuf, sigB) : false;
      birth_certificate_valid = okA && okB;
      if (!okA) notes.push("birth-cert: parent_a signature invalid or missing");
      if (!okB) notes.push("birth-cert: parent_b signature invalid or missing");
    } else if (status.parents.length > 0) {
      notes.push("genome has parents but no birth_certificate");
    }

    // Memory-Merkle Spotcheck (optional, kostet O(n))
    let memory_merkle_match: boolean | null = null;
    if (options.spotcheck_merkle && status.memory_merkle_root_hex) {
      const recomputed = await this.refreshMemoryMerkle(label);
      memory_merkle_match = recomputed.root_hex === status.memory_merkle_root_hex;
      if (!memory_merkle_match) notes.push("memory_merkle_root drift — memories changed since signing");
    }

    return {
      label,
      has_pubkey,
      profile_signature_valid,
      birth_certificate_valid,
      birth_certificate_present,
      memory_merkle_match,
      notes,
    };
  }

  // ---- Signed Revocations (Phase 3d, Migration 040) -------------------
  /**
   * Issues a signed revocation certificate. `signer_label` must have its
   * privkey present locally. Either:
   *   - signer is revoking itself (signer_label's pubkey == target pubkey), or
   *   - signer is a trust-root (kind=genome|group) authorised to revoke others.
   * Stores the signed revocation locally via revocation_upsert_signed.
   */
  async issueRevocation(input: {
    target_pubkey_hex: string;
    reason: string;
    signer_label: string;
    revoked_by?: string;
  }): Promise<{ revoked_pubkey_hex: string; signer_pubkey_hex: string; signature_hex: string; sync_source: string }> {
    if (!/^[0-9a-fA-F]{64}$/.test(input.target_pubkey_hex)) {
      throw new Error(`target_pubkey_hex must be 32 bytes hex, got ${input.target_pubkey_hex.length} chars`);
    }
    const signerStatus = await this.genomePkiStatus(input.signer_label) as {
      id: string; pubkey_hex: string | null;
    };
    if (!signerStatus.pubkey_hex) {
      throw new Error(`signer '${input.signer_label}' has no pubkey — run genome_keygen first`);
    }
    const signerPriv = await loadPrivkey(signerStatus.id);
    if (!signerPriv) {
      throw new Error(`signer '${input.signer_label}' has no local privkey`);
    }

    // Authority check: self-revoke OR signer is in trust_roots with kind=genome|group
    const signerHexLower = signerStatus.pubkey_hex.toLowerCase();
    const targetHexLower = input.target_pubkey_hex.toLowerCase();
    const isSelfRevoke = signerHexLower === targetHexLower;
    if (!isSelfRevoke) {
      const { data, error } = await this.db.rpc("trust_check", { p_pubkey: "\\x" + signerHexLower });
      if (error) throw new Error(`trust_check: ${fmtErr(error)}`);
      const tc = data as { trusted: boolean; kind?: string };
      if (!tc.trusted || (tc.kind !== "genome" && tc.kind !== "group")) {
        throw new Error(`signer '${input.signer_label}' is not authorised (kind=${tc.kind}, trusted=${tc.trusted}) — only genome/group trust-roots can revoke third-party keys`);
      }
    }

    const payload: RevocationPayload = {
      v: 1,
      revoked_pubkey_hex: targetHexLower,
      signer_pubkey_hex:  signerHexLower,
      reason: input.reason,
      revoked_at: new Date().toISOString(),
    };
    const buf = buildRevocationPayload(payload);
    const sig = sign(signerPriv, buf);

    const { error: upErr } = await this.db.rpc("revocation_upsert_signed", {
      p_revoked_pubkey: "\\x" + targetHexLower,
      p_signer_pubkey:  "\\x" + signerHexLower,
      p_signature:      "\\x" + sig.hex,
      p_signed_payload: payload,
      p_reason:         input.reason,
      p_revoked_by:     input.revoked_by ?? input.signer_label,
      p_sync_source:    "local",
    });
    if (upErr) throw new Error(`revocation_upsert_signed: ${fmtErr(upErr)}`);
    return {
      revoked_pubkey_hex: targetHexLower,
      signer_pubkey_hex:  signerHexLower,
      signature_hex:      sig.hex,
      sync_source:        "local",
    };
  }

  // ---- tinder / anti-inbreeding (Migration 034 + 035) -----------------
  async inbreedingCoefficient(a: string, b: string): Promise<{
    a: string; b: string; F: number; blocked: boolean;
    reason: string | null; common_ancestors: unknown; threshold: number;
  }> {
    const { data, error } = await this.db.rpc("inbreeding_coefficient", { p_a_label: a, p_b_label: b });
    if (error) throw new Error(`inbreeding_coefficient: ${fmtErr(error)}`);
    return data as any;
  }

  async refreshProfileEmbedding(label: string): Promise<{
    label: string; n: number; variance: number | null; has_centroid: boolean;
  }> {
    const { data, error } = await this.db.rpc("refresh_profile_embedding", { p_label: label });
    if (error) throw new Error(`refresh_profile_embedding: ${fmtErr(error)}`);
    return data as any;
  }

  async tinderCardsRanked(input: {
    viewer: string;
    swiper_user?: string;
    limit?: number;
    include_seen?: boolean;
    include_blocked?: boolean;
  }): Promise<unknown[]> {
    const { data, error } = await this.db.rpc("bot_profile_cards_ranked", {
      p_viewer_genome_label: input.viewer,
      p_viewer_user:         input.swiper_user ?? "reed",
      p_limit:               input.limit ?? 10,
      p_include_seen:        input.include_seen ?? false,
      p_include_blocked:     input.include_blocked ?? false,
    });
    if (error) throw new Error(`bot_profile_cards_ranked: ${fmtErr(error)}`);
    return (data ?? []) as unknown[];
  }

  async populationHealth(): Promise<{
    n_active: number; n_with_embedding: number;
    avg_pairwise_distance: number | null;
    avg_F: number | null; max_F: number | null;
    migrant_recommended: boolean; note?: string;
  }> {
    const { data, error } = await this.db.rpc("population_health");
    if (error) throw new Error(`population_health: ${fmtErr(error)}`);
    return data as any;
  }

  async resolveEmergence(id: string, resolution: string): Promise<EmergenceEvent> {
    const { data, error } = await this.db
      .from("emergence_events")
      .update({ resolved_at: new Date().toISOString(), resolution })
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`resolve emergence failed: ${fmtErr(error)}`);
    return data as EmergenceEvent;
  }
}

// ---------------------------------------------------------------------------
// Helper maths for breeding
// ---------------------------------------------------------------------------

function avg(a: number, b: number): number {
  return (a + b) / 2;
}

function gaussian(sigma: number): number {
  // Box-Muller
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
}

function mutateNum(v: number, rate: number): number {
  const sigma = Math.max(0, rate);
  const out = v + gaussian(sigma);
  return Math.max(0, Math.min(1, Number(out.toFixed(4))));
}

function unionShuffle(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of [a, b]) {
    for (const x of arr) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
  }
  return out;
}

function uniqStrings(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}
