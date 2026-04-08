#!/usr/bin/env bash
# vectormemory cognitive maintenance — runs the nightly "sleep" tasks
# from the host, since the pgvector docker image doesn't ship pg_cron.
#
# Tasks:
#   1. consolidate_memories  — promote rehearsed episodic → semantic
#   2. dedup_similar_memories — merge near-duplicate vectors
#   3. forget_weak_memories  — soft-archive weak, old, unpinned traces
#
# Usage:
#   bash scripts/maintenance.sh                     # run all
#   bash scripts/maintenance.sh consolidate         # single task
#
# Schedule via launchd, cron, or extend scripts/watchdog.sh to call it once/day.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/docker/.env"
LOG="${VECTORMEMORY_LOG:-$HOME/Library/Logs/vectormemory-maintenance.log}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD not set in docker/.env}"
POSTGRES_DB="${POSTGRES_DB:-vectormemory}"
POSTGRES_PORT="${POSTGRES_PORT:-54322}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

run_sql() {
  local label="$1" sql="$2"
  log "→ $label"
  local out
  if out=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -v ON_ERROR_STOP=1 -tAc "$sql" 2>&1); then
    log "  ok: $out"
  else
    log "  FAIL: $out"
    return 1
  fi
}

task="${1:-all}"
log "── maintenance start ($task) ──"

case "$task" in
  consolidate|all)
    run_sql "consolidate_memories(3, 1)" "SELECT consolidate_memories(3, 1);"
    ;;
esac

case "$task" in
  dedup|all)
    run_sql "dedup_similar_memories(0.93)" "SELECT dedup_similar_memories(0.93);"
    ;;
esac

case "$task" in
  forget|all)
    run_sql "forget_weak_memories(0.05, 7)" "SELECT forget_weak_memories(0.05, 7);"
    ;;
esac

log "── maintenance done ──"
