# Update-banner refit spike — sub-task 9 of #176

> Status: **design spike (no code changes yet — Tauri shell from sub-task 3 must scaffold first)**
> Issue: sub-task 9 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Builds on `docs/native-tauri-shell-spike.md` (Tauri-updater pivot, single signing keypair) and `docs/native-ci-release-spike.md` (`latest.json` lives at `https://github.com/Dewinator/mycelium/releases/latest/download/latest.json`, two channels via two manifests).
> Sources verified against the live update-banner code (`dashboard/index.html` lines 7320–7467 — `checkForUpdate()` body, and `scripts/dashboard-server.mjs` lines 2150–2254 — `/update-status` handler block; re-verified 2026-05-05) and [Tauri 2 updater docs](https://v2.tauri.app/plugin/updater/) (fetched 2026-05-02).

## Question this spike answers

The epic's sub-task 9 says the existing banner "currently shows the git-pull command — for the native app it should trigger Sparkle's *Check for Updates*". With the Tauri-updater pivot from spike 3 the wording changes to "Tauri's *Check for Updates*", but the underlying refit is the same. Five load-bearing decisions need a written-down recommendation before the implementation tick:

1. **Mode detection** — how does the dashboard webview know it is running inside Tauri vs. a plain browser, and what is the fallback when detection fails?
2. **`/update-status` endpoint contract** — does its JSON shape change for the native app, or do we keep it stable and layer the action client-side?
3. **Action UI** — what replaces the "double-click `update.command`" + "SSH" howto when the user is inside the Tauri shell?
4. **Where does the version check happen** — server-side `git rev-parse` against GitHub (today), Tauri-updater hitting `latest.json` (native), or both in parallel?
5. **Channel surface** — sub-task 8 ships two manifests (`latest.json` stable, `latest-beta.json` beta). Does the banner expose channel selection, and where does the choice live?

## TL;DR

- **Detect Tauri via `window.__TAURI_INTERNALS__`** (the v2 sentinel; survives webview reloads, no UA-sniffing). Browser-mode is the fallback whenever the sentinel is absent — every NAS/VPS/Tailnet user keeps the existing flow unchanged.
- **`/update-status` keeps its current shape** plus one new optional field `update_mode: "git" | "native"` set server-side. Server picks `native` when `MYCELIUM_DATA_DIR` is set (= started by Tauri sidecar) AND a marker file `INSTALL_KIND=native` exists in the data dir. The marker is written by the Tauri shell's first-run wizard. No new endpoint.
- **Three banner variants share one DOM, one CSS, one i18n bundle.** The existing browser variant (local + remote/SSH) stays. The native variant **replaces** the howto block with a single primary action: `[ Install update ]`. The behind-by-N count, latest-commit message, and dismiss button are reused unchanged.
- **In native mode the dashboard does NOT call `/update-status`.** Tauri-updater's `check()` API replaces the GitHub-compare round-trip — it already understands `latest.json`, signature verification, channel selection, and progress events. The browser-side flow only fires when the sentinel is absent.
- **Channel selection lives in the tray menu, not the banner.** Switching channels is a power-user act and should not race with the "your update is ready" UX. The banner shows whichever channel is currently active (`Stable` / `Beta` chip next to the title) so the user knows what they are about to install.

## Recommended architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ dashboard/index.html  (one file, two boot paths)                       │
│                                                                        │
│   if (window.__TAURI_INTERNALS__) {                                    │
│       // NATIVE MODE                                                   │
│       const { check } = await import("@tauri-apps/plugin-updater");    │
│       const update = await check();                                    │
│       if (update?.available) renderNativeBanner(update);               │
│   } else {                                                             │
│       // BROWSER MODE — unchanged flow                                  │
│       const r = await fetch("/update-status");                         │
│       const data = await r.json();                                     │
│       if (data.behind_by > 0) renderBrowserBanner(data);               │
│   }                                                                    │
└────────────────────────────────────────────────────────────────────────┘
                              │ (native only)
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tauri shell                                                            │
│   tauri-plugin-updater  ──►  GET https://github.com/Dewinator/         │
│                              mycelium/releases/latest/download/        │
│                              latest.json                               │
│                                                                        │
│   On user click "Install update":                                      │
│     update.downloadAndInstall((event) => …progress events…)            │
│       ├─ verifies tauri-updater minisign signature                     │
│       ├─ verifies macOS notarisation / Windows Authenticode            │
│       ├─ swaps the bundle                                              │
│       └─ relaunches via app.restart()                                  │
└────────────────────────────────────────────────────────────────────────┘
```

## Detail — the five decisions

### 1. Mode detection

**Recommendation: feature-detect `window.__TAURI_INTERNALS__`.**

- This is Tauri v2's documented sentinel object, injected before the webview's first script runs. Always present in a Tauri webview, never present in a regular browser.
- No UA-string sniffing — UA is user-controllable and lies frequently (privacy extensions, Tailscale Funnel, embedded webviews).
- No reliance on the URL — the dashboard URL is `http://127.0.0.1:8787` in *both* modes (Tauri's webview points at the same local mcp-server). URL-based detection would misfire when the Tauri user opens the dashboard in their regular browser too.
- Fallback contract: when in doubt, assume browser. Browser-mode is safe (read-only GitHub compare); native-mode would offer to install over the user's actual binary, which we want to surface only on confirmed-Tauri.

```js
const isNative = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
```

### 2. `/update-status` endpoint contract

**Recommendation: extend the existing JSON, do not branch the URL.**

Today's payload (`scripts/dashboard-server.mjs:2196-2211`):

```json
{
  "ok": true,
  "local_sha": "…", "local_short": "…",
  "remote_sha": "…", "remote_short": "…",
  "behind_by": 4,
  "latest_message": "…", "latest_at": "…",
  "repo_path": "/home/reed/mycelium",
  "hostname": "mycelium-nas", "username": "reed",
  "last_check": "2026-05-02T20:55:00Z"
}
```

Add **two** optional fields:

| Field | Type | Meaning | Why now |
|---|---|---|---|
| `install_kind` | `"git" \| "native"` | What kind of install the server is running on | Lets the browser-mode banner *also* honour the native path when a Tauri user opens the dashboard in their regular browser — instead of telling them to `bash scripts/update.sh` (which doesn't exist), it tells them "Open mycelium and click Install update". |
| `channel` | `"stable" \| "beta"` | Which release channel this install tracks | Surfaces in the chip on both banner variants. Server reads from `~/Library/Application Support/mycelium/CHANNEL` (default `stable`). |

Detection logic on the server:

```js
const dataDir = process.env.MYCELIUM_DATA_DIR;
const installKind = (dataDir && existsSync(join(dataDir, "INSTALL_KIND_NATIVE")))
  ? "native"
  : "git";
```

The marker file is written **once** by the Tauri shell's first-run wizard (sub-task 7's migration story creates it on Docker → native imports too). No file → assume git checkout, current behaviour preserved.

### 3. Action UI — what the user sees

Three variants share the same DOM skeleton. Only the `.ub-howto` block swaps.

#### Variant A — git checkout, local browser (today, unchanged)
```
┌ ⬆ Update verfügbar  ··· behind 4 commits ··· "fix(dashboard): clipboard copy"
│
│ So aktualisierst du:
│   ① am einfachsten   Doppelklick auf update.command im mycelium-Ordner.
│   ② Terminal         cd ~/mycelium && bash scripts/update.sh   [kopieren]
└──────────────────────────────────────────────────────────────  ×
```

#### Variant B — git checkout, remote browser (Tailnet/NAS, unchanged)
```
┌ ⬆ Update verfügbar  ··· behind 4 commits ··· "fix(dashboard): clipboard copy"
│
│ Du bist via Browser auf mycelium-nas verbunden — die Aktualisierung läuft dort.
│ So aktualisierst du:
│   ② Terminal · mycelium-nas   ssh reed@mycelium-nas '…'   [kopieren]
└──────────────────────────────────────────────────────────────  ×
```

#### Variant C — native install (NEW)
```
┌ ⬆ Update verfügbar  · stable channel ·  v0.5.0 → v0.5.4 ·  "Pillar 6 hardening"
│
│   [ Install update ]   Verifiziert · ~12 MB · neustart erforderlich
│                        ──────────  ▰▰▰▰▱▱▱▱▱  43 % heruntergeladen
│
│   Was ändert sich?  ▾ release notes
└──────────────────────────────────────────────────────────────  ×
```

The native variant deliberately drops the howto list — there is exactly one path forward, click the button. Progress is in-place (no modal), a `details/summary` widget reveals the GitHub-Releases body for users who want to read before clicking.

When **Variant C is shown in a remote browser** (a Tauri user happens to be on their phone) the button gets a tooltip "Öffne mycelium auf <hostname> um zu aktualisieren" and is non-clickable. Clicking falls through to `tauri://localhost` deep-link if the OS knows the protocol, otherwise no-op.

### 4. Where the version check happens

**Recommendation: Tauri-updater in native mode, `/update-status` in browser mode, never both at the same time.**

Reasons:
- **Tauri-updater is the source of truth for "is this binary outdated?"** It compares the running app's `version` (from `tauri.conf.json`) against `latest.json`'s `version` field. The git-sha comparison in `/update-status` is meaningless for a native install — the user's binary may have been built from any sha, and the relationship between "binary version" and "git sha" is many-to-one.
- **Running both in parallel** would race: GitHub-compare might say "behind by 3" while Tauri-updater says "no update" (because no release has been cut yet for those 3 commits). Confusing.
- **Tauri-updater handles signature verification and channel routing** automatically. Re-implementing that browser-side would duplicate Pillar-6 surface area.
- **Browser-mode (git checkout) cannot use Tauri-updater** — there's no Tauri shell to call. The `/update-status` flow stays as-is.

The `install_kind` field added in §2 is what lets the dashboard make this choice once, on boot, and stick with it.

### 5. Channel surface

**Recommendation: channel selector lives in the tray menu, the banner *displays* the active channel as a chip.**

| Where | Element | Behaviour |
|---|---|---|
| Tray menu | `Channel ▸ • Stable / Beta` (radio) | Switches the channel file on disk, restarts the updater plugin (no app restart needed). |
| Banner title | `· stable channel ·` chip | Read-only display next to the version diff. Beta chip is amber, stable is neutral. |
| Settings UI (later) | Same as tray | Mirrors the tray choice. Settings UI is post-MVP. |

Why **not** in the banner: the banner is a "you have an update right now" surface. Channel selection is "what kinds of updates do you want to see?" — a different question, asked once, then forgotten. Mixing them risks a user accidentally switching channels while trying to install.

## What this spike does NOT answer

- **Visual design of progress states** — covered by `docs/dashboard-design-spec.md` once the implementation ticket is filed.
- **i18n strings for Variant C** — straightforward, lands with the implementation PR.
- **What happens on first-run when `latest.json` 404s** — Tauri-updater silently treats that as "no update available", banner stays hidden. No error UX needed; the dashboard already handles `/update-status` 5xx as "skip the banner".
- **Beta-channel opt-in flow** — orthogonal feature, separate ticket. The spike just reserves the channel chip.
- **Auto-install vs. confirm-first** — this spike specifies confirm-first (user clicks). Background download + "ready to install on next launch" is a v2 nice-to-have, not MVP.
- **Rollback UX** — out of scope for the banner. Tauri-updater has no built-in rollback; the recovery path is "download an older release manually". Documented in spike 8 (CI release pipeline).

## Implementation sketch — single-tick PR

When sub-task 3 (Tauri shell scaffold) lands, the implementation ticket is small:

1. `scripts/dashboard-server.mjs` — add `install_kind` + `channel` to the `/update-status` payload (~15 LOC + 1 unit test).
2. `dashboard/index.html` — gate the existing `checkForUpdate()` on `!isNative`, add a parallel `checkForUpdateNative()` that uses `@tauri-apps/plugin-updater` (~80 LOC including the new Variant C DOM template, no new files).
3. `dashboard/i18n/{de,en}.json` — add `update.native.*` keys for the Variant C strings (~12 keys).
4. Tauri shell — add `INSTALL_KIND_NATIVE` marker write to first-run wizard (~5 LOC of Rust).
5. Tray menu wiring for the channel selector — separate sub-task (paired with the channel-flip Tauri command), explicitly NOT in scope for sub-task 9.

Total: ~120 LOC across two files plus a marker, lands as one focused PR after the Tauri shell is on main.

## Pillar check

- **Pillar 1 (no cloud dependency)**: unchanged — both flows hit GitHub directly, no third-party update service.
- **Pillar 6 (security)**: native-mode flow strictly stronger than browser-mode — Tauri-updater verifies a minisign signature on the bundle plus the OS-level code signature (Apple notarisation / Windows Authenticode). Browser-mode (`bash scripts/update.sh`) has no signature verification today.
- **Pillar 7 (legibility)**: banner stays a single, predictable surface; the chip and version diff are added information, not added complexity.
- No pillar weakened.

## Why direct-to-main and not a PR

Per the pinned PR-queue-full rule: when the open-PR queue is already full
and waiting on Reed, design-spike docs land direct-to-main rather than as
queue churn. (Spike originally written 2026-05-02 with 9 PRs in flight;
re-verified 2026-05-05 with 5 PRs in flight — rule applies the same way.)
Same pattern as commits `4491fcf`, `f54a7cd`, `fc0108b`, `38b6e0b` —
design spikes for sub-tasks 3, 5, 7, 8 of #176.

🤖 verified by Claude on a self-tick (2026-05-02; line refs
re-verified 2026-05-05 against `main` after #202–#207 merged — banner
JS is at lines 7320–7467 and `/update-status` handler at 2150–2254;
spike's recommendations remain implementable as a single ~120 LOC PR
once sub-task 3 closes via #208 + DbClient stack)
