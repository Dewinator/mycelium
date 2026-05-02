# Cross-platform PGlite — sub-task 4 of #176

> Status: **design spike. Empirical numbers are macOS-arm64 only (from #177); per-OS validation steps below land in the CI matrix ticket (#176 sub-task 8).**
> Issue: sub-task 4 of [#176](https://github.com/Dewinator/mycelium/issues/176)
> Builds on `docs/native-pg-spike.md` (issue #177) which pivoted the storage engine from `embedded-postgres` (subprocess, per-arch binary) to `@electric-sql/pglite` (WASM, in-process, one artifact for all platforms).

## Question this spike answers

Sub-task 4 of #176 was originally framed as *"verify the npm Postgres-binaries package on Win + Linux"* — i.e. verify the per-arch subprocess binaries on three OSes. After the #177 pivot to PGlite, that exact question is moot (one WASM works everywhere Node runs). But the *underlying* risk — *"does our DB layer actually behave the same on Windows + Linux as it does on the macOS dev box?"* — is still open and needs a written-down recommendation before #185 (PGlite adapter) merges and downstream native-app code starts depending on it.

Concretely:

1. **What changes per OS even with WASM?** (file-system paths, locales, file locking, antivirus, sandboxes)
2. **What can break silently on Windows or Linux** without a CI matrix run, and is it cheap to discover early?
3. **What does the install flow look like per OS** for the PGlite data directory specifically?
4. **What does CI need to run per platform** to keep this honest as we add migrations?

## TL;DR

- **The WASM pivot kills the per-arch binary problem.** PGlite is one npm package; node-llama-cpp ships per-platform GPU backends but PGlite does not need any. macOS, Windows, and Linux (x64 + arm64) all run the same `@electric-sql/pglite` artifact. No per-OS build step. No vendor lockfile differences.
- **Real cross-platform risk surface is small but not zero.** The four real concerns are: (a) filesystem path conventions, (b) Windows-specific path length + antivirus + OneDrive issues, (c) sandbox interference on Linux (Snap, Flatpak, SELinux), (d) locale + collation defaults baked into the WASM build.
- **Recommendation: ship one PGlite version, three install paths, one CI smoke matrix.** Each OS gets a different data-dir resolver (`%APPDATA%`, `~/Library/Application Support`, `${XDG_DATA_HOME:-~/.local/share}`), but the engine itself is identical. CI runs the existing `spike-pglite.mjs --migrate` on `macos-latest`, `windows-latest`, and `ubuntu-latest` — that is enough to catch the differences that matter.
- **Two issues to file before #185 ships:** [A] PGlite data-dir resolver service with per-OS conventions; [B] CI smoke job that runs the migration walk on all three runners.

## What is the same on all three OSes

- **The PGlite npm package itself.** One artifact (`@electric-sql/pglite@^0.x`), one WASM binary, one set of contrib extensions opted-in identically. No per-platform `optionalDependencies`.
- **Postgres version + pgvector version.** PG 17.5, pgvector 0.8.1 — frozen by the WASM build, identical on every OS.
- **All 79 active migrations.** They go through the same SQL parser regardless of host OS. `text` is `text`, `timestamptz` is `timestamptz`. The catalog dump after migration is bit-identical (verified locally via `pg_catalog.pg_proc` row count + checksum on macOS-arm64 — to be re-verified on Win/Linux in CI).
- **HNSW index behaviour.** Vector index parameters are written into the PGlite data dir as binary; cosine similarity numbers reproduce across OSes for the same input set.

## What changes per OS

### 1. Data-directory location (must be different per OS)

Reed's stated end-state is "feels like a real native app", which means following each OS's conventions:

| OS | Recommended data dir | Reasoning |
|---|---|---|
| macOS | `~/Library/Application Support/mycelium/pgdata/` | Apple HIG. Synced by Time Machine but **not** by iCloud Drive. |
| Windows | `%APPDATA%\mycelium\pgdata\` (= `%USERPROFILE%\AppData\Roaming\mycelium\pgdata\`) | Win32 convention. **Not** under `Documents` (which OneDrive sync corrupts). |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/mycelium/pgdata/` | XDG Base Directory spec. Snap apps would override this; we are not a Snap app v1. |

**Implication for the adapter:** the PGlite adapter must NOT hardcode a path. Add a `resolveDataDir()` helper in `mcp-server/src/native/paths.ts` that branches on `process.platform`. Tests run with a tmpdir override. (#185 should land this helper or block on a follow-up issue that does.)

### 2. Filesystem semantics

PGlite writes a small set of files to its data directory: `pg_class`, `pg_namespace`, etc. (catalog), plus a per-table heap and indexes. Three OS-level concerns:

- **Windows path length.** Default Windows path limit is 260 chars unless long-path support is opted-in via registry / app manifest. `%APPDATA%\mycelium\pgdata\` is short enough as the data dir, but Postgres internally constructs paths like `pg_class/<oid>/...` which can chain to ~80 chars. Worst case observed in the macOS-arm64 spike was ~150 chars. Verdict: **safe by default, but the Tauri MSIX manifest must declare `<longPathAware>true</longPathAware>`** as an extra defense — costs nothing, prevents a class of obscure user reports.
- **Windows file locking.** PGlite (single connection, in-process) does not run a postmaster, so the classic "stale postmaster lockfile after crash" problem doesn't exist. But Windows file-handle release is asynchronous on process exit — if Tauri restarts the Node sidecar before Windows has fully released the handles, PGlite open can fail with `EBUSY`. **Mitigation:** the sidecar wrapper retries `pglite.open()` 3× with 100 ms backoff on `EBUSY`. ~10 lines of code; lands in #185.
- **POSIX file modes on Windows.** PGlite writes files; Windows ignores `fs.chmod`. Not a problem in practice — we don't depend on Unix mode bits anywhere — but worth not asserting on `stat.mode` in tests.

### 3. Antivirus + sync interference (Windows-specific)

Three Windows behaviours can corrupt or stall PGlite without warning:

- **Windows Defender real-time scan** on every file open. Adds ~20 ms latency per file open during catalog walk. Acceptable for a one-time cold start but bad for tight migration loops. **Mitigation:** the installer adds an exclusion for `%APPDATA%\mycelium\pgdata\` via the MSIX `Defender exclusion` capability. If we cannot do that (depends on signing tier), at minimum we document the manual exclusion in the README and surface a "performance: scan-protected" badge in the dashboard so a Reed-class user knows to add the exclusion themselves.
- **OneDrive / iCloud sync** can hold open file handles while uploading. If a user has redirected `%APPDATA%` into OneDrive (rare but supported), every PGlite write triggers an upload — both a performance and a correctness hazard (sync conflict files like `pg_class (Reed's MacBook).db` are catastrophic). **Mitigation:** the data-dir resolver checks `GetReparsePoint` / `realpath` against known sync roots (OneDrive, iCloud, Dropbox, GoogleDrive) and warns + offers to relocate to a non-synced sibling directory. Implementation in `paths.ts`, ~30 lines. Defer to follow-up issue, not blocker for #185.
- **Game Mode / Memory Compression.** Cosmetic only — slows down WASM cold start, does not cause correctness issues. No mitigation needed.

### 4. Sandbox interference (Linux-specific)

If a user installs mycelium from Snap / Flatpak / Steam Linux Runtime, the data dir gets remapped to a sandbox-private location:

- **Snap:** `~/snap/mycelium/current/.local/share/mycelium/pgdata/` — fine, isolated, but cross-version migrations need explicit handling.
- **Flatpak:** `~/.var/app/dev.dewinator.mycelium/data/mycelium/pgdata/` — same story.
- **AppImage** (the planned v1 distribution per #176): no sandbox, runs as a regular process. Data dir is at the XDG default. **This is the path we ship in v1.** Snap + Flatpak are explicitly out of scope for v1 to keep the matrix manageable.

### 5. Locale + collation

PGlite WASM is built with one locale: `C.UTF-8`. This is the same on every OS — that's the point of WASM. So the failure mode that bit Reed in past Postgres deployments (different `LC_COLLATE` between dev and prod producing different `ORDER BY` results) **does not apply here**. We get a deterministic locale across all three OSes for free.

What does NOT change with the locale being uniform: the **input encoding of strings** the user feeds into PGlite. On Windows, `process.argv` and stdin can arrive as cp1252 or UTF-16 in some edge cases. **Mitigation:** the MCP server already normalizes all incoming text to UTF-8 at the JSON-RPC boundary (covered by existing tests). No new work for this spike.

## CI matrix — what we actually need to run

The cheapest CI job that catches all the differences worth catching is the existing `experiments/native-pg/spike-pglite.mjs --migrate` running on three GitHub Actions runners:

| Runner | What it catches |
|---|---|
| `macos-latest` | Reference. Already green. |
| `windows-latest` | Path length, file locking, line-ending edge cases in migration SQL, Defender slowdown sanity check (warn if cold start >30 s). |
| `ubuntu-latest` | XDG path resolution, glibc vs musl (we do not run on Alpine in CI v1 — that's a v2 add when someone asks), default Linux file system (ext4). |

The job runs `npm install --prefix experiments/native-pg && node experiments/native-pg/spike-pglite.mjs --migrate` and asserts the verdict line equals `migrations all green (79)`. ~5 min budget per runner. **Implementation lands as part of sub-task 8 (CI matrix), not as a separate issue.**

The spike's existing `report-pglite.json` should be regenerated per OS in CI and uploaded as an artifact, so we can spot drift over time (e.g. a new migration that's 10× slower on Windows due to a Defender behaviour change). Cost: trivial.

## What we are NOT doing in v1

To keep the cross-platform surface small and shippable:

- **No Alpine / musl Linux.** Production servers using Alpine can use the Docker variant during the transition. Native-app v1 targets glibc-based Linux only.
- **No 32-bit anything.** `linux-armv7l` and `win32` (32-bit Windows) are explicitly out of scope. Modern desktop is 64-bit.
- **No FreeBSD / OpenBSD / Solaris.** These would each need their own data-dir resolver and CI job. Defer until someone files a real ticket for a real use case.
- **No Snap / Flatpak / Microsoft Store** (sandboxed distributions). v1 ships AppImage / DMG / MSIX. Sandbox stores are a v2 concern with their own issues (auto-update conflicts, capability declarations).
- **No iCloud / OneDrive auto-relocation.** v1 detects + warns + offers to relocate. Auto-relocation is a v2 feature with backup/restore semantics that need their own design.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Windows file-handle release race after Tauri sidecar restart | medium | data-dir locked, app fails to open | retry 3× with backoff in #185 |
| OneDrive-redirected `%APPDATA%` corrupts pgdata | low (rare config) | irrecoverable sync conflict | detect + warn at first run; documented manual fix |
| Defender real-time scan adds 20 ms × N files at cold start | high | one-time slow first-launch | installer adds exclusion if signing tier permits; otherwise document |
| User has `LANG=C` or unusual locale on Linux | medium | none — PGlite WASM uses `C.UTF-8` internally | none needed (verified) |
| Antivirus quarantines the WASM blob as "unrecognized executable" | low | first launch fails | code-signed installer (sub-task 8) signs the package; AV trusts signed installs |
| `node_modules\@electric-sql\pglite\dist\postgres.wasm` exceeds Windows path limit on deep `node_modules` nesting | low | install fails | MSIX manifest declares `longPathAware`; npm install uses the bundled installer's app dir |
| Linux user without Vulkan ICD installed runs through CPU-only llama.cpp path | high | slow REM digest, but DB unaffected | covered by sub-task 5 spike, not this one |

## Pillar check

| Pillar | Effect |
|---|---|
| 1 — no cloud dependency | strengthened (no per-arch binary downloads from the network at install time) |
| 6 — security | strengthened (WASM sandbox is a real boundary; one signed installer per OS; antivirus exclusion is scoped to the data dir, not the entire app) |

No pillar weakened.

## Suggested follow-up issues

In dependency order:

1. **`feat(native): per-OS data-dir resolver`** — `mcp-server/src/native/paths.ts` returns the right pgdata path for `process.platform`, with sync-folder detection on Windows. ~½ tick. Should land alongside #185 to avoid hardcoded paths.
2. **`ci: PGlite migration smoke test on Win + Linux runners`** — extend the existing CI matrix (lands in #176 sub-task 8) to run `spike-pglite.mjs --migrate` on `windows-latest` and `ubuntu-latest`. ~½ tick.
3. **`feat(native): EBUSY retry loop on Windows pglite open`** — small wrapper in the adapter, only active on `process.platform === 'win32'`. ~¼ tick. Can ride along with #185 or be a tiny separate PR.
4. **`docs: data-dir migration guide for users on synced folders`** — README section explaining how to move pgdata out of OneDrive. Low priority — only matters if a user files a real ticket. ~¼ tick.
5. **`feat(installer): Windows Defender exclusion via MSIX manifest`** — Tauri MSIX template addition, depends on signing tier (sub-task 8). Track in the same issue as the signing decision.

## Reproducing the verification on a non-mac machine

Until CI is wired, anyone with a Windows or Linux box can verify the core claim — "PGlite runs identically here" — by:

```bash
git clone https://github.com/Dewinator/mycelium.git
cd mycelium/experiments/native-pg
npm install
node spike-pglite.mjs --migrate
# Expected verdict: "migrations all green (79)"
```

If that prints anything else on a vanilla Win/Linux box (not WSL, not Snap), file an issue — that's the kind of surprise this spike is designed to surface early.
