#!/usr/bin/env bash
# vanilla-baseline.sh — qwen3:8b with NO mycelium recall.
# For each question, the model gets 25 RANDOM raw turns from the conversation.
# This is the true baseline: "what does a local model know without memory retrieval?"
#
# Compare accuracy here vs enrich-local.sh to measure mycelium's real value.
#
# Usage:
#   bash experiments/locomo/vanilla-baseline.sh conv-26 conv-30 ...
#   bash experiments/locomo/vanilla-baseline.sh --all
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out-vanilla"
mkdir -p "$OUT"
TOP_LOG="$OUT/vanilla-baseline.log"

ts()  { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$TOP_LOG"; }

if [ "${1-}" = "--all" ]; then
  mapfile -t CONVS < <(node -e '
    const d = require("./experiments/locomo/dataset/data/locomo10.json");
    for (const s of d) console.log(s.sample_id);
  ')
elif [ "$#" -gt 0 ]; then
  CONVS=("$@")
else
  echo "usage: $0 <sample_id>... | --all" >&2; exit 2
fi

log "=== vanilla-baseline starting for ${CONVS[*]} ==="
log "Answerer: qwen3:8b (local, random-25 turns, NO recall) | Judge: qwen3:8b"

for c in "${CONVS[@]}"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"

  if [ -s "$OUT/$c/judgment.json" ]; then
    log "$c — already done, skipping"
    continue
  fi

  # Run with random-baseline (no semantic retrieval, no enrichment)
  log "=== $c · RUN (random-25, no recall) ==="
  if node experiments/locomo/run-locomo.mjs --conv="$c" \
       --model=qwen3:8b --top-k=25 --random-baseline --compact --out-suffix=-vanilla \
       >>"$CONV_LOG" 2>&1; then
    log "$c run ok"
  else
    log "$c RUN FAILED — see $CONV_LOG"; continue
  fi

  # Judge
  log "=== $c · JUDGE (qwen3:8b) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" \
       --judge=ollama --judge-model=qwen3:8b --out-suffix=-vanilla \
       >>"$CONV_LOG" 2>&1; then
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 >>"$TOP_LOG"
    log "$c judge ok"
  else
    log "$c JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== vanilla-baseline done ==="
