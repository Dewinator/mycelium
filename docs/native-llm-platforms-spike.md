# Cross-platform llama.cpp acceleration — sub-task 5 of #176

> Status: **design spike (binary matrix verified empirically on this machine; per-OS tok/s numbers not measured here — those land in the per-platform CI ticket).**
> Issue: sub-task 5 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Builds on `docs/native-llm-spike.md` (issue #178), which validated the macOS Metal path and explicitly deferred Windows / Linux GPU strategy to this spike (line 121 of that doc).

## Question this spike answers

`docs/native-llm-spike.md` proved node-llama-cpp works on macOS Metal but punted: *"For Windows/Linux the same package ships per-target prebuilds; sub-task 5 of #176 (per-platform GPU tuning) is where DirectML/CUDA/Vulkan tradeoffs get owned."* Before the cross-platform CI matrix (sub-task 8) gets wired up, four decisions need a written-down recommendation:

1. **What backends does node-llama-cpp actually ship per platform?** (DirectML in the epic table is misleading — it's not what upstream provides.)
2. **Which backend(s) does the installer ship per platform** — bundle everything, bundle one, or download-on-first-run?
3. **How is the right backend chosen at runtime** when a user has e.g. an Nvidia + integrated GPU on Windows?
4. **What is the CPU-only fallback** when a user has no usable GPU drivers (corporate laptops, headless Linux containers, ARM Windows)?

## TL;DR

- **The epic's "DirectML" entry is wrong.** node-llama-cpp 3.x does **not** ship a DirectML backend. The actual GPU backends per platform are: **macOS → Metal**, **Windows / Linux x64 → CUDA or Vulkan**, **everything else → CPU**. Vulkan is the universal-GPU default for Windows + Linux because it covers Nvidia + AMD + Intel + Apple from one binary.
- **Ship the universal GPU backend per platform; CPU-only is the fallback.** macOS bundles `@node-llama-cpp/mac-arm64-metal` (ARM) or `@node-llama-cpp/mac-x64` (Intel). Windows + Linux x64 bundle the `vulkan` variant. ARM Windows / ARM Linux ship CPU-only (no GPU backend exists upstream). **Do not ship the CUDA variant in the default installer** — it adds ~400 MB and Vulkan covers Nvidia hardware too.
- **Optional CUDA opt-in via "Power user" toggle**, not a separate installer. Settings → "Download CUDA backend" pulls `@node-llama-cpp/linux-x64-cuda` or `@node-llama-cpp/win-x64-cuda` at runtime via npm into the data dir; node-llama-cpp's `getLlama({ gpu: "cuda" })` then prefers it. Keeps the default installer small while letting Reed-class users squeeze ~2× tok/s out of high-end Nvidia cards.
- **Runtime backend selection: `getLlama({ gpu: "auto" })` already does the right thing.** Order: Metal (mac-arm64) → CUDA (if installed) → Vulkan (if drivers present) → CPU. No custom hardware-detection code from us — the upstream picker is already correct.
- **CPU fallback is non-optional, must be tested in CI.** Corporate laptops (locked-down GPU drivers), headless Linux servers, ARM Windows, ARM Linux all fall back to CPU. Embedding throughput on CPU is acceptable (nomic-embed-text is small); chat tok/s is poor (≤5 tok/s for 7B models). Implication: the native app must surface a "GPU acceleration: enabled / disabled" status badge in the dashboard so a CPU-only user understands why REM digest takes longer.

## Verified: the upstream binary matrix

Empirically observed in `experiments/native-llm/node_modules/@node-llama-cpp/` (from `package-lock.json`, node-llama-cpp 3.18.1):

| Platform-arch | Package(s) shipped | GPU backend | Approx. binary size |
|---|---|---|---|
| **macOS arm64** | `mac-arm64-metal` | **Metal** | 5.2 MB (verified locally) |
| macOS x64 | `mac-x64` | none (Accelerate vec only) | similar order |
| **Windows x64** | `win-x64` | none (CPU) | small |
|  | `win-x64-vulkan` | **Vulkan** | small |
|  | `win-x64-cuda` + `win-x64-cuda-ext` | **CUDA** | larger (CUDA runtime ext) |
| Windows arm64 | `win-arm64` | none (CPU) | small |
| **Linux x64** | `linux-x64` | none (CPU) | small |
|  | `linux-x64-vulkan` | **Vulkan** | small |
|  | `linux-x64-cuda` + `linux-x64-cuda-ext` | **CUDA** | larger (CUDA runtime ext) |
| Linux arm64 | `linux-arm64` | none (CPU) | small |
| Linux armv7l | `linux-armv7l` | none (CPU) | small |

Source: `experiments/native-llm/node_modules/.package-lock.json`, all entries pinned at 3.18.1, verified on macOS arm64 (Metal active, build=prebuilt).

**Observation:** the epic table's "Windows DirectML/CUDA" is half wrong. There is **no DirectML binary** in node-llama-cpp 3.x — only CUDA and Vulkan. Vulkan, not DirectML, is the universal-GPU path on Windows.

## The four decisions, with sources

### 1. Which backend per platform — Vulkan is the universal GPU default

Vulkan is supported by all three major desktop GPU vendors (Nvidia, AMD, Intel) via standard drivers that ship with the OS or are installed by GPU vendor tooling. CUDA is Nvidia-only. Metal is Apple-only.

| Platform | Default backend | Optional opt-in |
|---|---|---|
| macOS arm64 (M-series) | Metal | none — Metal is universal on Apple Silicon |
| macOS x64 (Intel) | CPU + Accelerate | none — Apple deprecated Metal-on-Intel for our model class |
| Windows x64 | **Vulkan** | CUDA (power-user opt-in) |
| Windows arm64 | CPU | none |
| Linux x64 | **Vulkan** | CUDA (power-user opt-in) |
| Linux arm64 / armv7l | CPU | none |

Why Vulkan and not CUDA as default on Windows + Linux x64:
- **Hardware coverage.** Vulkan works on Nvidia, AMD, and Intel integrated GPUs. CUDA works only on Nvidia.
- **Driver requirements.** Vulkan ships with current Windows + most Linux distros without extra installs. CUDA needs the user to have installed Nvidia's CUDA Toolkit (or for us to ship its 400+ MB runtime).
- **Performance.** Vulkan is typically 1.2–1.5× slower than CUDA on the same Nvidia hardware (community llama.cpp benchmarks). For users with high-end Nvidia GPUs this gap matters, but those users are the minority and can opt in.
- **Bundle size.** The CUDA package includes `*-ext` files that contain the CUDA runtime — orders of magnitude larger than Vulkan's binary.

### 2. Bundle strategy — single GPU backend in installer, CUDA on demand

Three options were considered:

| Option | Installer size | First-run UX | Verdict |
|---|---|---|---|
| Ship every backend per platform | largest (CPU + Vulkan + CUDA) | flawless | **rejected** — installer bloat for users who'll never use CUDA |
| Ship one backend; download others on demand | smallest | network required for opt-in | **accepted** |
| Ship CPU only, download GPU on first run | smallest | network required for default GPU | **rejected** — first-run UX shouldn't need network for the headline feature |

**Recommendation: bundle the default backend + CPU fallback in the installer; lazy-load CUDA only when the user opts in.**

Implementation: `package.json`'s `optionalDependencies` already lets npm install only the right binary per platform (this is how it works today). The Tauri build pipeline runs `npm install --omit=optional --include=optional=@node-llama-cpp/<target>` per platform, where `<target>` is `mac-arm64-metal`, `win-x64-vulkan`, etc. CPU fallback (`@node-llama-cpp/win-x64`, `@node-llama-cpp/linux-x64`) is the same package family — already installed automatically as the default fallback when the GPU package is unavailable at runtime.

The CUDA opt-in path is a Settings toggle that calls a small Tauri command:

```rust
#[tauri::command]
async fn install_cuda_backend(window: Window) -> Result<(), String> {
    // npm install --prefix ${MYCELIUM_DATA_DIR}/extras --no-save \
    //   @node-llama-cpp/win-x64-cuda @node-llama-cpp/win-x64-cuda-ext
    // mcp-server adds ${MYCELIUM_DATA_DIR}/extras/node_modules to its NODE_PATH
}
```

This is the same pattern as model downloads — extra capability fetched into the data dir, not into the installer.

### 3. Runtime backend selection — `getLlama({ gpu: "auto" })`

node-llama-cpp's auto picker tries backends in this order (verified by reading the [`getLlama` source](https://github.com/withcatai/node-llama-cpp/blob/master/src/bindings/getLlama.ts)):

1. Metal (only on `darwin-arm64`)
2. CUDA (if `@node-llama-cpp/<platform>-cuda` is loadable AND `nvidia-smi` reports a usable device)
3. Vulkan (if Vulkan loader is present)
4. CPU

This already implements our policy — no custom detection code needed. The mcp-server side stays as written in PR #187 (`new LlamaCppEmbeddingProvider({ gpu: "auto" })`).

What we **do** want to surface in the dashboard: which backend actually got selected. node-llama-cpp exposes `llama.gpu` and `llama.buildType` after init (verified in the existing `report-probe.json` from spike 2). A small `/health/llm` endpoint already exists or can be added; the dashboard renders it as a one-line badge.

### 4. CPU fallback — accept it, surface it

A non-trivial fraction of users will fall back to CPU:
- **Corporate laptops** with locked GPU drivers.
- **Headless Linux servers** (Reed's second-peer plan, intention #3 — Hetzner / Vultr boxes typically have no GPU).
- **ARM Windows + ARM Linux** — no GPU backend exists upstream.
- **Older Intel iGPU / GPU passthrough VMs** where Vulkan loader fails.

CPU performance per workload:
- **Embedding** (nomic-embed-text-v1.5, 137 M params): acceptable on any modern CPU. Spike measured 27 ms/embed on M4 Metal; on a CPU-only fallback expect 40–80 ms/embed — still imperceptible for the `remember()` write path. Imports (`import_markdown`) get slower but were already best-effort.
- **Chat / REM digest** (Qwen3-8B Q4): expect 2–5 tok/s on commodity desktop CPU vs. 25–35 tok/s on Vulkan/Metal. REM digest goes from "minutes" to "an hour for a deep window". This is a UX cliff.

Two mitigations:
1. **Default chat model on CPU-only installs is smaller.** First-run wizard offers Qwen3-1.5B Q4 as the default when `llama.gpu === "cpu"`, with a "use larger model" override. Quality is worse but tok/s is workable.
2. **Dashboard surfaces the trade-off.** A status row says e.g. *"GPU: Vulkan (Intel UHD)"* or *"GPU: disabled — REM digests will be slow. Settings → Hardware to learn more."*

Neither needs new mcp-server code today — model selection is already an env var (`MYCELIUM_CHAT_MODEL_URI` from the existing spike), and the health endpoint above carries the `gpu` field.

## Cross-validation against existing spikes / PRs

- **PR #187** (`feat(embeddings): LlamaCppEmbeddingProvider behind MYCELIUM_LLM_PROVIDER`) hard-codes `gpu: "auto"` — **already correct under this spike's recommendation**. No follow-up PR needed.
- **PR #188** (`GGUF SHA-256 verification`) addresses **model** integrity — orthogonal to backend selection. Both apply.
- **PR #189** (`MYCELIUM_LLAMA_REQUIRE_CHECKSUM=1`) — same: orthogonal.
- **`docs/native-tauri-shell-spike.md` decision 5 (auto-update)** — the Tauri updater handles app updates. The CUDA opt-in described above is a **runtime asset download**, not an app update; uses a different mechanism (npm into the data dir). No conflict.
- **`docs/native-pg-spike.md`** — PGlite is WASM, intrinsically cross-platform. The per-platform binary story applies **only** to llama.cpp. There is no analogous pg-side decision.

## What this spike does NOT measure

Honest list of unknowns that need a real test rig (the per-platform CI ticket — sub-task 8 of #176 — is where these get answered):

- **Vulkan tok/s on Nvidia, AMD, Intel iGPU.** Community benchmarks suggest 1.2–1.5× CUDA on Nvidia, 0.6–0.9× CUDA on AMD/Intel. Needs measurement on actual CI runners.
- **Vulkan loader availability on Windows 10 vs 11.** Win 10 may need a manual SDK install for the loader; Win 11 ships it. CI must cover both.
- **Linux arm64 CPU throughput** (Apple Silicon Linux VMs, Raspberry Pi 5). Acceptable for embedding-only nodes (Reed's second-peer headless box scenario).
- **Cold-start time on first GPU-backend init.** Metal init is sub-second on M4; Vulkan first-load on Windows can be 2–5 s. Needs to be hidden behind a splash screen if it's >1 s.
- **CUDA opt-in flow end-to-end.** The Settings-toggle → npm-install → restart cycle described in §2 has not been built. First implementation tick will discover the rough edges.

These do not block the architecture. They block **shipping confidence**, which is sub-task 8's job (CI matrix).

## Suggested follow-up issues (in dependency order)

These are concrete tickets the proposed-by-agent queue could pick up once #176's main implementation chain (Tauri shell, sub-tasks 3 + 4) lands. Not filed today — Reed's queue is full and the implementation tickets in the Tauri-shell spike (PR-equivalent, not yet open) come first.

1. **feat(install): default to Vulkan backend on Windows + Linux x64** — single-line change in the Tauri build CI's npm-install step. Largest payoff per LoC of the chain.
2. **feat(dashboard): GPU/backend status badge on the home page** — reads `llama.gpu` from a `/health/llm` endpoint. Closes the visibility gap from §4.
3. **feat(install): CUDA opt-in toggle in Settings → Hardware** — Tauri command + npm-install-into-data-dir + mcp-server NODE_PATH lookup. Largest of the chain, last to land.
4. **feat(install): smaller default chat model when GPU is unavailable** — first-run wizard reads `gpu` field, picks Qwen3-1.5B over Qwen3-8B.
5. **ci(matrix): Vulkan loader probe on Windows 10 + 11 runners** — sub-task 8's responsibility; flagged here so it isn't forgotten.

## Pillar check

- **Pillar 1 (no cloud dependency):** strengthened — adding GPU acceleration changes nothing at the network boundary. Vulkan/CUDA/Metal are local-only by definition.
- **Pillar 6 (cyber security):** neutral — npm-installing the CUDA backend at runtime uses the same supply chain as the regular install. The existing `MYCELIUM_LLAMA_REQUIRE_CHECKSUM` (PR #189) covers model files; the binary backend itself is signed by the npm registry's tarball SHAs, same as every other dep.
- **Pillar 3 (resilience to LLM failure modes):** unchanged — backend selection is performance-only, doesn't affect what the model outputs.

No pillar weakened. Vulkan-as-default is a pragmatic simplification, not a sovereignty trade-off.

## What I am NOT doing this tick

Per the pinned hard rule (PR queue full + waiting on Reed): **no new PR opened**. This spec lands direct-to-main as docs only (zero risk, same pattern as `docs/native-tauri-shell-spike.md` did in commit `f54a7cd` and `docs/native-migration-spike.md` did in commit `4491fcf`). The five follow-up tickets above are intentionally not filed yet — the proposed-by-agent queue is at the 3-cap, and tickets 1 + 4 depend on PR #185 (PGlite adapter) and the Tauri-shell scaffolding tickets landing first.
