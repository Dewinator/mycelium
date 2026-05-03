import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChatFetch,
  OllamaChatProvider,
  createChatProvider,
  extractJSON,
} from "../services/chat.js";

// ---------------------------------------------------------------------------
// extractJSON — pure helper lifted from synthesize-cluster.mjs
// ---------------------------------------------------------------------------

test("extractJSON: strips a single <think> block before JSON", () => {
  const raw = `<think>weighing options</think>{"lesson":"X","confidence":0.8}`;
  const out = extractJSON(raw) as { lesson: string; confidence: number };
  assert.equal(out.lesson, "X");
  assert.equal(out.confidence, 0.8);
});

test("extractJSON: strips multiple <think> blocks across lines", () => {
  const raw = `<think>first thought</think>\n<think>second\nmulti-line\nthought</think>\n{"a":1}`;
  const out = extractJSON(raw) as { a: number };
  assert.equal(out.a, 1);
});

test("extractJSON: handles ```json fenced output", () => {
  const raw = "```json\n{\"a\": 2}\n```";
  const out = extractJSON(raw) as { a: number };
  assert.equal(out.a, 2);
});

test("extractJSON: handles plain ``` fences without language tag", () => {
  const raw = "```\n{\"a\": 3}\n```";
  const out = extractJSON(raw) as { a: number };
  assert.equal(out.a, 3);
});

test("extractJSON: locates JSON when prose surrounds it", () => {
  const raw = "Here is the result: {\"lesson\": \"abc\"} — done.";
  const out = extractJSON(raw) as { lesson: string };
  assert.equal(out.lesson, "abc");
});

test("extractJSON: throws on empty input", () => {
  assert.throws(() => extractJSON(""), /empty model response/);
});

test("extractJSON: throws when no JSON object is present", () => {
  assert.throws(
    () => extractJSON("just prose, no braces here"),
    /no JSON object found/,
  );
});

// ---------------------------------------------------------------------------
// OllamaChatProvider — fetch shape, error path, unload
// ---------------------------------------------------------------------------

function mockFetch(
  responder: (input: string, body: unknown) => { ok: boolean; status?: number; json?: unknown; text?: string },
): { fetchFn: ChatFetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn: ChatFetch = async (input, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: input, body });
    const r = responder(input, body);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      async text() { return r.text ?? ""; },
      async json() { return r.json ?? {}; },
    };
  };
  return { fetchFn, calls };
}

test("OllamaChatProvider.chat sends model+messages and returns content+thinking", async () => {
  const { fetchFn, calls } = mockFetch(() => ({
    ok: true,
    json: { message: { content: "{\"ok\":true}", thinking: "weighed it" } },
  }));
  const p = new OllamaChatProvider({ model: "qwen3:8b", url: "http://localhost:11434", fetchFn });
  const r = await p.chat({
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "go" },
    ],
    think: true,
    options: { temperature: 0.3, num_ctx: 8192 },
  });
  assert.equal(r.content, "{\"ok\":true}");
  assert.equal(r.thinking, "weighed it");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  const sent = calls[0].body as Record<string, unknown>;
  assert.equal(sent.model, "qwen3:8b");
  assert.equal(sent.stream, false);
  assert.equal(sent.think, true);
  assert.equal(sent.keep_alive, "2m");
  assert.deepEqual(sent.options, { temperature: 0.3, num_ctx: 8192 });
  assert.deepEqual(sent.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "go" },
  ]);
});

test("OllamaChatProvider.chat surfaces empty strings when fields missing", async () => {
  const { fetchFn } = mockFetch(() => ({ ok: true, json: { message: {} } }));
  const p = new OllamaChatProvider({ fetchFn });
  const r = await p.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(r.content, "");
  assert.equal(r.thinking, "");
});

test("OllamaChatProvider.chat throws with HTTP status + body on non-2xx", async () => {
  const { fetchFn } = mockFetch(() => ({ ok: false, status: 503, text: "model not loaded" }));
  const p = new OllamaChatProvider({ fetchFn });
  await assert.rejects(
    () => p.chat({ messages: [{ role: "user", content: "x" }] }),
    /Ollama HTTP 503: model not loaded/,
  );
});

test("OllamaChatProvider.chat respects per-request keepAlive override", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ ok: true, json: { message: { content: "{}" } } }));
  const p = new OllamaChatProvider({ keepAlive: "2m", fetchFn });
  await p.chat({ messages: [{ role: "user", content: "x" }], keepAlive: "10s" });
  assert.equal((calls[0].body as Record<string, unknown>).keep_alive, "10s");
});

test("OllamaChatProvider.unload posts keep_alive=0 against /api/generate", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ ok: true, json: {} }));
  const p = new OllamaChatProvider({ url: "http://localhost:11434", model: "qwen3:8b", fetchFn });
  await p.unload();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:11434/api/generate");
  assert.deepEqual(calls[0].body, { model: "qwen3:8b", keep_alive: 0 });
});

test("OllamaChatProvider.unload swallows errors (best-effort)", async () => {
  const fetchFn: ChatFetch = async () => { throw new Error("network down"); };
  const p = new OllamaChatProvider({ fetchFn });
  await p.unload();
});

// ---------------------------------------------------------------------------
// createChatProvider factory — env routing
// ---------------------------------------------------------------------------

function withEnv<T>(patches: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patches)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("createChatProvider defaults to OllamaChatProvider when env unset", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: undefined }, () => {
    const p = createChatProvider();
    assert.equal(p.name, "ollama");
    assert.ok(p instanceof OllamaChatProvider);
  });
});

test("createChatProvider returns OllamaChatProvider on MYCELIUM_LLM_PROVIDER=ollama", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: "ollama" }, () => {
    const p = createChatProvider();
    assert.equal(p.name, "ollama");
  });
});

test("createChatProvider treats provider string case-insensitively", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: "OLLAMA" }, () => {
    const p = createChatProvider();
    assert.equal(p.name, "ollama");
  });
});

test("createChatProvider throws a clear stub error for llama-cpp until follow-up lands", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: "llama-cpp" }, () => {
    assert.throws(createChatProvider, /chat side not yet implemented/);
  });
});

test("createChatProvider accepts the llamacpp alias (no hyphen) the same way", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: "llamacpp" }, () => {
    assert.throws(createChatProvider, /chat side not yet implemented/);
  });
});

test("createChatProvider throws on unknown provider with the supported list", () => {
  withEnv({ MYCELIUM_LLM_PROVIDER: "nonsense" }, () => {
    assert.throws(createChatProvider, /Unknown MYCELIUM_LLM_PROVIDER='nonsense'/);
  });
});
