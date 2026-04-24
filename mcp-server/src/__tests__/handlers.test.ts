import { test } from "node:test";
import assert from "node:assert/strict";
import { remember } from "../tools/remember.js";
import { recall } from "../tools/recall.js";
import { forget } from "../tools/forget.js";
import { update } from "../tools/update.js";
import { list } from "../tools/list.js";
import type { MemoryService } from "../services/supabase.js";
import type { AffectService, AffectEvent, AffectState } from "../services/affect.js";
import type { ProjectService } from "../services/projects.js";
import type {
  Memory,
  MemorySearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
} from "../types/memory.js";

class FakeProjectService implements Partial<ProjectService> {
  async resolveScope(_slug: string | null | undefined, _agent: string): Promise<string | null> {
    return null;
  }
  async applyScopeToRow(): Promise<void> { /* no-op */ }
}
const fakeProjects = new FakeProjectService();

class FakeAffectService implements Partial<AffectService> {
  async apply(_e: AffectEvent, _i = 0.1): Promise<AffectState | null> { return null; }
  async get(): Promise<AffectState> {
    return {
      curiosity: 0.5, frustration: 0, satisfaction: 0.5, confidence: 0.5,
      decay_factor: 1, updated_at: "2026-04-18T00:00:00Z", hours_since: 0, last_event: null,
    };
  }
}
const fakeAffect = new FakeAffectService() as unknown as AffectService;

const UUID = "11111111-2222-3333-4444-555555555555";

function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: UUID,
    content: "default content",
    category: "general",
    tags: [],
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    strength: 1.0,
    importance: 0.5,
    access_count: 0,
    valence: 0,
    arousal: 0,
    stage: "episodic",
    pinned: false,
    decay_tau_days: 30,
    useful_count: 0,
    ...over,
  };
}

async function noop() {}

class FakeService implements Partial<MemoryService> {
  created: CreateMemoryInput[] = [];
  updated: UpdateMemoryInput[] = [];
  deleted: string[] = [];
  searched: string[] = [];

  constructor(
    private opts: {
      searchResults?: MemorySearchResult[];
      getResult?: Memory | null;
      listResults?: Memory[];
    } = {}
  ) {}

  async create(input: CreateMemoryInput): Promise<Memory> {
    this.created.push(input);
    return makeMemory({ ...input, content: input.content });
  }

  async search(query: string): Promise<MemorySearchResult[]> {
    this.searched.push(query);
    return this.opts.searchResults ?? [];
  }

  async touch(_ids: string[]): Promise<void> {}
  async coactivate(_ids: string[]): Promise<void> {}
  async spread(_ids: string[]): Promise<never[]> { return []; }
  async emitRecalled(_h: number, _s: number, _q: number, _src: string): Promise<void> {}

  async get(id: string): Promise<Memory | null> {
    return this.opts.getResult === undefined ? makeMemory({ id }) : this.opts.getResult;
  }

  async update(input: UpdateMemoryInput): Promise<Memory> {
    this.updated.push(input);
    return makeMemory({ id: input.id, content: input.content ?? "x" });
  }

  async delete(id: string): Promise<boolean> {
    this.deleted.push(id);
    return true;
  }

  async list(category?: string): Promise<Memory[]> {
    return this.opts.listResults ?? [];
  }
}

test("remember returns id and category in text", async () => {
  const svc = new FakeService();
  const res = await remember(svc as unknown as MemoryService, fakeAffect, fakeProjects as unknown as ProjectService, "main", {
    content: "the sky is blue",
    category: "topics",
    tags: [],
  });
  assert.match(res.content[0].text, /Remembered \(topics/);
  assert.match(res.content[0].text, /the sky is blue/);
  assert.equal(svc.created.length, 1);
  assert.equal(svc.created[0].category, "topics");
});

test("remember truncates long content in output", async () => {
  const svc = new FakeService();
  const long = "x".repeat(200);
  const res = await remember(svc as unknown as MemoryService, fakeAffect, fakeProjects as unknown as ProjectService, "main", {
    content: long,
    category: "general",
    tags: [],
  });
  assert.match(res.content[0].text, /\.\.\./);
});

test("recall returns 'no matching' when empty", async () => {
  const svc = new FakeService({ searchResults: [] });
  const res = await recall(svc as unknown as MemoryService, fakeAffect, {
    query: "anything",
    limit: 10,
    vector_weight: 0.7,
    spread: false, with_experiences: false,
    ignore_affect: true,
    cite: false,
  });
  assert.match(res.content[0].text, /No matching memories/);
});

test("recall formats results with rank, score and id", async () => {
  const svc = new FakeService({
    searchResults: [
      {
        id: UUID,
        content: "matching content",
        category: "people",
        tags: ["alice"],
        metadata: {},
        stage: "episodic",
        strength: 1.0,
        importance: 0.5,
        access_count: 0,
        pinned: false,
        relevance: 0.9,
        strength_now: 1.0,
        salience: 1.0,
        effective_score: 0.873,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const res = await recall(svc as unknown as MemoryService, fakeAffect, {
    query: "alice",
    limit: 10,
    vector_weight: 0.7,
    spread: false, with_experiences: false,
    ignore_affect: true,
    cite: false,
  });
  assert.match(res.content[0].text, /Found 1 memories/);
  assert.match(res.content[0].text, /1\. \[people\//);
  assert.match(res.content[0].text, /0\.873/);
  assert.match(res.content[0].text, /alice/);
});

test("forget reports not-found when missing", async () => {
  const svc = new FakeService({ getResult: null });
  const res = await forget(svc as unknown as MemoryService, { id: UUID });
  assert.match(res.content[0].text, /not found/);
  assert.equal(svc.deleted.length, 0);
});

test("forget deletes existing memory", async () => {
  const svc = new FakeService({
    getResult: makeMemory({ content: "to delete" }),
  });
  const res = await forget(svc as unknown as MemoryService, { id: UUID });
  assert.match(res.content[0].text, /Deleted memory/);
  assert.deepEqual(svc.deleted, [UUID]);
});

test("update passes input through to service", async () => {
  const svc = new FakeService();
  const res = await update(svc as unknown as MemoryService, {
    id: UUID,
    content: "patched",
    tags: ["new"],
  });
  assert.match(res.content[0].text, /Updated memory/);
  assert.equal(svc.updated[0].content, "patched");
  assert.deepEqual(svc.updated[0].tags, ["new"]);
});

test("list reports empty state", async () => {
  const svc = new FakeService({ listResults: [] });
  const res = await list(svc as unknown as MemoryService, { limit: 20 });
  assert.match(res.content[0].text, /No memories/);
});

test("list reports empty state for filtered category", async () => {
  const svc = new FakeService({ listResults: [] });
  const res = await list(svc as unknown as MemoryService, {
    category: "people",
    limit: 20,
  });
  assert.match(res.content[0].text, /people/);
});

test("list renders memories", async () => {
  const svc = new FakeService({
    listResults: [
      makeMemory({ content: "first", category: "topics", tags: ["a", "b"] }),
      makeMemory({ id: "22222222-2222-3333-4444-555555555555", content: "second", category: "general" }),
    ],
  });
  const res = await list(svc as unknown as MemoryService, { limit: 20 });
  assert.match(res.content[0].text, /first/);
  assert.match(res.content[0].text, /second/);
});
