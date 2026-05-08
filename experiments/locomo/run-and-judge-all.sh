#!/usr/bin/env bash
# run-and-judge-all.sh — run + judge for all 10 conversations.
# Assumes ingest already done. Sequential, resumable (skips conversations
# whose judgment.json already exists).
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out"
mkdir -p "$OUT"
TOP_LOG="$OUT/full-run.log"

ts() { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" >>"$TOP_LOG"; }

CONVS=()
while IFS= read -r line; do CONVS+=("$line"); done < <(node -e '
  const d = require("./experiments/locomo/dataset/data/locomo10.json");
  for (const s of d) console.log(s.sample_id);
')

log "=== RESUME: run+judge for ${#CONVS[@]} conversations ==="

for c in "${CONVS[@]}"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"

  if [ -s "$OUT/$c/judgment.json" ]; then
    log "$c — already judged, skipping"
    continue
  fi

  if [ ! -s "$OUT/$c/predictions.jsonl" ]; then
    log "=== $c · RUN ==="
    if node experiments/locomo/run-locomo.mjs --conv="$c" >>"$CONV_LOG" 2>&1; then
      log "$c run ok"
    else
      log "$c RUN FAILED — see $CONV_LOG"
      continue
    fi
  else
    log "$c — predictions already exist, skipping run"
  fi

  log "=== $c · JUDGE (local qwen2.5) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" >>"$CONV_LOG" 2>&1; then
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 >>"$TOP_LOG"
    log "$c judge ok"
  else
    log "$c JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== ALL DONE ==="
