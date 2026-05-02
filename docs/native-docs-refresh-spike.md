# Docs refresh spike — sub-task 10 of #176

> Status: **design spike (no doc changes yet — flip happens once the first signed installer ships from sub-task 8)**
> Issue: sub-task 10 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Builds on `docs/native-tauri-shell-spike.md` (first-run wizard, tray icon, single signed bundle), `docs/native-ci-release-spike.md` (`latest.json` + four-platform installer matrix), `docs/native-update-banner-spike.md` (in-app updater path), `docs/native-update-ops-spike.md` (channels, downgrade, cert rotation), `docs/native-migration-spike.md` (Docker → PGlite import wizard), and `docs/native-pg-platforms-spike.md` (one WASM, three install paths).
> Sources verified against the live `README.md` (443 lines), `README.de.md` (427 lines), `docs/setup.md` (290 lines) and `SETUP_ANLEITUNG.md` (438 lines) on `main` 2026-05-02.

## Question this spike answers

The epic's sub-task 10 says: *"README + setup.md replace Docker instructions with download links + first-run wizard screenshots."* That sentence hides at least seven decisions that need to be written down before any tick edits docs:

1. **Switch or coexist?** — does the docs flip cut over the moment the native build is downloadable, or do Docker docs stay as a documented fallback for power users / NAS / Tailnet operators?
2. **One README per path or one README that branches?** — split `README.md` (native users) and `README-developer.md` (Docker users), or keep one README with two clearly-marked install paths?
3. **Where does the install-path decision live in the user journey?** — top of README, separate landing doc, or inferred from "are you a developer" framing?
4. **i18n — what is the source of truth?** — today `README.md` (EN) and `README.de.md` (DE) are kept in lockstep manually. Same for `docs/setup.md` (DE) and `SETUP_ANLEITUNG.md` (DE more verbose). Does the doc-flip respect the existing structure or restructure first?
5. **Setup snippets** — `docs/setup.md` is 95% path-agnostic (it tells the agent how to register mycelium as an MCP server, regardless of how mycelium itself was installed). Does the native install change anything here, or is the only delta the path placeholder?
6. **Screenshots — what set is required, who captures, where do they live?** — first-run wizard, tray icon, settings panel, in-app updater banner. Same on macOS / Windows / Linux, or one canonical platform per shot?
7. **When does the flip ship?** — gated on the first signed installer being downloadable (sub-task 8 release tag), or earlier on a docs-only PR with `[experimental]` markers?

## TL;DR

- **Coexist for v1, switch when "Docker path" usage drops below 10% of new installs.** Docker has a non-trivial power-user story (NAS, Tailnet, headless Linux box, custom Postgres tuning). Killing it the day v1.0 ships would lose the existing audience without payoff. The two paths share the same MCP server, the same migrations, the same dashboard — only the lifecycle layer differs. So both fit in one README under a top-level chooser, no fork.
- **One README, one branching question at the top.** A 6-line "Choose your install path" block with two cards (Native one-click vs. Docker self-hosted) replaces today's "Quickstart" section. Everything below the chooser stays single-source-of-truth (Architecture, MCP tools, Dashboard, Features, Project structure, Roadmap). The two install-specific sections live as `## Install — native (recommended)` and `## Install — Docker (advanced / headless)` and are the only place the paths diverge.
- **`docs/setup.md` is path-agnostic and stays that way.** The MCP-client config snippet (`{ "command": "node", "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"] }`) does not change for the native install — the Tauri shell exposes the same `dist/index.js` inside its app bundle and writes the resolved absolute path into the first-run wizard's "Copy MCP config" panel. The only doc delta is one paragraph explaining how to find `$MYCELIUM_PATH` per OS for both install paths (`/Applications/mycelium.app/Contents/Resources/...` vs `~/mycelium/`).
- **i18n: write English first, Deutsch follows in the same PR — never two PRs.** The existing structure is preserved (`README.md`/`README.de.md` siblings; `docs/setup.md`/`SETUP_ANLEITUNG.md` siblings). The flip-PR ships both languages atomically so the language flag in the README header is never lying.
- **Screenshots: 5 canonical shots, captured on macOS, mirrored only when the OS chrome materially differs.** First-run wizard step 1 (welcome), step 2 (data dir), step 3 (model download progress), tray menu, in-app updater banner. macOS is the canonical capture; Windows + Linux get their own shot only when the layout/affordance changes (e.g. tray-area on Windows is bottom-right, on KDE/GNOME it varies → one Linux shot). All shots live under `docs/images/native/` with a flat naming scheme: `01-wizard-welcome-mac.png`, `04-tray-mac.png`, `04-tray-windows.png`, `04-tray-linux-kde.png`.
- **Flip is gated on the signed-installer release tag (sub-task 8).** No `[experimental]` doc-PR before that — pointing users at a "download here" link that resolves to a 404 or an unsigned binary breaks Pillar 1 trust. The flip-PR sits in a draft branch (`docs/native-readme-refit`) until the first signed `v1.0-native` tag exists, then merges.

## Recommended structure

### README.md after the flip (top-down)

```
┌──────────────────────────────────────────────────────────────────────┐
│ <header logo, tagline, language switch>                              │
│                                                                      │
│ ## Choose your install path                                          │
│                                                                      │
│ ┌────────────────────────────┐  ┌────────────────────────────┐      │
│ │ Native app  (recommended)  │  │ Docker  (advanced/headless)│      │
│ │                            │  │                            │      │
│ │ Double-click installer     │  │ Self-host on a NAS,        │      │
│ │ Auto-updates, tray icon    │  │ VPS, or Linux box          │      │
│ │ macOS / Windows / Linux    │  │ Compose stack you control  │      │
│ │                            │  │                            │      │
│ │ → Install — native         │  │ → Install — Docker         │      │
│ └────────────────────────────┘  └────────────────────────────┘      │
│                                                                      │
│ <unchanged: The problem · Three scenarios · How it differs>          │
│ <unchanged: Architecture · Tech stack · MCP tools · Dashboard>       │
│ <unchanged: Features>                                                │
│                                                                      │
│ ## Install — native (recommended)                                    │
│   - Download links per OS (each pointing at the latest GH release)   │
│   - First-run wizard: 3 screenshots                                  │
│   - "Where is my data?" (OS-native paths)                            │
│   - "How do I update?" (in-app banner — see sub-task 9 spike)        │
│   - "Migrating from Docker?" → link to migration spike's user-doc    │
│                                                                      │
│ ## Install — Docker (advanced / headless)                            │
│   - Today's content, condensed: prerequisites, install.sh, manual    │
│   - "Why pick this path?" — Tailnet, NAS, custom PG tuning           │
│   - update.sh as the runtime pendant (unchanged)                     │
│                                                                      │
│ <unchanged: Project structure · Roadmap · License>                   │
└──────────────────────────────────────────────────────────────────────┘
```

### Files touched in the flip-PR

| File | Change | Risk |
|---|---|---|
| `README.md` | Replace `## Quickstart` with `## Choose your install path` + two `## Install —` sections. Keep all other sections untouched. | low — purely additive for native, condensing for Docker |
| `README.de.md` | Same structural change, German content. | low (mirror) |
| `docs/setup.md` | One new paragraph at top: "Where is `$MYCELIUM_PATH` for each install path?". No other change. | very low |
| `SETUP_ANLEITUNG.md` | Same one-paragraph addition (German). | very low |
| `docs/images/native/` (new dir) | Add 5–8 screenshots. | low (binary assets only) |
| `CLAUDE.md` | Update "Deployment-Modell" diagram + the Setup section to reference both install paths. | medium — CLAUDE.md is read by every tick; the diagram needs to stay accurate |
| `MANIFESTO.md` / `MANIFESTO.de.md` | Untouched. The why doesn't change. | none |
| `PROJECTS.md` | Untouched (project log, not user-facing). | none |
| `SYSTEM_OVERVIEW.md` | One sentence in the deployment section noting Path A is now the default; Docker stays as Path B. | low |

### Sections that explicitly do NOT change

- `## Architecture` — the diagram is install-path-agnostic (MCP client → mycelium server → Postgres). The fact that PG runs as a subprocess vs a container is below the abstraction level the diagram shows.
- `## Tech stack` — the table gains a row for "Lifecycle" (Tauri shell vs Docker compose) but every other row is identical (Postgres+pgvector, MCP server, dashboard, Ollama-or-llama.cpp). Keep the table; add the row.
- `## MCP tools` — zero change. Tools are the same regardless of how mycelium was installed.
- `## Dashboard` — zero change. Same port, same UI.
- `## Features` — zero change.
- `## Roadmap` — already has a "Native app" line; that line just gets a ✅ tick.

### `docs/setup.md` — the one paragraph

```markdown
> **Wo finde ich `$MYCELIUM_PATH`?**
>
> - **Native-App (Tauri)**: Der erste Start des Wizards zeigt dir den
>   absoluten Pfad und einen Copy-Button. Manuell:
>   - macOS: `/Applications/mycelium.app/Contents/Resources/`
>   - Windows: `%LOCALAPPDATA%\Programs\mycelium\resources\`
>   - Linux (AppImage): der entpackte AppImage-Mountpunkt — siehe
>     `~/.local/share/mycelium/install.json`
> - **Docker-Installation**: dein git-Checkout — z.B. `~/mycelium`.
>
> Beide Pfade enthalten `mcp-server/dist/index.js`. Das Snippet darunter
> verändert sich nicht.
```

The English equivalent goes into `README.md`'s setup section the same way.

## Migration story — what the doc-flip looks like in practice

### Phase 0 — pre-flip (today through sub-task 8 ship)

- Today's docs stay live untouched. Every user lands on the Docker path.
- Each design spike under `docs/native-*-spike.md` is a separate file — power users can read them but they are not linked from the README.

### Phase 1 — first signed installer ships (release tag `v1.0-native`)

- The flip-PR (drafted on `docs/native-readme-refit`) opens.
- It contains: the structural rewrite of `README.md` + `README.de.md`, the one-paragraph addition to setup docs, the 5–8 screenshots, and the CLAUDE.md/SYSTEM_OVERVIEW.md updates.
- Reed merges manually after eyeballing the rendered README.

### Phase 2 — soak window (~30 days post-flip)

- Both paths are live; download counts are watched.
- If Docker-path adoption (measured by `setup.sh` runs reporting in via the optional install-ping endpoint) is above 10% of new installs, **both paths stay**.
- If below, the next docs-PR collapses Docker into a single "Headless install (Docker)" subsection that stays linked but is not in the chooser cards anymore.

### Phase 3 — single-path (only if Phase 2 trips the threshold)

- The chooser disappears. README leads with native install. Docker docs move to `docs/install-docker.md` and stay maintained as a power-user reference.

This phasing matters because the swarm thesis (Pillar 3, anti-monoculture) says we don't break power-users to optimize the median UX. The Docker path is what NAS / Tailnet / VPS operators have today and they are exactly the kind of long-tail user mycelium is for.

## Screenshots — the canonical set

| # | Shot | Why | Captured on | Variants |
|---|---|---|---|---|
| 01 | First-run wizard — welcome screen | Sets expectations: "you'll choose a data dir, we'll download a model, you'll get a copy-paste config" | macOS | none (chrome-light) |
| 02 | First-run wizard — data dir picker | Surfaces the OS-native default path so the user knows where their memory lives (Pillar 1 trust signal) | macOS | Windows variant if path-picker chrome differs noticeably |
| 03 | First-run wizard — model download progress | Honest about the ~600 MB model pull, sets time expectation | macOS | none |
| 04 | Tray menu open | Shows: Open dashboard, Check for updates, Quit, Settings | macOS, Windows, Linux (KDE) — three shots because tray location/style differs |
| 05 | In-app updater banner inside the dashboard | Shows the native-mode "Install update" CTA from sub-task 9 spike | macOS | none |
| 06 (optional) | "Migrate from Docker" wizard | Only if the migration wizard from sub-task 7 ships in v1.0; otherwise defer to v1.1 docs | macOS | none |
| 07 (optional) | Settings panel — channel selector | Power-user surface; only shown if `MYCELIUM_BETA_CHANNEL=1` is documented in v1.0 | macOS | none |

**Rules for the capture set**:

- All shots use the actual default OS chrome (no custom themes, no zoomed-in DPI tricks).
- No real memory content visible — first-run wizard captures are inherently empty; tray/dashboard shots use the seeded demo data already in `docs/images/03-soul.svg`.
- File format: PNG, 2× DPI for retina, max 800 KB per shot (use `pngquant`).
- Naming: `NN-area-platform.png` — `01-wizard-welcome-mac.png`, `04-tray-mac.png`, `04-tray-windows.png`, `04-tray-linux-kde.png`.

The screenshots are the single biggest reason sub-task 10 cannot ship before sub-task 3 (Tauri shell) — the wizard and tray don't exist yet.

## What the doc-flip explicitly does NOT promise

- **No "we deprecated Docker" copy.** The Docker path is supported. Calling it deprecated would push existing power-users toward forking, which is exactly the failure mode Pillar 3 (sovereignty + diversity) warns against.
- **No "this works on iOS / Android" claims.** Out of scope per the epic.
- **No claim that the native app fully replaces Docker for headless servers.** A Tauri-shell tray app on a headless Linux box without a display server is a category error; the Docker path remains canonical for that deployment shape.
- **No download-counts or popularity claims in copy.** "Most users pick the native path" sounds like marketing; it also pins us to a metric we may or may not collect. Stay factual: "Native is the default install path. Docker is supported for self-hosting."

## Open questions (deferred — non-blocking for the spike)

1. **Should the chooser cards link to a `## Compare install paths` table** that lists trade-offs (auto-update? tray icon? headless? custom PG tuning?)? Probably yes — it pre-empts the "which one should I pick?" support question. Not in v1.0; revisit after the soak window.
2. **Single-binary distribution claim** — sub-task 1's spike concluded on PGlite (one WASM, three install paths). The README chooser card for "Native" should say "single signed installer per OS, no daemons" — but only after we verify the bundle does NOT spawn a separate Postgres daemon on disk (it doesn't with PGlite; it would with `embedded-postgres-binaries`). Word the copy after the spike-1 implementation merges (#185 + #194), not before.
3. **Should `CLAUDE.md` get the same chooser?** CLAUDE.md is read by ticks, not users — but it is also read by curious developers who land on the repo. Tentative answer: yes, mirror the structure but compress to two lines (developers prefer `git clone` workflow regardless of which install path users pick).
4. **i18n drift policy** — when EN and DE drift mid-flip (a tick edits EN, forgets DE), is that a CI failure or a labelable PR comment? Today it's neither. Flip-PR is the right moment to introduce a `docs-i18n-drift` label and a soft check (lines-changed-in-EN-but-not-DE warning). Not part of this spike, but worth filing as a follow-up issue.
5. **MANIFESTO.md vs README.md tonal split** — MANIFESTO is the "why", README is the "what + how". The flip-PR must not leak MANIFESTO-tier framing ("the model gets your time; you get nothing back") into README install sections. This is a writer-discipline thing, not a structural thing. Worth a one-line note in the flip-PR template.

## Pillar check

| Pillar | Effect |
|---|---|
| **Pillar 1 — no cloud dependency** | strengthened. The chooser leads with "Native, local, sovereign". Docker stays for the self-hosting audience. |
| **Pillar 2 — user owns the data** | strengthened. Wizard explicitly surfaces the data dir on first run; "Where is my data?" gets a dedicated section. |
| **Pillar 3 — anti-monoculture / sovereignty** | preserved. The phased migration explicitly refuses to drop the Docker path for the long-tail audience. |
| **Pillar 4 — honest evolution / no marketing-by-default** | preserved. The "what the doc-flip explicitly does NOT promise" section locks down the language. |
| **Pillar 5 — readable to humans** | strengthened. One README, one chooser, two clearly-labelled paths beats today's implicit "you're a developer, you have Docker" assumption. |
| **Pillar 6 — security / cryptographic trust** | preserved. The flip is gated on the signed-installer release; we never link users at unsigned builds. |

No pillar weakened.

## What this spike is not

- Not the actual rewrite. The flip-PR is a follow-up tick (or a Reed-driven manual edit pass), authored once sub-task 3 (Tauri shell) and sub-task 8 (CI release pipeline) ship.
- Not a marketing brief. Final copy, headline tone, and "card" microcopy are out of scope — they get drafted in the flip-PR with Reed's eye on them.
- Not a screenshot-capture session. Screenshots come from a real first-run wizard run; they cannot be mocked without lying.

## Effort estimate (for the flip-PR, not the spike)

- Structural rewrite of `README.md` + `README.de.md`: ~2 hours focused work.
- One-paragraph addition to `docs/setup.md` + `SETUP_ANLEITUNG.md`: ~15 minutes.
- 5–8 screenshots captured + compressed + committed: ~1 hour (assumes the wizard already exists and produces non-broken UI).
- `CLAUDE.md` + `SYSTEM_OVERVIEW.md` deployment-section update: ~30 minutes.
- Total: **half a focused tick day**, gated on sub-task 3 + sub-task 8 having already merged.

## Decision

Sub-task 10 is design-locked. Flip-PR opens against the `docs/native-readme-refit` branch the day after the first signed `v1.0-native` release tag exists; merges once Reed eyeballs the rendered README. Until then, today's Docker-led docs stay on `main` untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
