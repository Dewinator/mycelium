#!/usr/bin/env bash
# Serial re-judge of conv-47, conv-48, conv-49 with Haiku 4.5.
# Predictions already exist; only the judge is re-run.
set -u
cd "$(dirname "$0")/../.."

LOG="experiments/locomo/out-claude/rejudge-three.log"
: >"$LOG"

ts() { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

for c in conv-47 conv-48 conv-49; do
  log "=== START $c ==="
  # remove placeholder so the script writes its real judgment
  if grep -q placeholder "experiments/locomo/out-claude/$c/judgment.json" 2>/dev/null; then
    rm "experiments/locomo/out-claude/$c/judgment.json"
  fi
  node experiments/locomo/judge-locomo.mjs \
    --conv="$c" --judge=claude-cli --judge-model=claude-haiku-4-5 \
    --out-suffix=-claude \
    >>"experiments/locomo/out-claude/$c/run.log" 2>&1
  rc=$?
  if [ $rc -eq 0 ] && [ -s "experiments/locomo/out-claude/$c/judgment.json" ]; then
    acc=$(node -e "console.log((require('./experiments/locomo/out-claude/$c/judgment.json').accuracy_overall*100).toFixed(1))")
    log "=== DONE $c — accuracy=${acc}% ==="
  else
    log "=== FAIL $c (rc=$rc) — see run.log ==="
    # restore placeholder so watchdog still doesn't pick it up
    echo '{"placeholder":"failed, retry"}' > "experiments/locomo/out-claude/$c/judgment.json"
  fi
done
log "=== ALL DONE ==="
