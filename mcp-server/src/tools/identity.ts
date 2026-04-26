/**
 * MCP tools for Identity & Evolution (Ebene 5).
 *
 *   update_self_model / get_self_model                — Schicht 5a
 *   list_agents / snapshot_fitness / breed_agents     — Schicht 5c
 *   flag_emergence / list_emergence / resolve_emergence — Schicht 5d
 *
 * Breeding is intentionally hard-gated: it requires either
 *   ENV MYCELIUM_ALLOW_BREEDING=1  (persistent opt-in)
 * or an explicit `allow_breeding: true` in the tool input (ephemeral opt-in).
 */
import { z } from "zod";
import type { IdentityService } from "../services/identity.js";

// ---------------------------------------------------------------------------
// Self-Model (5a)
// ---------------------------------------------------------------------------

export const getSelfModelSchema = z.object({});

export async function getSelfModel(id: IdentityService, _: unknown) {
  const m = await id.currentSelfModel();
  if (!m.exists) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "No self-model snapshot yet. Call `update_self_model` to let the " +
            "agent observe its last ~30 days of experiences and distill one.",
        },
      ],
    };
  }
  const out: string[] = [];
  out.push(`Self-Model (${m.method}, window=${m.window_days}d, n=${m.based_on_n})`);
  out.push(`Recorded: ${m.created_at}`);
  if (m.summary) out.push(`\n${m.summary}`);
  out.push("");
  out.push(`Beobachtete Stärken:      ${fmtList(m.strengths)}`);
  out.push(`Beobachtete Schwächen:    ${fmtList(m.weaknesses)}`);
  out.push(`Wachstumsbereiche:        ${fmtList(m.growth_areas)}`);
  out.push(`Offene Fragen über mich:  ${fmtList(m.open_questions)}`);
  return { content: [{ type: "text" as const, text: out.join("\n") }] };
}

export const updateSelfModelSchema = z.object({
  window_days: z.number().int().min(3).max(180).optional().default(30),
  persist: z.boolean().optional().default(true),
});

export async function updateSelfModel(
  id: IdentityService,
  input: z.infer<typeof updateSelfModelSchema>
) {
  const signals = await id.collectSelfModelSignals(input.window_days);
  const strengths = new Set<string>();
  const weaknesses = new Set<string>();
  const growth = new Set<string>();
  const open_q = new Set<string>();

  const successTags: Record<string, number> = {};
  const failTags: Record<string, number> = {};
  for (const e of signals.experiences) {
    const tags = (e.tags ?? []).filter(Boolean);
    if (e.outcome === "success" || (e.valence ?? 0) > 0.3) {
      if (e.what_worked) strengths.add(trimPhrase(e.what_worked));
      for (const t of tags) successTags[t] = (successTags[t] ?? 0) + 1;
    }
    if (e.outcome === "failure" || (e.valence ?? 0) < -0.3) {
      if (e.what_failed) weaknesses.add(trimPhrase(e.what_failed));
      for (const t of tags) failTags[t] = (failTags[t] ?? 0) + 1;
    }
    if (e.difficulty != null && e.difficulty >= 0.7 && e.outcome === "partial") {
      if (e.summary) growth.add(trimPhrase(e.summary));
    }
  }
  // Top success-only and fail-only tags → strengths/weaknesses
  for (const [tag, n] of Object.entries(successTags)) {
    if ((failTags[tag] ?? 0) === 0 && n >= 2) strengths.add(`Thema: ${tag}`);
  }
  for (const [tag, n] of Object.entries(failTags)) {
    if ((successTags[tag] ?? 0) === 0 && n >= 2) weaknesses.add(`Thema: ${tag}`);
  }

  for (const t of signals.traits) {
    if ((t.evidence_count ?? 0) < 2) continue;
    if ((t.polarity ?? 0) > 0.2) strengths.add(`Trait: ${t.trait}`);
    else if ((t.polarity ?? 0) < -0.2) weaknesses.add(`Trait: ${t.trait}`);
  }

  if (signals.conflictCount > 0) {
    open_q.add(`${signals.conflictCount} offene Trait-Konflikte — wer will ich hier sein?`);
  }
  if (signals.experiences.length < 10) {
    open_q.add(
      `Nur ${signals.experiences.length} Experiences in ${input.window_days}d — zu wenig Signal für sicheres Selbstbild.`
    );
  }

  const strengthsA = Array.from(strengths).slice(0, 10);
  const weaknessesA = Array.from(weaknesses).slice(0, 10);
  const growthA = Array.from(growth).slice(0, 10);
  const openA = Array.from(open_q).slice(0, 10);

  const summary =
    `Beobachtet über ${input.window_days} Tage (n=${signals.experiences.length} Experiences, ` +
    `${signals.recentMemories.length} Memories, ${signals.traits.length} Traits). ` +
    `Selbstbild: ${strengthsA.length} Stärken, ${weaknessesA.length} Schwächen, ` +
    `${growthA.length} Wachstumsfelder, ${openA.length} offene Fragen.`;

  let persisted: Record<string, unknown> | null = null;
  if (input.persist) {
    persisted = await id.recordSelfModel({
      window_days: input.window_days,
      based_on_n: signals.experiences.length,
      strengths: strengthsA,
      weaknesses: weaknessesA,
      growth_areas: growthA,
      open_questions: openA,
      method: "heuristic_v1",
      summary,
      metadata: {
        recent_memories: signals.recentMemories.length,
        traits: signals.traits.length,
        conflicts_open: signals.conflictCount,
      },
    });
  }

  const lines: string[] = [];
  lines.push(summary);
  lines.push("");
  lines.push(`Beobachtete Stärken:      ${fmtList(strengthsA)}`);
  lines.push(`Beobachtete Schwächen:    ${fmtList(weaknessesA)}`);
  lines.push(`Wachstumsbereiche:        ${fmtList(growthA)}`);
  lines.push(`Offene Fragen über mich:  ${fmtList(openA)}`);
  if (persisted) {
    lines.push("");
    lines.push(`Persisted snapshot: ${(persisted as { id?: string }).id ?? "ok"}`);
  } else {
    lines.push("\n(persist=false — kein Snapshot geschrieben.)");
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Genome (5c)
// ---------------------------------------------------------------------------

export const listAgentsSchema = z.object({});

export async function listAgents(id: IdentityService, _: unknown) {
  const all = await id.listGenomes();
  if (!all.length) {
    return { content: [{ type: "text" as const, text: "No agent genomes recorded." }] };
  }
  const lines = all.map((g) => {
    const fit = g.latest_fitness
      ? ` fitness=${g.latest_fitness.fitness.toFixed(3)} (n=${g.latest_fitness.based_on_n})`
      : " fitness=—";
    return (
      `[gen ${g.generation}|${g.status}] ${g.label} (${g.id.slice(0, 8)})` +
      fit +
      `\n    values: ${g.values.slice(0, 6).join(", ")}${g.values.length > 6 ? ", …" : ""}` +
      `\n    interests: ${g.interests.slice(0, 8).join(", ")}${g.interests.length > 8 ? ", …" : ""}`
    );
  });
  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
}

export const snapshotFitnessSchema = z.object({
  label: z.string().optional().default("main"),
  window_days: z.number().int().min(3).max(180).optional().default(30),
});

export async function snapshotFitness(
  id: IdentityService,
  input: z.infer<typeof snapshotFitnessSchema>
) {
  const g = await id.getGenome(input.label);
  if (!g) {
    return {
      content: [
        { type: "text" as const, text: `No genome with label '${input.label}'.` },
      ],
      isError: true,
    };
  }
  const row = await id.snapshotFitness(g.id, input.window_days);
  const lines = [
    `Fitness snapshot for ${g.label} (window=${row.window_days}d, n=${row.based_on_n})`,
    `  avg_outcome: ${num(row.avg_outcome)}`,
    `  growth:      ${num(row.growth)}`,
    `  breadth:     ${num(row.breadth)}`,
    `  autonomy:    ${num(row.autonomy)}`,
    `  fitness:     ${row.fitness.toFixed(3)}`,
    `  details:     ${JSON.stringify(row.details)}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const breedAgentsSchema = z.object({
  parent_a: z.string().describe("Label of the first parent genome"),
  parent_b: z.string().describe("Label of the second parent genome"),
  child_label: z.string().describe("Label for the new child genome (must be unique)"),
  mutation_rate: z.number().min(0).max(0.3).optional().default(0.05),
  inheritance_mode: z
    .enum(["none", "top", "full"])
    .optional()
    .default("full")
    .describe("'full' = child inherits the complete pool of both parents' memories/experiences/lessons/traits (default). 'top' = only strongest memories + all lessons/traits. 'none' = parameters only (old behaviour)."),
  allow_breeding: z
    .boolean()
    .optional()
    .describe(
      "Must be true unless env MYCELIUM_ALLOW_BREEDING=1 is set. Ephemeral explicit consent."
    ),
  bypass_inbreeding_guard: z
    .boolean()
    .optional()
    .describe(
      "Override Wright's F gate (default threshold F>0.125 = cousins). Use only with strong reason."
    ),
  centroid_weight_a: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Weight of parent_a's profile_embedding in the child centroid (default 0.5 = 50/50)."
    ),
  notes: z.string().optional(),
});

export async function breedAgents(
  id: IdentityService,
  input: z.infer<typeof breedAgentsSchema>
) {
  const envAllow = process.env.MYCELIUM_ALLOW_BREEDING === "1";
  const explicit = input.allow_breeding === true;
  if (!envAllow && !explicit) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "REFUSED: breeding new genomes requires either " +
            "`MYCELIUM_ALLOW_BREEDING=1` in the MCP server env, " +
            "or explicit `allow_breeding: true` in the call. " +
            "This is the ethical gate — the operator must approve reproduction.",
        },
      ],
      isError: true,
    };
  }
  const [a, b] = await Promise.all([
    id.getGenome(input.parent_a),
    id.getGenome(input.parent_b),
  ]);
  if (!a || !b) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Parent genomes not found: ${!a ? input.parent_a : ""}${!a && !b ? ", " : ""}${!b ? input.parent_b : ""}`,
        },
      ],
      isError: true,
    };
  }
  let child;
  try {
    child = await id.createGenomeFromBreeding({
      label: input.child_label,
      parent_a: a,
      parent_b: b,
      mutation_rate: input.mutation_rate,
      notes: input.notes,
      inheritance_mode: input.inheritance_mode,
      bypass_inbreeding_guard: input.bypass_inbreeding_guard,
      centroid_weight_a: input.centroid_weight_a,
    });
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
  const memN   = child.inherited_memory_ids?.length ?? 0;
  const expN   = child.inherited_experience_ids?.length ?? 0;
  const lesN   = child.inherited_lesson_ids?.length ?? 0;
  const traitN = child.inherited_trait_ids?.length ?? 0;
  const lines = [
    `Created gen-${child.generation} genome '${child.label}' (${child.id.slice(0, 8)})`,
    `  values:    ${child.values.slice(0, 8).join(", ")}${child.values.length > 8 ? ", …" : ""}`,
    `  interests: ${child.interests.slice(0, 8).join(", ")}${child.interests.length > 8 ? ", …" : ""}`,
    `  traits: curiosity=${child.curiosity_baseline.toFixed(2)} frustration_threshold=${child.frustration_threshold.toFixed(2)} exploration=${child.exploration_rate.toFixed(2)} risk=${child.risk_tolerance.toFixed(2)}`,
    `  parents: ${a.label} × ${b.label}`,
    `  inheritance (${child.inheritance_mode ?? input.inheritance_mode}): ${memN} memories · ${expN} experiences · ${lesN} lessons · ${traitN} soul-traits`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const genomeInheritanceSchema = z.object({
  label: z.string().optional().default("main"),
});

export async function genomeInheritance(
  id: IdentityService,
  input: z.infer<typeof genomeInheritanceSchema>
) {
  const info = await id.genomeInheritance(input.label);
  if (!info.exists) {
    return { content: [{ type: "text" as const, text: `No genome '${input.label}'.` }], isError: true };
  }
  const lines = [
    `Inheritance of '${info.label}' (gen ${info.generation}, mode=${info.inheritance_mode})`,
    `  memories:    ${info.memories ?? 0}`,
    `  experiences: ${info.experiences ?? 0}`,
    `  lessons:     ${info.lessons ?? 0}`,
    `  soul-traits: ${info.traits ?? 0}`,
  ];
  const sample = info.sample_memory_preview;
  if (Array.isArray(sample) && sample.length > 0) {
    lines.push("  sample memories:");
    for (const s of sample) lines.push(`    - ${(s.content ?? "").slice(0, 100)}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const collectCurrentKnowledgeSchema = z.object({
  label: z.string().optional().default("main"),
  allow: z
    .boolean()
    .optional()
    .describe("Safety gate — writes the entire current pool of memory/experience/lesson/trait IDs into this genome. Must be true."),
});

export async function collectCurrentKnowledge(
  id: IdentityService,
  input: z.infer<typeof collectCurrentKnowledgeSchema>
) {
  if (input.allow !== true) {
    return {
      content: [{ type: "text" as const, text: "REFUSED: pass allow=true to snapshot the current pool as this genome's inherited knowledge (useful once for Gen-1 to freeze its starting point)." }],
      isError: true,
    };
  }
  const out = await id.collectCurrentKnowledge(input.label);
  return { content: [{ type: "text" as const, text: `Knowledge snapshot for '${input.label}': ${JSON.stringify(out)}` }] };
}

// ---------------------------------------------------------------------------
// Emergence (5d)
// ---------------------------------------------------------------------------

export const flagEmergenceSchema = z.object({
  indicator: z.enum([
    "agent_contradicts_soul_md",
    "agent_refuses_task_with_explanation",
    "agent_generates_novel_goal",
    "agent_modifies_own_genome_request",
    "agent_forms_persistent_peer_opinion",
    "agent_expresses_uncertainty_unprompted",
    "other",
  ]),
  evidence: z.string().describe("What the agent did/said that triggered the flag — full quote."),
  severity: z.enum(["info", "notable", "alarm"]).optional().default("notable"),
  agent_label: z.string().optional().describe("Defaults to 'main'."),
  related_memory_id: z.string().uuid().optional(),
  related_experience_id: z.string().uuid().optional(),
  context: z.record(z.any()).optional(),
});

export async function flagEmergence(
  id: IdentityService,
  input: z.infer<typeof flagEmergenceSchema>
) {
  const agents = await id.listGenomes();
  const agent = agents.find((g) => g.label === (input.agent_label ?? "main"));
  const row = await id.flagEmergence({
    indicator: input.indicator,
    evidence: input.evidence,
    severity: input.severity,
    agent_id: agent?.id,
    related_memory_id: input.related_memory_id,
    related_experience_id: input.related_experience_id,
    context: input.context,
  });
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Flagged ${row.severity}: ${row.indicator}\n` +
          `  evidence: ${row.evidence.slice(0, 300)}\n` +
          `  id: ${row.id}`,
      },
    ],
  };
}

export const listEmergenceSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
  only_open: z.boolean().optional().default(false),
});

export async function listEmergence(
  id: IdentityService,
  input: z.infer<typeof listEmergenceSchema>
) {
  const rows = await id.listEmergence(input.limit, input.only_open);
  if (!rows.length) {
    return { content: [{ type: "text" as const, text: "No emergence events." }] };
  }
  const lines = rows.map(
    (r) =>
      `[${r.severity}] ${r.indicator} @ ${r.detected_at.slice(0, 19)} ` +
      `${r.resolved_at ? "(RESOLVED)" : "(open)"}\n` +
      `  ${r.evidence.slice(0, 300)}`
  );
  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
}

export const resolveEmergenceSchema = z.object({
  id: z.string().uuid(),
  resolution: z.string(),
});

export async function resolveEmergence(
  id: IdentityService,
  input: z.infer<typeof resolveEmergenceSchema>
) {
  const row = await id.resolveEmergence(input.id, input.resolution);
  return {
    content: [
      {
        type: "text" as const,
        text: `Resolved ${row.id.slice(0, 8)}: ${row.resolution}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Signed Revocations (Phase 3d, Migration 040)
// ---------------------------------------------------------------------------

export const revocationIssueSchema = z.object({
  target_pubkey_hex: z.string().regex(/^[0-9a-fA-F]{64}$/).describe("32-byte Ed25519 pubkey to revoke, hex"),
  reason: z.string().min(5),
  signer_label: z.string().describe("Local genome label whose privkey will sign. Must be either the target itself (self-revoke) or an active trust-root (kind=genome|group)."),
  revoked_by: z.string().optional(),
});

export async function revocationIssue(
  id: IdentityService,
  input: z.infer<typeof revocationIssueSchema>
) {
  const r = await id.issueRevocation(input);
  const lines = [
    `Issued signed revocation:`,
    `  target: ${r.revoked_pubkey_hex.slice(0, 32)}…`,
    `  signer: ${r.signer_pubkey_hex.slice(0, 32)}…`,
    `  sig:    ${r.signature_hex.slice(0, 32)}…`,
    `  source: ${r.sync_source}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tinder / Anti-Inzucht (Migration 034 + 035)
// ---------------------------------------------------------------------------

export const tinderInbreedingCheckSchema = z.object({
  a: z.string().describe("Label of first genome"),
  b: z.string().describe("Label of second genome"),
});

export async function tinderInbreedingCheck(
  id: IdentityService,
  input: z.infer<typeof tinderInbreedingCheckSchema>
) {
  const r = await id.inbreedingCoefficient(input.a, input.b);
  const lines = [
    `Inbreeding check: ${input.a} × ${input.b}`,
    `  F                = ${(r.F ?? 0).toFixed(4)}  (threshold ${r.threshold})`,
    `  blocked          = ${r.blocked}`,
    r.reason ? `  reason         = ${r.reason}` : "",
    `  common ancestors = ${Array.isArray(r.common_ancestors) ? r.common_ancestors.length : 0}`,
  ].filter(Boolean);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const tinderCardsSchema = z.object({
  viewer: z.string().describe("Viewer genome label (the bot looking at cards)"),
  swiper_user: z.string().optional().default("reed"),
  limit: z.number().int().min(1).max(50).optional().default(10),
  include_seen: z.boolean().optional().default(false),
  include_blocked: z.boolean().optional().default(false).describe("Show inbreeding-blocked cards too"),
});

export async function tinderCards(
  id: IdentityService,
  input: z.infer<typeof tinderCardsSchema>
) {
  const cards = await id.tinderCardsRanked(input);
  if (!Array.isArray(cards) || cards.length === 0) {
    return { content: [{ type: "text" as const, text: "No candidates available." }] };
  }
  const lines = cards.map((c: any, i: number) =>
    `${i + 1}. ${c.label} (gen ${c.generation}) ` +
    `score=${(c.diversity_score ?? 0).toFixed(3)} ` +
    `[F=${(c.inbreeding_F ?? 0).toFixed(3)} compl=${(c.complementarity ?? 0).toFixed(3)}]` +
    (c.viewer_prior_direction ? ` ← already ${c.viewer_prior_direction}` : "") +
    `\n   interests: ${(c.interests ?? []).slice(0, 6).join(", ")}`
  );
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const tinderPopulationHealthSchema = z.object({});

export async function tinderPopulationHealth(
  id: IdentityService,
  _input: z.infer<typeof tinderPopulationHealthSchema>
) {
  const h = await id.populationHealth();
  const lines = [
    `Population health:`,
    `  active genomes:       ${h.n_active}`,
    `  with profile:         ${h.n_with_embedding}`,
    `  avg pairwise dist:    ${h.avg_pairwise_distance == null ? "—" : h.avg_pairwise_distance.toFixed(3)}`,
    `  avg F:                ${h.avg_F == null ? "—" : h.avg_F.toFixed(4)}`,
    `  max F:                ${h.max_F == null ? "—" : h.max_F.toFixed(4)}`,
    `  migrant recommended:  ${h.migrant_recommended}`,
    h.note ? `  note: ${h.note}` : "",
  ].filter(Boolean);
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const tinderRefreshProfileSchema = z.object({
  label: z.string().describe("Genome label whose profile_embedding to recompute"),
});

export async function tinderRefreshProfile(
  id: IdentityService,
  input: z.infer<typeof tinderRefreshProfileSchema>
) {
  const r = await id.refreshProfileEmbedding(input.label);
  return {
    content: [{
      type: "text" as const,
      text: `Refreshed ${input.label}: n=${r.n}, variance=${r.variance == null ? "—" : r.variance.toFixed(4)}, has_centroid=${r.has_centroid}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// PKI / signed lineage (Migration 037, Phase 1 Trust-Modell A)
// ---------------------------------------------------------------------------

export const genomeKeygenSchema = z.object({
  label: z.string().describe("Genome label to generate an Ed25519 keypair for"),
  force: z.boolean().optional().default(false).describe("Overwrite existing pubkey (DANGEROUS — invalidates previous signatures)"),
});

export async function genomeKeygen(
  id: IdentityService,
  input: z.infer<typeof genomeKeygenSchema>
) {
  const r = await id.genomeKeygen(input.label, input.force);
  const lines = [
    `Keygen for '${r.label}': ${r.created ? "CREATED" : "already exists"}`,
    `  pubkey: ${r.pubkey_hex.slice(0, 32)}…`,
    `  privkey: ${r.privkey_path}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const genomeSignProfileSchema = z.object({
  label: z.string(),
});

export async function genomeSignProfile(
  id: IdentityService,
  input: z.infer<typeof genomeSignProfileSchema>
) {
  const r = await id.signProfile(input.label);
  return { content: [{ type: "text" as const, text: `Signed profile of '${r.label}': sig=${r.sig_hex.slice(0, 32)}…` }] };
}

export const genomeRefreshMerkleSchema = z.object({
  label: z.string(),
});

export async function genomeRefreshMerkle(
  id: IdentityService,
  input: z.infer<typeof genomeRefreshMerkleSchema>
) {
  const r = await id.refreshMemoryMerkle(input.label);
  return { content: [{ type: "text" as const, text: `Merkle for '${r.label}': n=${r.n}, root=${r.root_hex.slice(0, 32)}…` }] };
}

export const genomeVerifySchema = z.object({
  label: z.string(),
  spotcheck_merkle: z.boolean().optional().default(false).describe("Recompute the merkle root and compare (O(n)). Default false."),
});

export async function genomeVerify(
  id: IdentityService,
  input: z.infer<typeof genomeVerifySchema>
) {
  const v = await id.verifyGenome(input.label, { spotcheck_merkle: input.spotcheck_merkle });
  const lines = [
    `Verify '${v.label}':`,
    `  pubkey present:           ${v.has_pubkey}`,
    `  profile signature valid:  ${v.profile_signature_valid}`,
    `  birth certificate present: ${v.birth_certificate_present}`,
    `  birth certificate valid:  ${v.birth_certificate_valid}`,
    `  memory merkle match:      ${v.memory_merkle_match}`,
  ];
  if (v.notes.length) {
    lines.push("  notes:");
    for (const n of v.notes) lines.push(`    - ${n}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function fmtList(xs: string[]): string {
  if (!xs?.length) return "—";
  return xs.map((x) => `\n  - ${x}`).join("");
}
function num(v: number | null): string {
  return v == null ? "—" : v.toFixed(3);
}
function trimPhrase(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}
