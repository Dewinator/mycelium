# Native-app track — overview

> Initiative epic: [#176 — native standalone app (no Docker)](https://github.com/Dewinator/mycelium/issues/176)
> Phase: **spike phase complete (10/10)** · Implementation phase: **gated on PR-queue drain**
> Last refreshed: 2026-05-02

This is the canonical entry point for the native-app initiative. Each sub-task
has its own design spike doc in `docs/native-*.md`; this page maps them together
so a fresh reader does not have to reconstruct the picture from issue comments.

## Why this track exists

Docker Desktop is the single biggest install-time barrier today (~1.5 GB
download, Apple-ID prompt, reboot, "Allow Privileged Helper"). The pitch is
*"your AI — local, sovereign, no cloud"*; every prospective non-developer user
bounces during the Docker step.

End state: one signed/notarized installer per platform (`.dmg` / `.msi` /
`.AppImage`-or-`.deb`), no Docker, no separate Ollama install, auto-update
built in. See [#176](https://github.com/Dewinator/mycelium/issues/176) for the
full architecture rationale (Path A vs alternatives).

## Architecture (Path A) at a glance

| Component | Today (Docker) | Native target |
|---|---|---|
| Postgres + pgvector | Docker container | **PGlite** (WASM, in-process) — pgvector built in |
| Embedding (`nomic-embed-text`) | Ollama HTTP @ 11434 | `node-llama-cpp` direct call, GGUF bundled |
| LLM (`qwen3:8b`, REM) | Ollama | `node-llama-cpp` direct call, GGUF bundled |
| MCP server | Node + tsc | Tauri sidecar (Node subprocess) |
| Dashboard | Browser → localhost:8787 | Tauri WebView (localhost HTTP IPC) |
| Updates | `bash scripts/update.sh` | `tauri-plugin-updater` (one toolchain) |
| Data dir | `~/vectormemory-openclaw/docker/volumes/` | OS-native: `~/Library/Application Support/mycelium/`, `%APPDATA%\mycelium\`, `~/.local/share/mycelium/` |

Two notable shifts vs the original epic body:

- **Postgres**: the originally-proposed `@embedded-postgres-binaries/*` route
  does not ship `pgvector`. Spike 1 evaluated and chose **PGlite** instead —
  one cross-platform npm dep, pgvector 0.8.1 built in, 79/79 active migrations
  green. See [`native-pg-spike.md`](native-pg-spike.md) and
  [`native-pg-platforms-spike.md`](native-pg-platforms-spike.md).
- **Updater**: the originally-proposed Sparkle / MSIX / AppImage-update triple
  collapses to a single `tauri-plugin-updater` toolchain. See
  [`native-update-ops-spike.md`](native-update-ops-spike.md) and
  [`native-update-banner-spike.md`](native-update-banner-spike.md).

## Sub-tasks → spikes → implementation PRs

| # | Sub-task | Spike doc(s) | Impl PRs |
|---|---|---|---|
| 1 | Native PG (PGlite) | [`native-pg-spike.md`](native-pg-spike.md) | [#185](https://github.com/Dewinator/mycelium/pull/185) (adapter), [#194](https://github.com/Dewinator/mycelium/pull/194) (re-validation) |
| 2 | `node-llama-cpp` bridge | [`native-llm-spike.md`](native-llm-spike.md), `native-llm-regen-migration.md` ([#193](https://github.com/Dewinator/mycelium/pull/193)) | [#187](https://github.com/Dewinator/mycelium/pull/187) → [#188](https://github.com/Dewinator/mycelium/pull/188) → [#189](https://github.com/Dewinator/mycelium/pull/189) (stacked); [#190](https://github.com/Dewinator/mycelium/pull/190), [#191](https://github.com/Dewinator/mycelium/pull/191), [#192](https://github.com/Dewinator/mycelium/pull/192) |
| 3 | Tauri shell | [`native-tauri-shell-spike.md`](native-tauri-shell-spike.md) | _none yet_ |
| 4 | Cross-platform PG | [`native-pg-platforms-spike.md`](native-pg-platforms-spike.md) | _spec only — PGlite is one binary, no per-OS work_ |
| 5 | Cross-platform llama.cpp | [`native-llm-platforms-spike.md`](native-llm-platforms-spike.md) | _spec only — Vulkan default, CUDA opt-in_ |
| 6 | Auto-update channels | [`native-update-ops-spike.md`](native-update-ops-spike.md) | _none yet_ |
| 7 | Docker → native migration wizard | [`native-migration-spike.md`](native-migration-spike.md) | _none yet — gated on #185 + #187 live_ |
| 8 | CI matrix (build + sign) | [`native-ci-release-spike.md`](native-ci-release-spike.md) | _none yet_ |
| 9 | Update banner refit | [`native-update-banner-spike.md`](native-update-banner-spike.md) | _none yet_ |
| 10 | Docs refresh | [`native-docs-refresh-spike.md`](native-docs-refresh-spike.md) | _gated on at least one signed installer per platform_ |

## Recommended merge order — open PR queue (9 deep, all green, all `MERGEABLE`)

This is the order that requires zero rebases. Doc-only first, then independent
code, then the stacked llama-cpp chain.

1. **[#194](https://github.com/Dewinator/mycelium/pull/194)** — PGlite spike re-validation (doc + JSON only).
2. **[#193](https://github.com/Dewinator/mycelium/pull/193)** — Regen migration design (doc only).
3. **[#191](https://github.com/Dewinator/mycelium/pull/191)** — Cross-provider cosine spike (doc + `experiments/`).
4. **[#185](https://github.com/Dewinator/mycelium/pull/185)** — PGlite adapter foundation (independent of llama-cpp track).
5. **[#187](https://github.com/Dewinator/mycelium/pull/187)** — `LlamaCppEmbeddingProvider` (root of llama-cpp stack).
6. **[#188](https://github.com/Dewinator/mycelium/pull/188)** — GGUF SHA-256 (stacked on #187, auto-retargets to `main`).
7. **[#189](https://github.com/Dewinator/mycelium/pull/189)** — `MYCELIUM_LLAMA_REQUIRE_CHECKSUM=1` fail-closed (stacked on #188).
8. **[#190](https://github.com/Dewinator/mycelium/pull/190)** — Middleware `EmbeddingProvider` injection.
9. **[#192](https://github.com/Dewinator/mycelium/pull/192)** — `ChatProvider` abstraction (completes the chat half).

Empirically validated: applying these nine PRs in this order on a temp branch
off `main` yields zero conflicts and 998/999 tests green (1 pre-existing skip).

## Post-drain implementation gate

After the queue drains, the next-tick targets are sub-tasks **3, 6, 7, 8, 9, 10**.
Rough sizing:

- **Sub-task 3 (Tauri shell)** — likely the single biggest PR of the remaining
  set: `tauri.conf.json`, sidecar lifecycle scripts for PG + MCP-server, tray UI.
- **Sub-tasks 6, 8, 9** form the release/update pipeline triangle. The three
  spike docs already align on `tauri-plugin-updater`, so they can land in any
  order once the queue is empty.
- **Sub-task 7 (migration wizard)** depends on #185 + #187 being live so the
  embedded data dir exists.
- **Sub-task 10 (docs refresh)** is gated on at least one signed installer per
  platform existing.

Until the queue drains, the highest-value tick action is *making the merge
cheaper* (validating the order, posting consolidated status), not adding more
diffs to the queue.

## Pillar check

- **Pillar 1 (no cloud dependency)**: strengthened — moves from "needs Docker
  daemon" to "fully embedded".
- **Pillar 6 (security)**: data dir moves to OS-native; signed/notarized
  installers; GGUF model files SHA-256 verified ([#188](https://github.com/Dewinator/mycelium/pull/188), [#189](https://github.com/Dewinator/mycelium/pull/189)).
- No pillar weakened.

## Out of scope

- iOS / Android — separate roadmap.
- Cloud-hosted variant — explicitly rejected per the swarm sovereignty thesis.
- Replacing Postgres entirely with SQLite — possible later optimization; for
  now schema/migrations stay identical so the Docker and native stacks
  dual-build during transition.
