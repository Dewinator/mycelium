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

# --- single-instance lock (mkdir is atomic on macOS; flock is Linux-only) ----
LOCK_DIR="$MYCELIUM_HOME/self-tick.lock.d"
PID_FILE="$LOCK_DIR/pid"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$PID_FILE"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    return 0
  fi
  # Lock dir exists. Check whether the holder is still alive — if not,
  # break the stale lock and reclaim. macOS reuses PIDs, but the window
  # for misattribution here is tiny and the failure mode is benign
  # (a tick is skipped and the next slot tries again).
  local oldpid=""
  [[ -f "$PID_FILE" ]] && oldpid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "$oldpid" ]] && kill -0 "$oldpid" 2>/dev/null; then
    return 1
  fi
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$PID_FILE"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    return 0
  fi
  return 1
}

if ! acquire_lock; then
  printf '%s  abandoned  -  -  previous tick still running (pid %s)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat "$PID_FILE" 2>/dev/null || echo unknown)" >> "$SUMMARY_FILE"
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
