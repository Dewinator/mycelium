#!/usr/bin/env bash
# full-run.sh — ingest + answer + judge for all 10 LoCoMo conversations.
# Sequential per-conversation so a single hung run doesn't block the rest.
# Logs land in experiments/locomo/out/<sample_id>/run.log and a top-level
# experiments/locomo/out/full-run.log with timestamps.

set -u
cd "$(dirname "$0")/../.."   # repo root

OUT="experiments/locomo/out"
mkdir -p "$OUT"
TOP_LOG="$OUT/full-run.log"

ts() { date +"%Y-%m-%dT%H:%M:%S"; }
log() { echo "[$(ts)] $*" | tee -a "$TOP_LOG"; }

# Read sample IDs straight out of the dataset so we don't drift if it changes.
mapfile -t CONVS < <(node -e '
  const d = require("./experiments/locomo/dataset/data/locomo10.json");
  for (const s of d) console.log(s.sample_id);
')

log "starting full run for ${#CONVS[@]} conversations: ${CONVS[*]}"

# Ingest all 10 first (cheap, ~minutes total).
log "=== INGEST ALL ==="
if ! node experiments/locomo/ingest-locomo.mjs --all --reset >>"$TOP_LOG" 2>&1; then
  log "INGEST FAILED — aborting"
  exit 1
fi
log "ingest complete"

# Run + judge sequentially per conversation. If one fails we keep going.
for c in "${CONVS[@]}"; do
  CONV_LOG="$OUT/$c/run.log"
  mkdir -p "$OUT/$c"
  log "=== $c · RUN ==="
  if node experiments/locomo/run-locomo.mjs --conv="$c" >>"$CONV_LOG" 2>&1; then
    log "$c run ok"
  else
    log "$c RUN FAILED — see $CONV_LOG"
    continue
  fi
  log "=== $c · JUDGE (local qwen2.5) ==="
  if node experiments/locomo/judge-locomo.mjs --conv="$c" >>"$CONV_LOG" 2>&1; then
    # surface the headline accuracy line from the judge log
    grep -E "overall accuracy|evidence-recall|cat [0-9]+" "$CONV_LOG" | tail -10 | tee -a "$TOP_LOG" >/dev/null
    log "$c judge ok"
  else
    log "$c JUDGE FAILED — see $CONV_LOG"
  fi
done

log "=== FULL RUN DONE ==="
log "summary files: $OUT/<sample_id>/judgment.json"
