import { test } from "node:test";
import assert from "node:assert/strict";
import { absorb } from "../tools/absorb.js";
import type { MemoryService } from "../services/supabase.js";
import type { ExperienceService, RecordExperienceInput } from "../services/experiences.js";
import type { AffectService, AffectEvent, AffectState } from "../services/affect.js";
import type { Memory, CreateMemoryInput } from "../types/memory.js";

const MEMORY_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const EXPERIENCE_ID = "bbbbbbbb-5555-6666-7777-888888888888";

function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: MEMORY_ID,
    content: "default",
    category: "general",
    tags: [],
    metadata: {},
    created_at: "2026-04-11T00:00:00Z",
    updated_at: "2026-04-11T00:00:00Z",
    strength: 1.0,
    importance: 0.5,
    access_count: 0,
    valence: 0,
    arousal: 0,
    stage: "episodic",
    pinned: false,
    decay_tau_days: 30,
    useful_count: 0,
    source: "absorb",
    ...over,
  };
}

class FakeMemoryService implements Partial<MemoryService> {
  created: CreateMemoryInput[] = [];
  constructor(private opts: { duplicate?: boolean } = {}) {}
  async create(input: CreateMemoryInput): Promise<Memory> {
    this.created.push(input);
    return makeMemory({
      content: input.content,
      category: input.category ?? "general",
      tags: input.tags ?? [],
      // Simulate a duplicate: create() returns an existing memory whose
      // `source` differs from the one we just tried to insert.
      source: this.opts.duplicate ? "earlier-source" : "absorb",
    });
  }
}

class FakeExperienceService implements Partial<ExperienceService> {
  recorded: RecordExperienceInput[] = [];
  constructor(private opts: { fail?: boolean } = {}) {}
  async record(input: RecordExperienceInput) {
    if (this.opts.fail) throw new Error("stub experience failure");
    this.recorded.push(input);
    return { id: EXPERIENCE_ID, cross_links: 0, intentions_touched: 0, person_id: null };
  }
}

class FakeAffectService implements Partial<AffectService> {
  events: Array<{ event: AffectEvent; intensity: number }> = [];
  async apply(event: AffectEvent, intensity = 0.1): Promise<AffectState | null> {
    this.events.push({ event, intensity });
    return null;
  }
  async get(): Promise<AffectState> {
    return {
      curiosity: 0.5, frustration: 0, satisfaction: 0.5, confidence: 0.5,
      decay_factor: 1, updated_at: "2026-04-18T00:00:00Z", hours_since: 0, last_event: null,
    };
  }
}

async function run(
  text: string,
  opts: { duplicate?: boolean; fail?: boolean; context?: string } = {}
) {
  const mem = new FakeMemoryService({ duplicate: opts.duplicate });
  const exp = new FakeExperienceService({ fail: opts.fail });
  const aff = new FakeAffectService();
  const res = await absorb(
    mem as unknown as MemoryService,
    exp as unknown as ExperienceService,
    aff as unknown as AffectService,
    { text, context: opts.context }
  );
  return { mem, exp, aff, res };
}

// ---------------------------------------------------------------------------
// Emotional trigger fires
// ---------------------------------------------------------------------------

test("absorb records experience when valence is strongly negative", async () => {
  const { exp, res } = await run("Alex ist total frustriert über die fehlende Performance");
  assert.equal(exp.recorded.length, 1);
  assert.ok(exp.recorded[0].valence !== undefined && exp.recorded[0].valence < -0.3);
  assert.equal(exp.recorded[0].user_sentiment, "frustrated");
  assert.match(res.content[0].text, /\+ experience/);
});

test("absorb records experience when valence is strongly positive", async () => {
  const { exp } = await run("Alex ist froh und dankbar über das Ergebnis");
  assert.equal(exp.recorded.length, 1);
  assert.ok(exp.recorded[0].valence !== undefined && exp.recorded[0].valence > 0.3);
  assert.equal(exp.recorded[0].user_sentiment, "pleased");
});

test("absorb records experience when arousal is high (intense + exclamations)", async () => {
  const { exp } = await run("DRINGEND sofort kritischer Ausfall!!!");
  assert.equal(exp.recorded.length, 1);
  assert.ok(exp.recorded[0].arousal !== undefined && exp.recorded[0].arousal >= 0.5);
});

test("absorb attaches person_name when first token looks like a name", async () => {
  const { exp } = await run("Marlene ist heute enttäuscht über den Release");
  assert.equal(exp.recorded.length, 1);
  assert.equal(exp.recorded[0].person_name, "Marlene");
  assert.equal(exp.recorded[0].person_relationship, "user");
});

// ---------------------------------------------------------------------------
// Emotional trigger suppressed
// ---------------------------------------------------------------------------

test("absorb skips experience for plain factual text", async () => {
  const { exp, res } = await run("der himmel ist blau");
  assert.equal(exp.recorded.length, 0);
  assert.doesNotMatch(res.content[0].text, /\+ experience/);
});

test("absorb skips experience for ephemeral operational command even if intense", async () => {
  // Arousal would trigger on its own, but ephemeral must win.
  const { exp } = await run("stoppe SOFORT den cron job backup-daily!!!");
  assert.equal(exp.recorded.length, 0);
});

test("absorb skips experience on duplicate memory", async () => {
  const { exp, res } = await run(
    "Alex ist total frustriert über die fehlende Performance",
    { duplicate: true }
  );
  assert.equal(exp.recorded.length, 0);
  assert.match(res.content[0].text, /Already knew this/);
});

test("absorb survives experience service failure (non-fatal)", async () => {
  const { exp, res } = await run("Alex ist sehr enttäuscht", { fail: true });
  // Emotional threshold was hit, but the service threw — memory still stored.
  assert.equal(exp.recorded.length, 0);
  assert.match(res.content[0].text, /Absorbed/);
  assert.match(res.content[0].text, /experience trigger failed/);
});

// ---------------------------------------------------------------------------
// Person name extraction edge cases
// ---------------------------------------------------------------------------

test("absorb does not attach a person when sentence starts with a stopword", async () => {
  const { exp } = await run("Der release ist enttäuschend schlecht ausgefallen");
  assert.equal(exp.recorded.length, 1);
  assert.equal(exp.recorded[0].person_name, undefined);
});

test("absorb does not attach a person for all-caps openers", async () => {
  const { exp } = await run("WICHTIG alles kaputt, hasse diesen bug!!!");
  assert.equal(exp.recorded.length, 1);
  assert.equal(exp.recorded[0].person_name, undefined);
});
