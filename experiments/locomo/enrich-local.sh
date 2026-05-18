#!/usr/bin/env bash
# enrich-local.sh — fully-local enriched pipeline:
#   1. enrich with qwen3:8b (better fact extraction)
#   2. run with qwen3:8b as answerer (RRF + compact output)
#   3. judge with qwen3:8b
#
# This measures mycelium's value for LOCAL models only — no cloud models.
# Compare against vanilla-baseline.sh to see mycelium's true contribution.
#
# Usage:
#   bash experiments/locomo/enrich-local.sh conv-26 conv-30 ...
#   bash experiments/locomo/enrich-local.sh --all
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out-enriched-local"
mkdir -p "$OUT"
TOP_LOG="$OUT/enrich-local.log"

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

log "=== enrich-local starting for ${CONVS[*]} ==="
log "Answerer: qwen3:8b (local) | Enricher: qwen3:8b | Judge: qwen3:8b"

for c in "${CONVS[@]}"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"

  if [ -s "$OUT/$c/judgment.json" ]; then
    log "$c — already done, skipping"
    continue
  fi

  # Step 1: re-enrich with qwen3:8b
  log "=== $c · ENRICH (qwen3:8b) ==="
  if node experiments/locomo/enrich-locomo.mjs --conv="$c" --reset --model=qwen3:8b \
       >>"$CONV_LOG" 2>&1; then
    log "$c enrich ok"
  else
    log "$c ENRICH FAILED — see $CONV_LOG"; continue
  fi

  # Step 2: qwen3:8b answerer with RRF + compact output
  log "=== $c · RUN (qwen3:8b + RRF + compact) ==="
  if node experiments/locomo/run-locomo.mjs --conv="$c" \
       --model=qwen3:8b --top-k=25 --rrf --compact --out-suffix=-enriched-local \
       >>"$CONV_LOG" 2>&1; then
    log "$c run ok"
  else
    log "$c RUN FAILED — see $CONV_LOG"; continue
  fi

  # Step 3: qwen3:8b judge
  log "=== $c · JUDGE (qwen3:8b) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" \
       --judge=ollama --judge-model=qwen3:8b --out-suffix=-enriched-local \
       >>"$CONV_LOG" 2>&1; then
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 >>"$TOP_LOG"
    log "$c judge ok"
  else
    log "$c JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== enrich-local done ==="
