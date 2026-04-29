#!/usr/bin/env bash
# Install the mycelium self-tick LaunchAgent.
# Idempotent: re-running re-renders the plist with current paths and reloads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TEMPLATE="$SCRIPT_DIR/ai.mycelium.self-tick.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/ai.mycelium.self-tick.plist"

mkdir -p "$TARGET_DIR" "$HOME/.mycelium/logs"
chmod +x "$SCRIPT_DIR/run-tick.sh"

# Render placeholders. Use a temp file + mv so a partial write can't be loaded.
TMP="$(mktemp)"
sed \
  -e "s|REPO_ROOT_PLACEHOLDER|$REPO_ROOT|g" \
  -e "s|HOME_PLACEHOLDER|$HOME|g" \
  "$TEMPLATE" > "$TMP"
mv "$TMP" "$TARGET"

# Reload (unload first, ignore "not loaded" error).
launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "Installed: $TARGET"
echo "Pause:     touch \$HOME/.mycelium/self-tick.disabled"
echo "Resume:    rm \$HOME/.mycelium/self-tick.disabled"
echo "Logs:      \$HOME/.mycelium/logs/self-tick-YYYYMMDD.log"
echo "Summary:   \$HOME/.mycelium/logs/self-tick.summary"
echo "Schedule:  9 ticks/day, 09:07 → 21:07 local, every 90 min"
