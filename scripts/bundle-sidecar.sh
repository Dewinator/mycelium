#!/usr/bin/env bash
# Bundles the mcp-server (compiled JS + node_modules) into the Tauri app's
# sidecar-payload directory so `cargo tauri build` packs it as a Resources
# sub-tree. Called by `tauri.conf.json`'s beforeBuildCommand and runnable
# standalone for development.
#
# Output layout (under app/src-tauri/sidecar-payload/):
#   index.js, *.map           ← compiled mcp-server entry
#   node_modules/             ← runtime deps (PGlite WASM, llama.cpp .node, …)
#   package.json              ← so node resolves the right "main"/"type"
#   ...rest of dist/
#
# IMPORTANT (current iteration, sub-task 3 ticket A):
# This requires a system-Node install on the target machine. The launcher
# script in app/src-tauri/binaries/mycelium-mcp-* invokes `node` from PATH.
# Bundling a portable Node runtime so the .dmg is self-contained is
# follow-up sub-task 8 (CI matrix / cross-platform compile).
#
# Usage:  scripts/bundle-sidecar.sh
# Idempotent — safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_SERVER="$REPO_ROOT/mcp-server"
PAYLOAD="$REPO_ROOT/app/src-tauri/sidecar-payload"

echo "[bundle-sidecar] repo=$REPO_ROOT"
echo "[bundle-sidecar] payload=$PAYLOAD"

# 1. Ensure node_modules are present (needed for runtime resolve AND for
#    `tsc` in step 2 — must run before the build, not after).
if [ ! -d "$MCP_SERVER/node_modules" ]; then
  echo "[bundle-sidecar] node_modules missing — running npm ci"
  (cd "$MCP_SERVER" && npm ci)
fi

# 2. Ensure mcp-server is built.
if [ ! -f "$MCP_SERVER/dist/index.js" ] || [ "$MCP_SERVER/src/index.ts" -nt "$MCP_SERVER/dist/index.js" ]; then
  echo "[bundle-sidecar] mcp-server build needed — running npm run build"
  (cd "$MCP_SERVER" && npm run build)
else
  echo "[bundle-sidecar] mcp-server build is fresh"
fi

# 3. Wipe and re-create payload (cheaper than rsync diff for ~150 MB tree).
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"

# 4. Copy compiled dist (everything: index.js, services/, tools/, agents/, …).
cp -R "$MCP_SERVER/dist/." "$PAYLOAD/"

# 5. Copy node_modules verbatim. PGlite ships WASM + .data, node-llama-cpp
#    ships native .node bindings — both need their on-disk layout intact.
cp -R "$MCP_SERVER/node_modules" "$PAYLOAD/node_modules"

# 6. package.json so Node honours "type": "module" / "exports".
cp "$MCP_SERVER/package.json" "$PAYLOAD/package.json"

# 7. Migrations dir is read at boot by the migration runner — pack a copy.
mkdir -p "$PAYLOAD/supabase"
cp -R "$REPO_ROOT/supabase/migrations" "$PAYLOAD/supabase/migrations"

SIZE=$(du -sh "$PAYLOAD" | cut -f1)
echo "[bundle-sidecar] payload built — $SIZE"
