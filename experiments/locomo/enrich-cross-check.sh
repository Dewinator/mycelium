#!/usr/bin/env bash
# enrich-cross-check.sh — enriched pipeline: re-enrich (qwen3:8b) → Sonnet answerer
# (RRF) → Haiku judge. Output goes to out-enriched-claude/ for comparison with
# the raw Sonnet baseline in out-claude/.
#
# Usage:
#   bash experiments/locomo/enrich-cross-check.sh conv-26 conv-30 conv-41 …
#   bash experiments/locomo/enrich-cross-check.sh --all
set -u
cd "$(dirname "$0")/../.."

OUT="experiments/locomo/out-enriched-claude"
mkdir -p "$OUT"
TOP_LOG="$OUT/enrich-cross-check.log"

ts()  { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$TOP_LOG"; }

# Resolve conversation list
if [ "${1-}" = "--all" ]; then
  mapfile -t CONVS < <(node -e '
    const d = require("./experiments/locomo/dataset/data/locomo10.json");
    for (const s of d) console.log(s.sample_id);
  ')
elif [ "$#" -gt 0 ]; then
  CONVS=("$@")
else
  echo "usage: $0 <sample_id>... | --all" >&2
  exit 2
fi

log "=== enrich-cross-check starting for ${CONVS[*]} ==="

for c in "${CONVS[@]}"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"

  if [ -s "$OUT/$c/judgment.json" ]; then
    log "$c — already enriched+judged, skipping"
    continue
  fi

  # ── Step 1: re-enrich with qwen3:8b (reset existing enriched memories) ──
  log "=== $c · ENRICH (qwen3:8b) ==="
  if node experiments/locomo/enrich-locomo.mjs --conv="$c" --reset --model=qwen3:8b \
       >>"$CONV_LOG" 2>&1; then
    log "$c enrich ok"
  else
    log "$c ENRICH FAILED — see $CONV_LOG"
    continue
  fi

  # ── Step 2: Sonnet answerer with RRF ──
  log "=== $c · RUN (sonnet + RRF) ==="
  if node experiments/locomo/run-locomo.mjs --conv="$c" --provider=claude \
       --model=claude-sonnet-4-6 --top-k=25 --rrf --out-suffix=-enriched-claude \
       >>"$CONV_LOG" 2>&1; then
    log "$c sonnet run ok"
  else
    log "$c SONNET RUN FAILED — see $CONV_LOG"
    continue
  fi

  # ── Step 3: Haiku judge ──
  log "=== $c · JUDGE (haiku) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" --judge=claude-cli \
       --judge-model=claude-haiku-4-5 --out-suffix=-enriched-claude \
       >>"$CONV_LOG" 2>&1; then
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 >>"$TOP_LOG"
    log "$c haiku judge ok"
  else
    log "$c HAIKU JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== enrich-cross-check done ==="
