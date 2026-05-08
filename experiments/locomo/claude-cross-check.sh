#!/usr/bin/env bash
# claude-cross-check.sh — Claude-via-Abo cross-check pass for one or more
# LoCoMo conversations. Uses claude-sonnet-4-6 as answerer + claude-haiku-4-5
# as judge, all via the user's Claude Code subscription (no API key).
#
# Output goes to experiments/locomo/out-claude/<sample_id>/ so it does not
# overwrite the local-baseline numbers in out/.
#
# Usage:
#   bash experiments/locomo/claude-cross-check.sh conv-26
#   bash experiments/locomo/claude-cross-check.sh conv-26 conv-30 conv-41
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out-claude"
mkdir -p "$OUT"
TOP_LOG="$OUT/cross-check.log"

ts() { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" >>"$TOP_LOG"; }

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <sample_id> [<sample_id>...]" >&2
  exit 2
fi

log "=== claude cross-check starting for $* ==="

for c in "$@"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"

  if [ -s "$OUT/$c/judgment.json" ]; then
    log "$c — already cross-checked, skipping"
    continue
  fi

  if [ ! -s "$OUT/$c/predictions.jsonl" ] || [ "$(wc -l < "$OUT/$c/predictions.jsonl" 2>/dev/null || echo 0)" -lt 10 ]; then
    log "=== $c · RUN (sonnet) ==="
    if node experiments/locomo/run-locomo.mjs --conv="$c" --provider=claude \
         --model=claude-sonnet-4-6 --top-k=25 --out-suffix=-claude >>"$CONV_LOG" 2>&1; then
      log "$c sonnet run ok"
    else
      log "$c SONNET RUN FAILED — see $CONV_LOG"
      continue
    fi
  else
    log "$c — sonnet predictions already exist, skipping run"
  fi

  log "=== $c · JUDGE (haiku) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" --judge=claude-cli \
       --judge-model=claude-haiku-4-5 --out-suffix=-claude >>"$CONV_LOG" 2>&1; then
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 >>"$TOP_LOG"
    log "$c haiku judge ok"
  else
    log "$c HAIKU JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== claude cross-check done ==="
