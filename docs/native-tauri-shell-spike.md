# Tauri-shell spike — sub-task 3 of #176

> Status: **design spike (no empirical install yet — Tauri toolchain not on this machine)**
> Issue: sub-task 3 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Sources verified against [Tauri 2 sidecar docs](https://v2.tauri.app/develop/sidecar/) and [updater plugin docs](https://v2.tauri.app/plugin/updater/) (fetched 2026-05-02).

## Question this spike answers

Sub-task 3 of #176 says the Tauri shell must "manage PG + MCP-server subprocesses, native window, tray icon, auto-start". Before any code lands, six load-bearing decisions need a written-down recommendation so the implementation tick is execution, not exploration:

1. **Process model** — how many subprocesses does Tauri actually own?
2. **IPC pattern** — Tauri commands vs. localhost HTTP for the dashboard webview?
3. **Lifecycle ownership** — who starts/stops what, and in what order on quit?
4. **Window UX** — main window, tray-only, or both?
5. **Auto-update** — Sparkle/MSIX/AppImage-update (per epic) or Tauri's built-in updater?
6. **OS data dir** — Tauri's `BaseDirectory` enum vs. mcp-server's existing path logic?

## TL;DR

- **One sidecar, not two.** Tauri spawns the **single Node MCP-server binary**. PGlite (#185) and llama.cpp (#187) are in-process inside Node — Tauri does not need to know they exist. The original epic table listed PG + MCP as two managed subprocesses; PGlite collapsed that to one.
- **Keep HTTP to localhost.** The dashboard already speaks HTTP to the mcp-server. Tauri's webview points at `http://127.0.0.1:8787` and nothing in the dashboard code changes. Tauri-commands stay reserved for **lifecycle-only** primitives the webview cannot do via HTTP (open data dir in Finder, "check for updates").
- **Tauri owns Node; Node owns everything else.** Quit flow: Tauri sends SIGTERM to the Node sidecar → Node's existing shutdown hooks flush PGlite (already in-process, no extra IPC) and llama.cpp.
- **Window AND tray.** Window IS the dashboard webview (chrome-less, native title bar). Tray controls "Show / hide window", "Open data dir", "Check for updates", "Quit". Auto-start optional, off by default.
- **Use Tauri's built-in updater, not Sparkle.** The epic's "Sparkle (macOS) / MSIX (Win) / AppImage-update (Linux)" matrix is three different toolchains. Tauri 2's updater plugin handles all three from a single config and a static `latest.json` on GitHub Releases. **Deviates from the epic table** (`Sparkle/MSIX/AppImage-update` row) — flagged as the load-bearing pragmatic call.
- **Use Tauri's `BaseDirectory::AppLocalData`.** Maps to `~/Library/Application Support/mycelium/` (macOS), `%APPDATA%\mycelium\` (Win), `~/.local/share/mycelium/` (Linux) — exactly what the epic specifies. mcp-server reads `MYCELIUM_DATA_DIR` env passed in by Tauri at sidecar spawn, so the Node code stays platform-agnostic.

## Recommended architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Tauri shell (Rust)                                              │
│                                                                 │
│   ┌─ tray icon ────────┐    ┌─ main window (webview) ────┐     │
│   │ Show / Hide        │    │ ▸ src = http://127.0.0.1:  │     │
│   │ Open data dir      │    │   8787  (existing dashboard│     │
│   │ Check for updates  │    │   index.html, untouched)   │     │
│   │ Quit               │    └────────────────────────────┘     │
│   └────────────────────┘                                        │
│                                                                 │
│   tauri-plugin-shell ──► Command.sidecar("mycelium-mcp")        │
│                            │                                    │
└────────────────────────────┼────────────────────────────────────┘
                             ▼
                ┌──────────────────────────────────────────┐
                │ Node sidecar (single binary, pkg/Bun)    │
                │                                          │
                │   mcp-server (existing index.ts)         │
                │     ├─ PGlite (in-process, npm dep)      │
                │     ├─ node-llama-cpp (in-process)       │
                │     ├─ HTTP :8787  (dashboard + REST)    │
                │     └─ stdio MCP   (when LLM client      │
                │                     spawns it directly)  │
                └──────────────────────────────────────────┘
```

## The six decisions, with sources

### 1. Process model: one sidecar

Tauri 2's `externalBin` config registers a binary with a platform suffix:

```json
// tauri.conf.json
{
  "bundle": {
    "externalBin": ["binaries/mycelium-mcp"]
  }
}
```

Tauri then expects `binaries/mycelium-mcp-aarch64-apple-darwin`, `binaries/mycelium-mcp-x86_64-pc-windows-msvc.exe`, `binaries/mycelium-mcp-x86_64-unknown-linux-gnu`. Source: [Tauri sidecar docs § Configuration](https://v2.tauri.app/develop/sidecar/).

Spawn from Rust on app startup:

```rust
use tauri_plugin_shell::ShellExt;
let sidecar = app.shell().sidecar("mycelium-mcp")?;
let (mut rx, mut child) = sidecar
    .env("MYCELIUM_DATA_DIR", app_local_data_dir.to_str().unwrap())
    .spawn()?;
```

Verbatim from the same source. The `child` handle is what we call `child.kill()` on during quit.

### 2. IPC pattern: localhost HTTP, Tauri commands only for what HTTP can't do

The dashboard (`dashboard/index.html`) already fetches against `mcp-server`'s HTTP port. Pointing Tauri's webview at `http://127.0.0.1:8787` makes the existing dashboard work zero-rewrite.

Tauri commands (Rust ↔ webview) stay reserved for primitives **outside** the HTTP boundary:

| Tauri command | Why HTTP can't do it |
|---|---|
| `open_data_dir()` | webview can't shell out to `open` / `explorer.exe` / `xdg-open` |
| `check_for_updates()` | webview can't trigger Tauri's updater plugin |
| `restart_app()` | only Tauri can graceful-restart the sidecar + Tauri itself |
| `get_app_version()` | already known to Tauri, avoids a /version endpoint |

Three to five Tauri commands total. Everything else stays HTTP. This keeps the dashboard usable from a regular browser too (sovereignty: power-users still get the webapp at `localhost:8787` without the Tauri shell).

### 3. Lifecycle: Tauri owns Node, Node owns the rest

Boot order:
1. Tauri starts.
2. Tauri creates `MYCELIUM_DATA_DIR` (BaseDirectory::AppLocalData/mycelium/) if absent.
3. Tauri spawns the Node sidecar with `MYCELIUM_DATA_DIR` in env.
4. Node sidecar starts, opens PGlite at `${MYCELIUM_DATA_DIR}/pgdata/`, loads llama.cpp model from `${MYCELIUM_DATA_DIR}/models/`, listens on 8787.
5. Tauri webview navigates to `http://127.0.0.1:8787` once the sidecar logs "ready" on stdout.

Quit order (every quit path: tray → Quit, window close, OS shutdown):
1. Tauri's `on_window_event` and tray-handler converge into a single `app_handle.exit()` call.
2. Tauri sends SIGTERM to the sidecar `child`, awaits up to 5 s.
3. Node's existing process-exit hooks close PGlite (writes WAL), drop the llama.cpp context.
4. Tauri exits.

If the sidecar doesn't ack within 5 s, SIGKILL. PGlite's WAL is crash-safe (this is the same property that makes the Docker-Compose stop sequence safe today).

### 4. Window UX: window AND tray, no Auto-start by default

- **Main window**: chrome-less Tauri window (`decorations: true` for native title bar; size 1280×860 default; remembered across launches via Tauri's `window-state` plugin).
- **Tray icon**: always-present. Menu items in this order: *Show / Hide dashboard*, *Open data dir*, *Check for updates*, *Quit*. Click on the tray-icon body itself = toggle window visibility (matches Slack / Linear / 1Password).
- **Auto-start at login**: optional, **off by default**. User opt-in from a "Settings → Run at login" toggle. We use `tauri-plugin-autostart`; the toggle persists to OS-native LaunchAgent / Task Scheduler / `.desktop autostart`.

Closing the main window does NOT quit the app — it minimizes to tray (matches every modern menu-bar/tray app). Quit only via tray menu, OS quit shortcut, or `Cmd-Q`.

### 5. Auto-update: Tauri's built-in updater (deviates from epic)

The epic's table proposes Sparkle (macOS) / MSIX (Win) / AppImage-update (Linux) — three different update toolchains. **Recommendation: replace all three with Tauri 2's `tauri-plugin-updater`.** A single static `latest.json` on GitHub Releases serves all three platforms:

```json
{
  "version": "0.2.0",
  "notes": "REM-self-audit, swarm contradicts dashboard, llama.cpp default",
  "pub_date": "2026-05-09T18:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<sig>", "url": "https://.../mycelium-0.2.0-aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<sig>", "url": "https://.../mycelium-0.2.0-x86_64.app.tar.gz"  },
    "windows-x86_64": { "signature": "<sig>", "url": "https://.../mycelium-0.2.0-x64-setup.nsis.zip" },
    "linux-x86_64":   { "signature": "<sig>", "url": "https://.../mycelium-0.2.0-x86_64.AppImage.tar.gz" }
  }
}
```

Source: [Tauri updater docs § Static JSON](https://v2.tauri.app/plugin/updater/).

**Signing is mandatory** (cannot be disabled). One keypair generated via `tauri signer generate -w ~/.tauri/mycelium.key` — public key embedded in `tauri.conf.json` (`pubkey`), private key kept off-repo (CI secret). This is the same Pillar-6 hygiene as PRs #188 / #189 (GGUF SHA-256 verification) — no unsigned binaries reach a user.

Why this is better than the epic table:
- One signing keypair instead of three (Sparkle: DSA, MSIX: Authenticode, AppImage: GPG).
- One `latest.json` replaces a Sparkle XML feed + MSIX update server + AppImage zsync.
- One Rust crate dependency (`tauri-plugin-updater`) replaces three release-pipeline integrations.

The macOS `Sparkle` integration the epic mentions is still **possible** later if Reed wants the macOS-native update-checker UX (banner that says "A new version of mycelium is available"), but it's a v2 polish, not an MVP requirement.

### 6. Data dir: Tauri's BaseDirectory::AppLocalData

The epic's per-OS paths (`~/Library/Application Support/mycelium/`, `%APPDATA%\mycelium\`, `~/.local/share/mycelium/`) are exactly what `BaseDirectory::AppLocalData` resolves to on the three platforms. Tauri reads the app identifier from `tauri.conf.json` (`identifier: "io.mycelium.app"` proposed) and concatenates.

The mcp-server side does NOT learn any platform-specific path logic. It receives `MYCELIUM_DATA_DIR` as an env var at sidecar spawn (see decision 3). Sub-task 7's migration wizard (already speced in `docs/native-migration-spike.md`) writes into the same dir.

## Wave-3 forward-compatibility — preserve, don't implement

Sub-task 3 ships **before** Wave 3 (P2P discovery, see [`swarm-discovery-spike.md`](swarm-discovery-spike.md)). The implementer should make four small choices that cost nothing now but keep Wave 3 unblocked. Skipping them means a future tick has to retrofit Tauri capability config, which is a release-build change, not a code change.

| Wave-3 need | What sub-task 3 should do | What sub-task 3 must NOT do |
|---|---|---|
| **mDNS responder/browser** in the Node sidecar (`bonjour-service`, UDP multicast on 224.0.0.251:5353) | Tauri 2 capability config: allow the sidecar process to bind UDP and accept inbound from the LAN. Document this in `app/src-tauri/capabilities/default.json` even if the dependency isn't pulled in yet. | Don't sandbox the sidecar with an outbound-only network capability. Reverting that later would require re-signing/re-notarizing, not just a sidecar rebuild. |
| **Wire HTTPS listener** at a separate port from the dashboard HTTP | Spawn the sidecar with TWO env vars: `MYCELIUM_DASHBOARD_PORT=8787` (HTTP, localhost-only) and `MYCELIUM_WIRE_PORT=8443` (HTTPS, all interfaces — actual binding decided by sidecar at runtime). The dashboard webview keeps using `http://127.0.0.1:8787`; the wire port stays unused until Wave 2/3 needs it. | Don't assume a single port serves both surfaces. The wire endpoint MUST NOT be reachable from a regular browser tab — separating ports is the simplest enforcement. |
| **Network-change / wake hooks** to re-announce mDNS after sleep or interface flip | Pass through Tauri's `RunEvent::Resumed` and macOS `NWPathMonitor` / Win `NetworkChange` / Linux `NetworkManager` D-Bus signals to the sidecar via either a Tauri command (`notify_network_change`) or a stdout sentinel. Wire only one or two minimal hooks; bonjour-service consumes them in Wave 3. | Don't write the bonjour-service integration itself. That's Wave 3 work. Just make the *signal* available. |
| **Self-signed cert provisioning at first launch** for the wire HTTPS port | Add a `MYCELIUM_DATA_DIR/wire-cert/` directory creation step to the boot sequence (decision 3, step 2). Leave it empty for now. | Don't generate the cert in sub-task 3 — that's a Wave-2/3 ticket. Just reserve the path so the migration wizard (sub-task 7) doesn't have to special-case it later. |

Net cost to sub-task 3: ~10 lines of `tauri.conf.json` capability spec + one extra env var + one directory `mkdir`. Net Wave-3 benefit: the only Wave-3 work that touches the *Rust* side disappears — Wave 3 becomes pure Node/sidecar code.

This is the "design substrate" the discovery spike asked for at line 22 of `swarm-discovery-spike.md`: *"v1.x design decisions still in flight (Tauri shell, sidecar lifecycle, native net permissions) can keep Wave 3's needs in view instead of having to be retrofitted."*

## What this spike does NOT answer

Honest list of unknowns that need empirical work in the implementation tick(s):

- **Sidecar binary size on disk.** A pkg/Bun-compiled Node + node-llama-cpp + PGlite binary will be ~80–150 MB before model files. Acceptable for the macOS .dmg target; needs measurement.
- **First-launch model download UX.** llama.cpp models (~2-4 GB for qwen3:8b GGUF) cannot reasonably ship inside the installer. Tauri progress events wired to the dashboard via a new HTTP endpoint or via Tauri's event bus — design decision deferred to the implementation tick.
- **Code signing on macOS / Windows.** Apple Developer ID + Windows Authenticode certs are paid out-of-band. Tauri's CLI handles the actual signing call (`tauri build --target universal-apple-darwin`); the cert acquisition is Reed's call.
- **Linux distribution form.** AppImage is the universal default; .deb / .rpm / Flatpak are nice-to-haves. Recommend AppImage-only for MVP.
- **Window-state persistence behaviour with multi-monitor setups.** `tauri-plugin-window-state` covers most cases but the edge case "monitor disconnected between launches" is platform-specific.

These do not block the design. They block **shipping**, which is sub-tasks 5, 6, 8 of #176 — separate tickets when this one lands.

## Suggested follow-up issues (in dependency order)

Once this spec is on main, the implementation can be split into 3-4 small tickets that each fit one tick:

1. `feat(app): scaffold Tauri 2 shell — main window, tray, sidecar registration` — adds `app/` Tauri project, registers `mycelium-mcp` as `externalBin`, no production deps changed.
2. `feat(app): MYCELIUM_DATA_DIR honoured by mcp-server boot` — small mcp-server PR; reads env, creates dir, writes PGlite + models there. Independent of Tauri; testable headlessly.
3. `feat(app): Tauri commands open_data_dir / check_for_updates / restart_app` — three small Rust commands, three frontend bindings, three menu items.
4. `feat(install): tauri-plugin-updater wired to GitHub Releases latest.json` — full updater integration including signing key handling. Largest of the four.

Sub-task 7's "migrate from Docker install" wizard (already speced separately) becomes ticket 5 in this chain — needs (1) and (2) on main first.

## Pillar check

- **Pillar 1 (no cloud)**: strengthened — `localhost:8787` HTTP boundary stays inside the local machine; updater hits a public URL only on user-triggered "Check for updates", never silently in v1.
- **Pillar 6 (security)**: data dir on OS-native local storage; mandatory signature verification on every update; same fail-closed posture as PRs #188 / #189.
- No pillar weakened. The deviation from the epic's per-platform updater toolchains is a simplification, not a sovereignty trade-off — Tauri's signed-update channel is identical in security guarantees, fewer moving parts.

## What I am NOT doing this tick

Per the pinned hard rule (PR queue full + waiting on Reed): **no new PR opened**. This spec lands direct-to-main as docs only (zero risk, same pattern as `docs/native-migration-spike.md` did in commit `4491fcf`). Implementation tickets above are intentionally not filed yet — the proposed-by-agent queue is at the 3-cap, and sub-task 1 above depends on PR #185 (the PGlite adapter) landing first anyway.
