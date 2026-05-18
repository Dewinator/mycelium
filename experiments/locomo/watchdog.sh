#!/usr/bin/env bash
# watchdog.sh — keep the LoCoMo claude-cross-check alive.
# Started periodically by LaunchAgent com.mycelium.locomo-cross-check.
#
# Behaviour:
#  - if a previous instance is still running (PID-file alive) → exit
#  - else: pick the next unprocessed conv from out/ that has no judgment.json
#    in out-claude/, and feed it to claude-cross-check.sh
#  - if everything is judged → exit quietly
#
# claude-cross-check.sh itself is idempotent (skips when judgment.json exists),
# so the worst that can happen is wasted seconds.
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out-claude"
LOCK="$OUT/watchdog.pid"
LOG="$OUT/watchdog.log"
mkdir -p "$OUT"

ts() { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" >>"$LOG"; }

# previous run still alive?
if [ -f "$LOCK" ]; then
  prev=$(cat "$LOCK" 2>/dev/null || echo "")
  if [ -n "$prev" ] && kill -0 "$prev" 2>/dev/null; then
    log "previous run pid=$prev still alive, exiting"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# also bail out if a manual nohup run is still busy
for p in $(pgrep -f "claude-cross-check.sh" || true); do
  if [ "$p" != "$$" ]; then
    log "claude-cross-check.sh already running (pid=$p), exiting"
    exit 0
  fi
done

# find the next conv that exists in out/ but has no judgment in out-claude/
next=""
for d in experiments/locomo/out/conv-*; do
  c=$(basename "$d")
  if [ ! -s "$OUT/$c/judgment.json" ]; then
    next="$c"
    break
  fi
done

if [ -z "$next" ]; then
  log "all convs judged — nothing to do"
  exit 0
fi

log "picking $next"
bash experiments/locomo/claude-cross-check.sh "$next" >>"$LOG" 2>&1
log "$next done (or failed — see cross-check.log)"
