# Auto-update operations spike — sub-task 6 of #176

> Status: **design spike (no code changes yet — depends on Tauri shell from sub-task 3 and release pipeline from sub-task 8)**
> Issue: sub-task 6 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Builds on `docs/native-tauri-shell-spike.md` (Tauri-updater pivot), `docs/native-ci-release-spike.md` (`latest.json` on GitHub Releases, two channels), and `docs/native-update-banner-spike.md` (banner UX surface).
> Sources verified against [Tauri 2 updater plugin docs](https://v2.tauri.app/plugin/updater/), [`tauri-apps/plugin-updater` source](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater), [GitHub Releases redirect behavior](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), and the Sparkle phased-rollout pattern (fetched 2026-05-02).

## Question this spike answers

The original epic listed sub-task 6 as "auto-update channels: Sparkle XML feed (macOS), MSIX update (Win), AppImage zsync (Linux)". The Tauri-shell pivot in spike 3 collapsed all three into a single Tauri-updater feed, and spikes 8 + 9 covered the **pipeline** (how releases are built and signed) and the **UX** (how the banner offers the install). What is left is the **operational reality** — what happens when a release goes wrong, how do we ramp safely, how do we rotate the signing key without bricking installs, and how do we know if any of this is working without phoning home (Pillar 1).

Six load-bearing questions:

1. **Staged rollouts** — how do we go to 5 % → 25 % → 100 % when the manifest is a static file on a CDN we don't control?
2. **Halt / kill-switch** — a release ships, it is corrupting data dirs, what is the *minutes-not-hours* path to stop new installs and warn people who already pulled it?
3. **Downgrade** — Tauri-updater is one-directional; what is the supported path back to v(N-1) when v(N) is broken but already installed?
4. **Update success telemetry without cloud** — Pillar 1 forbids "phoning home". How do we learn whether updates worked at all?
5. **Cert rotation** — the Tauri-updater Ed25519 key is the trust root. If it leaks, every install in the field needs a story. How?
6. **First-run version skew + channel switching UX** — a user downloads a January installer in May, or wants to flip stable ↔ beta. What does the lifecycle look like?

## TL;DR

- **Staged rollouts: client-side phasing with a stable hash.** `latest.json` gets an optional `rollout` field (`{ "phase": 0.25, "seed": "v0.2.0" }`). Each install computes `xxhash(install_id || seed) / 2^64 < phase`; if false, treat the version as "not yet available" and re-check tomorrow. Same trick Sparkle has shipped for years; needs ~30 lines in the updater glue, no server.
- **Halt mechanism: 60-second yank via `gh release edit`.** Mark the release as a draft (`gh release edit v0.x.y --draft`) → GitHub `/latest/` redirect falls back to previous. Already-installed users get a separate **advisory channel**: a tiny `advisories.json` on `main` (NOT in releases) that the running app polls once per launch. If it lists their current version with `severity: critical`, the dashboard shows a red banner with manual rollback steps.
- **Downgrade: explicit, manual, with a schema gate.** Tauri-updater stays one-directional. Rollback = user downloads previous installer from GitHub Releases manually. The Tauri shell ships a **schema-version check at startup**: if the embedded-PG data dir was last touched by a *newer* mycelium than is now running, refuse to start with a clear "your data is from a newer version, update or restore from backup" dialog. Prevents silent corruption.
- **Telemetry: opt-in, swarm-native, no cloud phoning.** No HTTP analytics. Update events (`updated_to=X`, `updated_at=ISO`, `outcome=ok|failed|reverted`) get recorded as **Tier-A swarm lessons** when the swarm-publish path lands (Welle 2 / 3). For the MVP — simply expose them as a CSV export from the dashboard so curious users can share with Reed manually. GitHub Insights download counts are the only zero-config metric.
- **Cert rotation: dual-sign for one minor-version cycle.** `tauri-action` already supports two `TAURI_SIGNING_PRIVATE_KEY*` env vars. When rotating, sign every release for ~6 months / 4 minor versions with both old + new keys; the updater's `pubkey` config is a list, accepts either. After the overlap, drop the old key from the bundle and from the secret store. Document the procedure in `docs/release-runbook.md` (created next to this spike).
- **First-run + channel switching: opinionated defaults.** First launch always runs `update.check()` AFTER the data dir is provisioned, never before. Channel switch (`stable ↔ beta`) requires explicit user confirmation; switching `beta → stable` while currently on a beta version that has no stable equivalent shows a clear "this means a downgrade — your data may be from a newer schema" warning, with the same schema-gate rules as manual downgrade.

## The six decisions, in detail

### 1. Staged rollouts via client-side phasing

The official Tauri docs do not mention rollout phasing. Sparkle (the macOS prior art) has had this for years and the pattern is portable.

**Mechanism:**

```jsonc
// latest.json (additive — older clients ignore unknown fields, per Tauri-updater's lenient parser)
{
  "version": "0.2.0",
  "notes": "...",
  "pub_date": "2026-05-09T18:00:00Z",
  "rollout": { "phase": 0.25, "seed": "v0.2.0" },   // NEW
  "platforms": { ... }
}
```

```ts
// In the Tauri shell's update glue (sub-task 3 ticket 4, augmented):
const update = await check();
if (update?.available && update.rollout) {
  const installId = await getInstallId();   // UUID written to data dir on first run
  const h = xxhash64(`${installId}|${update.rollout.seed}`);
  const fraction = Number(h) / Number(2n ** 64n);
  if (fraction >= update.rollout.phase) {
    // Not in this phase yet — re-check tomorrow, behave as if no update.
    return null;
  }
}
return update;
```

**Phase progression:** Reed bumps the manifest by hand: 5 % → 25 % → 100 % over 3 days. Tooling: `scripts/bump-rollout.ts <tag> <phase>` mutates `latest.json` and re-uploads it (`gh release upload --clobber`). One CLI command, no server.

**Why not server-side phasing:** would require either a custom update server (rejected per spike 8) or GitHub-Pages redirect rules (brittle, untestable). Client-side phasing keeps the manifest static and the trust boundary tight.

**Edge case:** beta channel skips phasing entirely (`phase: 1.0` always). Power-users opting into beta want it now.

### 2. Halt mechanism: 60-second yank + advisory channel

Two distinct failure modes need distinct responses:

**(a) "stop the bleeding" — halt new installs.** A release breaks first-run for a chunk of users. Reed runs:

```bash
gh release edit v0.2.0 --draft
```

This pulls the release out of the "latest non-prerelease" set; `https://github.com/.../releases/latest/download/latest.json` then resolves to `v0.1.x`. New `update.check()` calls return "no update". Time-to-mitigate: under 60 seconds, no CI, no rebuild.

**Caveat:** clients who *already* fetched `latest.json` for `v0.2.0` and are mid-download keep going. Tauri-updater has no ambient cancel. Acceptable — they get the broken update, but it stops at that one cohort instead of expanding.

**(b) "warn already-installed users" — advisory channel.** For users who already updated and are now running a broken version, we need a way to tell them WITHOUT pushing a new release (which would re-trigger any rollout phasing that hid the broken release from them in the first place).

**Design:** a single tiny file on `main`, fetched once per app launch:

```
https://raw.githubusercontent.com/Dewinator/mycelium/main/docs/advisories.json
```

```jsonc
{
  "advisories": [
    {
      "id": "MYCEL-2026-001",
      "affects": ["0.2.0"],
      "severity": "critical",
      "title": "Data dir corruption on first-run with imported swarm peers",
      "remediation": "https://github.com/Dewinator/mycelium/issues/XXX",
      "published": "2026-05-09T20:13:00Z"
    }
  ]
}
```

The dashboard polls this on boot and on banner-render. If the running version matches an advisory's `affects` array, a red banner overlays the regular update banner with the title + a "What do I do?" link. **No automatic action** — the user reads the issue and decides whether to roll back manually.

**Why not push a `latest.json` patch with the advisory:** because clients who already updated will not re-fetch `latest.json` until their next scheduled update check (24 h). The advisory channel is intentionally cheap and decoupled — a `git push` on `main` is the trigger, GitHub's CDN does the rest, no release pipeline involved. No advisories should ever block app startup; they are informational, never modal.

### 3. Downgrade: explicit + schema-gated

Tauri-updater is **one-directional by design**. Adding bidirectional update flow would mean writing a custom updater — out of scope, high blast-radius.

**Manual rollback path (documented in runbook):**

1. User downloads previous version installer from `https://github.com/Dewinator/mycelium/releases`.
2. User quits running mycelium.
3. User runs the older installer; it overwrites the app bundle.
4. User relaunches.

**Schema gate (REQUIRED — implemented in sub-task 7 migration code):**

The embedded-PG data dir stores a marker file `SCHEMA_VERSION` containing the highest migration number applied. On every Tauri shell startup:

```ts
const dataDirSchema = await readSchemaVersion();   // e.g. 087
const bundledSchema = HIGHEST_MIGRATION_NUMBER;    // e.g. 084 in the rolled-back binary

if (dataDirSchema > bundledSchema) {
  // Refuse to start. User would otherwise hit "column does not exist" at runtime.
  showFatalDialog({
    title: "Data is from a newer version",
    body: `Your data dir was last opened by mycelium with schema v${dataDirSchema}. This installation has schema v${bundledSchema}. Re-install the newer version, or restore from backup.`,
    actions: ["Open Releases page", "Quit"],
  });
  app.exit(1);
}
```

**Why fail-closed instead of best-effort:** silent schema mismatch corrupts the user's data without warning. Pillar 6 (security) and the user's mental model of "my AI's memory is sovereign and intact" both require fail-closed.

**Out-of-scope for this spike:** automated rollback button in the dashboard. Could be added once the manual flow is exercised in production a few times.

### 4. Telemetry without cloud

Pillar 1 is **non-negotiable: no cloud dependency for the running app**. Sentry, Mixpanel, Plausible — all out, even self-hosted, because they imply a user-side decision to share that we should not pre-make.

**What we lose:** real-time visibility into update success rate.
**What we gain:** zero trust surface, zero GDPR exposure, true sovereignty.

**Design — three layers, opt-in compounds:**

| Layer | Default | Carries | Where it surfaces |
|---|---|---|---|
| **A. GitHub Insights download counts** | always on (GitHub-side, no client involvement) | "v0.2.0 dmg downloaded N times" | Reed checks the GH UI weekly |
| **B. Local update event log** | always on, local only, never leaves the device | timestamps + outcomes per update attempt | dashboard UI: Settings → "About" → "Update history"; `Export as CSV` button |
| **C. Swarm-published update lesson** | opt-in toggle, off by default | "v0.1.9 → v0.2.0 succeeded on darwin-arm64" as a Tier-A swarm lesson | other peers in trust-edge see it, can spot a bad release converging across the swarm |

Layer C is the long-game payoff for the swarm thesis: when 6+ peers all publish "v0.2.0 update failed" within an hour, the swarm itself becomes the early-warning system, with no central server. This unlocks once Welle 2 (second peer + public seed) is live; for MVP the toggle exists in Settings but the publish path is dormant until the swarm code lands.

**Out of scope:** crash reporting via Sentry-self-hosted etc. If/when Reed wants this, it goes through the swarm-lesson path (layer C), not a separate channel.

### 5. Cert rotation: dual-sign overlap

The Tauri-updater Ed25519 private key is the single most sensitive secret in the project. If it leaks (laptop theft, GitHub Actions log exposure, contributor turnover), every running install will trust attacker-signed payloads forever — until rotated.

**Tauri 2 native support:** [the updater plugin's `pubkey` config accepts a single key string](https://v2.tauri.app/plugin/updater/), but `tauri-action` and the underlying signer support producing a `.sig` per release with multiple keys (one .sig per key, named `*.sig` and `*.sig.legacy` etc). The updater verifies that AT LEAST ONE configured key validates the signature.

**Procedure (documented in `docs/release-runbook.md` follow-up):**

1. **T₀** — generate `KEY_NEW`, store in GitHub secrets (`TAURI_SIGNING_PRIVATE_KEY_NEW`) + 1Password. Add its public half to the Tauri config as a second accepted pubkey: `pubkey: [PUB_OLD, PUB_NEW]`.
2. **T₀ + 1 release** — releases now sign with BOTH keys. Older installs (which only know `PUB_OLD`) accept the old-key signature. Newer installs (which know both) accept either.
3. **T₀ + ~4 minor versions / ~6 months** — the install base has rolled forward; the bottom 5 % running ancient versions either updated normally or are abandoned. Drop `PUB_OLD` from `pubkey`. From this point, any install still on a pre-T₀ binary is stuck and must reinstall manually.
4. **T₀ + same** — delete `KEY_OLD` from the secret store and 1Password. Audit the deletion.

**Emergency path (`KEY_OLD` is known leaked):** skip the 6-month overlap. Ship a single release signed with BOTH keys, then immediately rotate `pubkey` config to `[PUB_NEW]` only. Users on old binaries get a single window (hours/days) to update before the bridge release goes stale. Document loudly via the **advisory channel** (decision 2) so anyone watching gets a chance to update before they are stranded.

**Why dual-sign is the right primitive:** any "rotate by re-installing" approach loses the bottom of the install base and breaks Pillar 5 (no abandonment of users). Dual-sign matches Sparkle / sigstore industry practice and stays inside Tauri-updater's own validation logic — no custom verification code, no re-implementing the trust root.

### 6. First-run + channel switching UX

**First-run lifecycle (must NOT block):**

```
T+0s     User double-clicks DMG, drags to Applications.
T+0s     User launches mycelium for first time.
T+0.5s   Tauri shell paints window with "Setting up your data dir…" splash.
T+1-5s   Embedded PG provisions, migrations run, llama.cpp warms up.
T+5s     Splash hands off to dashboard.
T+8s     Dashboard renders. Update banner is HIDDEN until check completes.
T+10-20s update.check() resolves in the background.
T+20s    If update available: banner slides in. If not: stays hidden, no flash.
```

**Hard rules:**
- `update.check()` runs AFTER data dir is fully provisioned — never before. A failed update mid-provision would leave a half-migrated data dir.
- The banner is gated on a `firstRunComplete` flag set after the initial wizard. We never offer an update during the wizard itself; that is a recipe for a confused user accepting an update they don't understand.

**Channel switching (Settings → Update channel: Stable | Beta):**

- **Stable → Beta:** flip flag, immediate `update.check()` against `latest-beta.json`. If a newer beta is available, banner offers it. Standard happy path.
- **Beta → Stable:** flip flag, immediate `update.check()` against `latest.json`.
  - If currently on a beta-only version (e.g. `0.3.0-beta.5` with no `0.3.0` stable yet): **show warning** "Switching to stable will leave you on the current beta until stable catches up. To go back to the previous stable now, you must reinstall manually." Schema-gate (decision 3) applies the same way.
  - If a stable version >= current is available: same as a normal update offer, just from the other channel.
- The channel chip on the banner (sub-task 9 spike) reflects whichever channel is currently selected, so the user sees what they are about to install.

## What this spike does NOT answer

- **Bandwidth costs at 100 k+ installs.** GitHub Releases CDN is free for public repos and has historically held under massive load. If we ever hit limits, mirror to Cloudflare R2 — cheap, no per-egress fee. Out of scope until we have data.
- **Differential / delta updates.** Tauri-updater downloads full installers (~80–150 MB with bundled GGUF). Differential updates would cut this to 5–10 MB but require a custom server or third-party service (rejected). Acceptable trade for Pillar 1.
- **Crash-on-update recovery.** If the app crashes during `downloadAndInstall`, Tauri 2 keeps the old bundle in place — covered by the plugin itself. Worth an empirical test once implementation lands.
- **Update over metered connections.** macOS / Windows already have OS-level "metered network" APIs. Wiring Tauri to honor them is a v2 polish ticket.
- **Localization of the advisory + warning copy.** All copy in this spike is English-only; i18n bundle work tracks separately.

## Suggested follow-up issues (in dependency order)

1. `feat(release): client-side rollout phasing + bump-rollout.ts CLI` — implements decision 1. Depends on Tauri shell sub-task 3 ticket 4 (updater plugin glue).
2. `feat(dashboard): advisory channel polling + red banner` — implements decision 2(b) advisory side. Independent, can land parallel to (1).
3. `feat(native): SCHEMA_VERSION marker + startup gate` — implements decision 3 schema gate. Depends on sub-task 7 migration ticket.
4. `feat(dashboard): update history CSV export` — implements decision 4 layer B. Depends on (1) writing event log.
5. `docs(release-runbook): cert rotation procedure + emergency path` — implements decision 5 documentation. No code, lands when (1) is in.
6. `feat(updater): channel switching UX in Settings` — implements decision 6. Depends on (1).

## Pillar check

- **Pillar 1 (no cloud)**: respected throughout. The advisory channel uses GitHub raw content (same trust boundary as the source code itself); the swarm-publish path uses peer-to-peer trust edges, never a centralised analytics endpoint.
- **Pillar 5 (no abandonment of users)**: dual-sign cert rotation explicitly avoids stranding old installs. Schema gate on rollback prevents silent corruption rather than blocking the user from operating.
- **Pillar 6 (security)**: every decision strengthens the existing posture — staged rollouts limit blast radius, halt mechanism gives Reed a < 60 s mitigation lever, schema gate is fail-closed, dual-sign rotation has zero windows where the trust root is trivially recoverable.
- No pillar weakened.

## What I am NOT doing this tick

Per the pinned hard rule (PR queue full, all 9 native-app PRs waiting on Reed): **no new PR opened**. This spec lands direct-to-main as docs only, same pattern as commits `db8fec2` (sub-task 9 banner), `38b6e0b` (sub-task 8 CI), `fc0108b` (sub-task 5 LLM), `f54a7cd` (sub-task 3 Tauri), `4491fcf` (sub-task 7 migration). Implementation tickets above are intentionally not filed yet — proposed-by-agent queue caps at 3 ungelabelte issues, and tickets (1), (3), (6) all depend on prerequisite implementation tickets being filed first anyway.
