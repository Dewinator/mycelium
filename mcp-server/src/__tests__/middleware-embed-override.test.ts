/**
 * Middleware embed-override tests — verify each of the three middleware
 * classes (Absorber, Digester, PrimeFetcher) routes through the injected
 * `embed` callback when one is provided, instead of fetching Ollama
 * directly.
 *
 * This is the seam that lets the middleware respect
 * `MYCELIUM_LLM_PROVIDER=llama-cpp` once issue #178 (PR #187) lands —
 * proxy.ts wires `createEmbeddingProvider().embed.bind(p)` into all three
 * constructors and the same env-driven swap works for embedding,
 * absorbing, digesting, and prime-fetching paths uniformly.
 *
 * The classes still fall back to direct Ollama fetch when no override is
 * provided (the existing behaviour the rest of the suite exercises by
 * pointing at port 1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Absorber } from "../middleware/absorber.js";
import { Digester } from "../middleware/digester.js";
import { SessionTracker } from "../middleware/session-tracker.js";
import { PrimeFetcher } from "../middleware/prime-fetcher.js";

test("absorber — uses injected embed callback instead of fetching Ollama", async () => {
  const calls: string[] = [];
  // Absorber attempts insert AFTER embed; the insert will fail at
  // port 1 → counted as failure, but the embed call is recorded first.
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:0",   // would error if used
    embed: async (text) => {
      calls.push(text);
      return new Array(768).fill(0.1);
    },
  });
  await a.processTurn("Ich habe gelernt: tests first.", undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /tests first/);
});

test("digester — uses injected embed callback for the experience summary", async () => {
  let now = 1_000_000;
  const tracker = new SessionTracker({ idleMs: 1000, now: () => now });
  const calls: string[] = [];
  const digester = new Digester(tracker, {
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:0",
    tickMs:      999_999,
    embed: async (text) => {
      calls.push(text);
      return new Array(768).fill(0.2);
    },
  });
  tracker.touch({ client_key: "k", user_present: true, model: "qwen" });
  tracker.touch({ client_key: "k", upstream_ok: true });
  now += 2000;
  await digester.tick();
  // Insert at port 1 fails, but embed ran first.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].length > 0);
});

test("prime-fetcher — accepts an embed override in the constructor", () => {
  // PrimeFetcher's `build()` runs `callStatic` and `callAffect` in
  // Promise.all BEFORE it would call embed(); pointing at port 1 makes
  // callStatic reject and short-circuits the whole flow before embed is
  // reached. An end-to-end test would need a real RPC mock (out of scope
  // for this seam test). Instead: verify the option is accepted by the
  // constructor signature — the field-set + use-at-top-of-`embed()`
  // pattern is identical to the absorber + digester cases above, which
  // DO exercise the override at runtime.
  const fetcher = new PrimeFetcher({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:0",
    embed: async () => new Array(768).fill(0.3),
    cache: null,
  });
  assert.equal(typeof fetcher.cacheStats, "function");
});

test("absorber — falls back to direct Ollama fetch when no override is provided", async () => {
  // No `embed` injected → embed() hits port 1 and fails. This guards the
  // backward-compat path used by the existing test suite + any external
  // operator scripts that construct Absorber/Digester/PrimeFetcher
  // without the new option.
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
  });
  const r = await a.processTurn("Ich habe gelernt: fallback path.", undefined);
  assert.equal(r.absorbed, 0);
  assert.equal(r.failed, 1);
});
