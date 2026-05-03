# mycelium native shell (Tauri 2)

Sub-task 3 of [#176](https://github.com/Dewinator/mycelium/issues/176).

This crate scaffolds the platform-native window/tray shell that wraps
the existing mcp-server (PGlite + llama.cpp + dashboard). The architecture
is laid out in detail in [`../docs/native-tauri-shell-spike.md`](../docs/native-tauri-shell-spike.md).

## Layout

```
app/
├── src-tauri/                  Rust crate
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json         App identity, window, tray, sidecar config
│   ├── capabilities/           Permission manifests (default.json)
│   ├── icons/                  Placeholder PNGs (real branding pending)
│   ├── binaries/               Sidecar stubs per target triple
│   │                           (real bundle = follow-up #176 sub-task 8)
│   └── src/
│       ├── main.rs             Thin entry — calls lib::run()
│       └── lib.rs              Setup, sidecar spawn, tray, lifecycle
└── dist/                       frontendDist placeholder — production
                                serves the dashboard via the sidecar HTTP
                                port (8787), so this stays empty.
```

## Status

This PR ships the scaffold only. `cargo check` is green. What works:

- Window opens at `http://127.0.0.1:8787` (existing dashboard).
- Tray icon with Show/Hide + Quit.
- Closing the window minimises to tray (does NOT quit).
- Sidecar spawn wired (`MYCELIUM_DATA_DIR`, `MYCELIUM_DASHBOARD_PORT`,
  `MYCELIUM_WIRE_PORT` env vars passed through).
- Wave-3 forward-compat: `wire-cert/` directory created at first launch;
  capability set already lists shell-execute so the sidecar can later bind
  UDP for mDNS without re-signing.

What does NOT work yet (intentional, follow-up tickets):

- The sidecar binary in `binaries/mycelium-mcp-aarch64-apple-darwin` is a
  shell stub. Building the real bundled Node binary (Bun/pkg compile) is
  sub-task 8 (CI matrix).
- App icons are solid-purple placeholders.
- The auto-updater is wired, but the `pubkey` in `tauri.conf.json` is a
  placeholder — see "Signing-key bootstrap" below.

## Signing-key bootstrap (one-time, before first signed release)

`tauri-plugin-updater` mandates signature verification — there is no
`disable_signing` opt-out. The shell ships with a placeholder `pubkey`
that MUST be replaced before the first production build:

```bash
# 1. Install the Tauri CLI (one-time, ~5 min cold compile).
cargo install tauri-cli --version "^2"

# 2. Generate the signing keypair. Private key kept off-repo at the
#    default path (~/.tauri/mycelium.key). CI gets the private key
#    via TAURI_SIGNING_PRIVATE_KEY env / GitHub Actions secret.
cargo tauri signer generate -w ~/.tauri/mycelium.key

# 3. Copy the printed PUBLIC key into app/src-tauri/tauri.conf.json,
#    replacing PLACEHOLDER_REPLACE_WITH_TAURI_SIGNER_GENERATE_OUTPUT.

# 4. Verify cargo check still passes.
cd app/src-tauri && cargo check
```

The release pipeline (sub-task 8, CI matrix — separate ticket) signs
each platform artefact with the private key and ships
`latest.json` to GitHub Releases at the URL configured in
`tauri.conf.json` (`plugins.updater.endpoints[0]`).

## Local development

```bash
# Prereqs (one-time)
brew install rustup-init && rustup-init -y --default-toolchain stable --profile minimal

# Type-check the scaffold
cd app/src-tauri && cargo check

# Run with mcp-server already up at :8787 (`cd mcp-server && npm run dev`):
cd app/src-tauri && cargo tauri dev   # requires `cargo install tauri-cli`
```

`cargo tauri dev` will spawn the stub sidecar and the dashboard will fail
to load — until the bundling PR lands, run the mcp-server manually in a
separate terminal.
