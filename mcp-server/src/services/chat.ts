/**
 * ChatProvider abstraction — chat-side foundation for issue #178.
 *
 * Mirrors `embeddings.ts` (EmbeddingProvider). Today the only call site is
 * `scripts/synthesize-cluster.mjs` (REM lesson synthesis); long-term the
 * native-app track (#176) needs to swap Ollama HTTP for in-process
 * `node-llama-cpp` (`MYCELIUM_LLM_PROVIDER=llama-cpp`). This file defines
 * the seam — `OllamaChatProvider` is the existing behaviour extracted
 * verbatim; `LlamaCppChatProvider` lands as a follow-up once PR #187's
 * `node-llama-cpp` dependency is on main.
 *
 * Why a fetch-based provider instead of the `ollama` npm client:
 *   the REM synthesizer relies on Ollama 0.20+'s `think:true` + `thinking`
 *   response field (Qwen3 reasoning pathway). The official client did not
 *   expose `thinking` cleanly at the time the script was written; raw fetch
 *   keeps response-shape access explicit. The injectable `fetchFn` keeps
 *   tests off the network.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Sampling temperature (0..1). Provider may clamp to its supported range. */
  temperature?: number;
  /** Context window in tokens. Provider may ignore if not configurable. */
  num_ctx?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  options?: ChatOptions;
  /**
   * Activate the model's reasoning pathway if it has one (Qwen3, R1-distills).
   * Ollama 0.20+ surfaces this as a separate `thinking` response field; the
   * provider returns it on `ChatResult.thinking` when available.
   */
  think?: boolean;
  /**
   * Provider-specific hint to keep the model warm across calls. Ollama
   * accepts a duration string (e.g. "2m"); other providers may ignore it.
   */
  keepAlive?: string;
}

export interface ChatResult {
  /** Final assistant message text. */
  content: string;
  /** Reasoning trace (if the provider exposes it; empty string if not). */
  thinking: string;
}

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResult>;
  /**
   * Best-effort cleanup (Ollama: unload model to free RAM). No-op for
   * stateless providers. Callers should NOT rely on this for correctness —
   * REM nightly calls it after the cluster loop only as a courtesy.
   */
  unload?(): Promise<void>;
  /** Stable identifier for logs and tests (e.g. "ollama", "llama-cpp"). */
  readonly name: string;
}

/**
 * Strip Qwen3 / R1-distill `<think>…</think>` reasoning blocks from a
 * response, then locate the JSON object that follows. Robust to:
 *   - multiple <think> blocks
 *   - prose before/after the JSON
 *   - models that occasionally emit ``` json fences
 *
 * Pure helper — no provider coupling. Lifted from
 * `scripts/synthesize-cluster.mjs` so it can be unit-tested independently.
 */
export function extractJSON(raw: string): unknown {
  if (!raw) throw new Error("empty model response");
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  s = s.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j < 0 || j <= i) {
    throw new Error(`no JSON object found in: ${raw.slice(0, 200)}`);
  }
  const body = s.slice(i, j + 1);
  return JSON.parse(body);
}

/**
 * Minimal subset of `fetch` we need. Allows tests to pass a mock without
 * relying on the global `fetch` and without importing Node's undici types.
 */
export type ChatFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
}

export class OllamaChatProvider implements ChatProvider {
  readonly name = "ollama";
  private readonly url: string;
  private readonly model: string;
  private readonly defaultKeepAlive: string;
  private readonly fetchFn: ChatFetch;

  constructor(opts: {
    url?: string;
    model?: string;
    keepAlive?: string;
    fetchFn?: ChatFetch;
  } = {}) {
    this.url = opts.url ?? "http://localhost:11434";
    this.model = opts.model ?? "qwen3:8b";
    this.defaultKeepAlive = opts.keepAlive ?? "2m";
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const r = await this.fetchFn(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        stream: false,
        keep_alive: req.keepAlive ?? this.defaultKeepAlive,
        // Bewusst KEIN format:"json" — würde mit Reasoning kollidieren.
        // Caller runs extractJSON() on result.content.
        think: req.think ?? false,
        options: req.options ?? {},
      }),
    });
    if (!r.ok) {
      throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    const j = (await r.json()) as OllamaChatResponse;
    return {
      content: j?.message?.content ?? "",
      thinking: j?.message?.thinking ?? "",
    };
  }

  /** Free RAM by unloading the model (Ollama: keep_alive=0 on /api/generate). */
  async unload(): Promise<void> {
    try {
      await this.fetchFn(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, keep_alive: 0 }),
      });
    } catch {
      // best-effort; nightly must not fail on unload
    }
  }
}

/**
 * Env-driven factory. Honors the same `MYCELIUM_LLM_PROVIDER` switch as
 * `createEmbeddingProvider()` so a single env var routes both halves of the
 * native-app stack. Today only `ollama` is implemented; `llama-cpp` is a
 * follow-up that lands once PR #187's `node-llama-cpp` dependency is on
 * main (otherwise it would force the package on installs that don't need
 * it).
 */
export function createChatProvider(): ChatProvider {
  const raw = (process.env.MYCELIUM_LLM_PROVIDER ?? "ollama").toLowerCase();
  const provider = raw === "llamacpp" ? "llama-cpp" : raw;
  switch (provider) {
    case "ollama":
      return new OllamaChatProvider({
        url: process.env.OLLAMA_URL,
        model: process.env.REM_MODEL,
        keepAlive: process.env.REM_KEEP_ALIVE,
      });
    case "llama-cpp":
      throw new Error(
        "MYCELIUM_LLM_PROVIDER=llama-cpp: chat side not yet implemented " +
          "(LlamaCppChatProvider lands as a follow-up to PR #187). Use ollama for now.",
      );
    default:
      throw new Error(
        `Unknown MYCELIUM_LLM_PROVIDER='${raw}' (expected 'ollama' or 'llama-cpp')`,
      );
  }
}
