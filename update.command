#!/bin/bash
#
# mycelium — One-Click Updater for macOS
#
# Double-click this file in Finder to update your mycelium installation.
# Or run from Terminal:  ./update.command
#
# Wraps scripts/update.sh: git pull, npm build, run new migrations,
# refresh ollama models, reload dashboard + middleware LaunchAgents.
# Re-run anytime — every step is idempotent.

set -euo pipefail

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

clear
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                                                          ║"
echo "║     mycelium Updater                                     ║"
echo "║     Pulls latest changes, rebuilds, reloads services     ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$PROJECT_DIR/scripts/update.sh" ]]; then
  echo "✗ scripts/update.sh not found in $PROJECT_DIR" >&2
  echo "  This file must live in the mycelium repo root." >&2
  exit 1
fi

bash "$PROJECT_DIR/scripts/update.sh" "$@"

echo ""
echo "Done. You can close this window."
echo ""
