#!/usr/bin/env bash
# mycelium self-tick runner
# Invoked by LaunchAgent ai.mycelium.self-tick on a calendar schedule.
# One fresh claude-cli per tick — Claude triages and works in the same session.

set -euo pipefail

# --- paths -------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPT_FILE="$SCRIPT_DIR/tick-prompt.md"

MYCELIUM_HOME="${MYCELIUM_HOME:-$HOME/.mycelium}"
LOG_DIR="$MYCELIUM_HOME/logs"
LOCK_FILE="$MYCELIUM_HOME/self-tick.lock"
KILL_SWITCH="$MYCELIUM_HOME/self-tick.disabled"
SUMMARY_FILE="$LOG_DIR/self-tick.summary"

mkdir -p "$LOG_DIR"

# --- kill switch (fast path) -------------------------------------------------
if [[ -f "$KILL_SWITCH" ]]; then
  printf '%s  abandoned  -  -  kill-switch present (%s)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$KILL_SWITCH" >> "$SUMMARY_FILE"
  exit 0
fi

# --- claude-cli locator ------------------------------------------------------
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
if [[ -z "$CLAUDE_BIN" ]]; then
  printf '%s  abandoned  -  -  claude-cli not found in PATH\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"
  exit 1
fi

# --- single-instance lock (avoid overlap if a tick runs long) ----------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s  abandoned  -  -  previous tick still running (lock held)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"
  exit 0
fi

# --- log file (one per UTC day) ---------------------------------------------
LOG_FILE="$LOG_DIR/self-tick-$(date -u +%Y%m%d).log"

# --- tick --------------------------------------------------------------------
{
  printf '\n=== self-tick %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'cwd:       %s\n' "$REPO_ROOT"
  printf 'prompt:    %s\n' "$PROMPT_FILE"
  printf 'claude:    %s\n' "$CLAUDE_BIN"
} >> "$LOG_FILE"

cd "$REPO_ROOT"

# Pipe the prompt into claude-cli in print mode so it runs single-shot, no REPL.
# --dangerously-skip-permissions removes per-action prompts (this is an
# unattended autonomy run; safety lives in the prompt's hard rules + the
# pre-push branch hook + the network-tabu rule pinned in vector-memory).
"$CLAUDE_BIN" \
  --dangerously-skip-permissions \
  --print \
  < "$PROMPT_FILE" \
  >> "$LOG_FILE" 2>&1 \
  || printf '%s  abandoned  -  -  claude-cli exited non-zero\n' \
       "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY_FILE"

printf '=== self-tick done %s ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"
