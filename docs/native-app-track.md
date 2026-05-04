# Native-app track — overview

> Initiative epic: [#176 — native standalone app (no Docker)](https://github.com/Dewinator/mycelium/issues/176)
> Phase: **implementation underway** — sub-tasks 1, 2, 3 (most), 4, 5, 7 (core) landed; 5 PRs open, all `CLEAN`+`MERGEABLE`, ~26 h Reed-lag since the last merge train (#202–#207, 2026-05-03 10:24 UTC).
> Last refreshed: 2026-05-04

This is the canonical entry point for the native-app initiative. Each sub-task
has its own design spike doc in `docs/native-*.md`; this page maps them together
so a fresh reader does not have to reconstruct the picture from issue comments.

## Why this track exists

Docker Desktop is the single biggest install-time barrier today (~1.5 GB
download, Apple-ID prompt, reboot, "Allow Privileged Helper"). The pitch is
*"your AI — local, sovereign, no cloud"*; every prospective non-developer user
bounces during the Docker step.

End state: one signed/notarized installer per platform (`.pkg` / `.msi` /
`.AppImage`-or-`.deb`), no Docker, no separate Ollama install, auto-update
built in. See [#176](https://github.com/Dewinator/mycelium/issues/176) for the
full architecture rationale (Path A vs alternatives) — including the
2026-05-04 installer-format decision (macOS ships `.pkg`, not `.dmg`, to skip
the drag-to-Applications ritual and play cleaner with `tauri-plugin-updater`
+ first-launch bootstrap).

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

Legend: ✅ landed on `main` · 🔄 PR open · ⏳ spike-only, implementation pending

| # | Sub-task | Spike doc(s) | Impl PRs |
|---|---|---|---|
| 1 | Native PG (PGlite) | [`native-pg-spike.md`](native-pg-spike.md) | ✅ [#185](https://github.com/Dewinator/mycelium/pull/185) adapter · ✅ [#194](https://github.com/Dewinator/mycelium/pull/194) re-validation · ✅ [#204](https://github.com/Dewinator/mycelium/pull/204) 79-migration walk as CI gate |
| 2 | `node-llama-cpp` bridge | [`native-llm-spike.md`](native-llm-spike.md), [`native-llm-regen-migration.md`](native-llm-regen-migration.md) ([#193](https://github.com/Dewinator/mycelium/pull/193)) | ✅ [#187](https://github.com/Dewinator/mycelium/pull/187) → ✅ [#188](https://github.com/Dewinator/mycelium/pull/188) → ✅ [#189](https://github.com/Dewinator/mycelium/pull/189) (stacked) · ✅ [#190](https://github.com/Dewinator/mycelium/pull/190) provider injection · ✅ [#191](https://github.com/Dewinator/mycelium/pull/191) cosine cross-validation · ✅ [#192](https://github.com/Dewinator/mycelium/pull/192) `ChatProvider` |
| 3 | Tauri shell | [`native-tauri-shell-spike.md`](native-tauri-shell-spike.md) | ✅ [#202](https://github.com/Dewinator/mycelium/pull/202) `MYCELIUM_DATA_DIR` layout · ✅ [#203](https://github.com/Dewinator/mycelium/pull/203) Tauri 2 shell scaffold · ✅ [#206](https://github.com/Dewinator/mycelium/pull/206) `open_data_dir` / `check_for_updates` / `restart_app` commands · ✅ [#207](https://github.com/Dewinator/mycelium/pull/207) `tauri-plugin-updater` wired to GitHub Releases · 🔄 [#208](https://github.com/Dewinator/mycelium/pull/208) sidecar bundling pipeline (first `.app` builds clean) · 🔄 [#209](https://github.com/Dewinator/mycelium/pull/209) `DbClient` factory + `MYCELIUM_USE_PGLITE` switch (sub-story root) · 🔄 [#210](https://github.com/Dewinator/mycelium/pull/210) `SwarmPinService` → `DbClient` (stacked on #209) · 🔄 [#211](https://github.com/Dewinator/mycelium/pull/211) `SkillsService` → `DbClient` (stacked on #210) |
| 4 | Cross-platform PG | [`native-pg-platforms-spike.md`](native-pg-platforms-spike.md) | ✅ inherent — PGlite is one WASM binary; cross-platform is automatic and validated by #194 + #204 (79/79 migrations green) |
| 5 | Cross-platform llama.cpp | [`native-llm-platforms-spike.md`](native-llm-platforms-spike.md) | ✅ inherent — `node-llama-cpp` ships native bindings per platform; spike validates Vulkan default, CUDA opt-in |
| 6 | Auto-update channels | [`native-update-ops-spike.md`](native-update-ops-spike.md) | ⏳ spike landed (`tauri-plugin-updater`, single toolchain replaces Sparkle / MSIX / AppImage triple); CI release pipeline pending — paired with sub-task 8 |
| 7 | Docker → native migration wizard | [`native-migration-spike.md`](native-migration-spike.md) | ✅ [#205](https://github.com/Dewinator/mycelium/pull/205) Docker → PGlite migration helpers (pure-TS core) · ⏳ first-run wizard UI follow-up |
| 8 | CI matrix (build + sign) | [`native-ci-release-spike.md`](native-ci-release-spike.md) | ⏳ spike landed (single GitHub Release per tag, 3 platform artifacts signed/notarized); implementation pending |
| 9 | Update banner refit | [`native-update-banner-spike.md`](native-update-banner-spike.md) | ⏳ spike landed (detect `__TAURI_INTERNALS__`, switch between native-update button and browser fallback); refit of `dashboard/index.html` 7315–7480 + `scripts/dashboard-server.mjs` 2148–2252 pending |
| 10 | Docs refresh | [`native-docs-refresh-spike.md`](native-docs-refresh-spike.md) | ⏳ gated on at least one signed installer per platform existing |

### `DbClient` sub-story (sub-task 3 follow-up)

The Tauri shell + sidecar bundling lands a working `.app`, but every service
that constructs a Supabase client directly still hard-codes the Docker
backend. PR [#209](https://github.com/Dewinator/mycelium/pull/209) ships a
`DbClient` factory (`PostgrestClient | PGliteAdapter`, switched by
`MYCELIUM_USE_PGLITE=1`) so each service can be migrated in its own atomic
PR. **Stand 2026-05-04 (`main` commit `a1fb5de`):** 22 services in
`mcp-server/src/services/` still touch Supabase directly; 2 of them
(`SwarmPinService`, `SkillsService`) are migrated in the open stack
[#210](https://github.com/Dewinator/mycelium/pull/210) → [#211](https://github.com/Dewinator/mycelium/pull/211). After this stack lands,
**20 services remain** — pattern stays "one service per PR, atomic, reviewable".

## Open PR queue (5 deep, all `CLEAN`+`MERGEABLE`)

Recommended merge order — the stack ordering is forced (each stacked PR
auto-retargets to `main` once its base merges); the standalone PRs are
independent and can merge in either order.

1. **[#212](https://github.com/Dewinator/mycelium/pull/212)** — W4.1 row 4 echo-chamber cohort (off-track from native-app, but in queue; independent; CI green).
2. **[#208](https://github.com/Dewinator/mycelium/pull/208)** — sidecar bundling pipeline (first `.app` builds clean; sub-task 3 ticket A; independent of the DbClient stack; bundle script empirically validated against `main` in tick 183).
3. **[#209](https://github.com/Dewinator/mycelium/pull/209)** — `DbClient` factory (root of the migration stack; foundational atomic; CI green).
4. **[#210](https://github.com/Dewinator/mycelium/pull/210)** — `SwarmPinService` → `DbClient` (stacked on #209; auto-retargets to `main` on #209 merge; CI green).
5. **[#211](https://github.com/Dewinator/mycelium/pull/211)** — `SkillsService` → `DbClient` (stacked on #210; auto-retargets to #209's base on #210 merge; CI green).

The 9-PR merge train that this section documented in tick 103 (2026-05-02)
is fully merged — see git log `09024a2..` for the actual order.

## Post-stack implementation gate

After the open stack drains, the next-tick targets fall into two parallel
tracks:

- **`DbClient` migration of the remaining 20 services** — atomic per-service
  PRs, queue-cap permitting. Each is a small mechanical refactor whose risk
  is contained to one file. This is the long tail of sub-task 3 follow-up.
- **Sub-tasks 6 + 8 + 9** form the release/update pipeline triangle. The
  three spike docs already align on `tauri-plugin-updater` and the
  GitHub-Release-as-truth model from [#207](https://github.com/Dewinator/mycelium/pull/207) is live, so they can land in
  any order once the queue is empty.

**Sub-task 10 (docs refresh)** stays gated on at least one signed installer
per platform existing.

When the queue is full (≥5 PRs open), the highest-value tick action is
*making the merge cheaper* — validating the order, posting consolidated
status, refreshing this doc — not adding more diffs to the queue.

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
