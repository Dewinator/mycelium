#!/usr/bin/env bash
# vectormemory-openclaw watchdog v2
# Job: Hält das gesamte Setup für openClaw am Leben — Docker, Supabase (pg_isready),
# Ollama (HTTP-Probe) und das Embedding-Modell. Echte Health-Probes statt
# "Container läuft = ok"-Annahmen, mit Verifikation, Status-Snapshot,
# Backoff und macOS-Notification bei dauerhaftem Ausfall.
# Kompatibel mit macOS bash 3.2 (keine assoziativen Arrays).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG="$HOME/Library/Logs/vectormemory-watchdog.log"
STATUS_FILE="$HOME/.vectormemory-status.json"
STATE_DIR="$HOME/.vectormemory-watchdog"
mkdir -p "$STATE_DIR"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

COMPONENTS="docker supabase-pg supabase-rest ollama embedding-model dashboard"
OVERALL="ok"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Status wird in ${STATE_DIR}/<comp>.{status,detail} abgelegt — bash3-tauglich
set_status() {
  local comp="$1" state="$2" detail="${3:-}"
  echo "$state"  > "$STATE_DIR/$comp.status"
  echo "$detail" > "$STATE_DIR/$comp.detail"
  if [ "$state" != "ok" ] && [ "$state" != "skipped" ]; then OVERALL="degraded"; fi
}
get_status() { cat "$STATE_DIR/$1.status" 2>/dev/null || echo unknown; }
get_detail() { cat "$STATE_DIR/$1.detail" 2>/dev/null || echo ""; }

# ── Probes ───────────────────────────────────────────────
probe_docker()        { docker info >/dev/null 2>&1; }
probe_postgres()      { docker exec vectormemory-db pg_isready -U postgres >/dev/null 2>&1; }
probe_supabase_rest() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:54321/ 2>/dev/null || echo "000")
  [ "$code" = "200" ] || [ "$code" = "404" ]
}
probe_ollama()        { curl -sf --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; }
probe_embedding_model() {
  curl -sf --max-time 3 http://127.0.0.1:11434/api/tags 2>/dev/null \
    | grep -q '"name":"nomic-embed-text'
}
probe_dashboard() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/ 2>/dev/null || echo "000")
  [ "$code" = "200" ]
}

# ── Backoff ──────────────────────────────────────────────
fail_count() { [ -f "$STATE_DIR/$1.fails" ] && cat "$STATE_DIR/$1.fails" || echo 0; }
bump_fail()  { local n; n=$(($(fail_count "$1") + 1)); echo "$n" > "$STATE_DIR/$1.fails"; echo "$n"; }
reset_fail() { rm -f "$STATE_DIR/$1.fails"; }
notify()     { osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true; }

# ── Recovery ─────────────────────────────────────────────
heal_docker() {
  log "Docker down — open -a Docker"
  open -a Docker 2>/dev/null || { log "ERROR: konnte Docker Desktop nicht starten"; return 1; }
  for i in $(seq 1 30); do
    sleep 2
    probe_docker && { log "Docker ist hoch"; return 0; }
  done
  return 1
}
heal_supabase() {
  log "Supabase down — docker compose up -d"
  ( cd "$PROJECT_DIR/docker" && docker compose up -d >> "$LOG" 2>&1 ) || return 1
  for i in $(seq 1 20); do
    sleep 2
    if probe_postgres && probe_supabase_rest; then log "Supabase ist hoch"; return 0; fi
  done
  return 1
}
heal_ollama() {
  log "Ollama down — brew services start ollama"
  brew services start ollama >> "$LOG" 2>&1 || log "WARN: brew services start ollama Fehler"
  for i in $(seq 1 15); do
    sleep 2
    probe_ollama && { log "Ollama ist hoch"; return 0; }
  done
  return 1
}
heal_model() {
  log "Embedding-Modell fehlt — ollama pull nomic-embed-text"
  ollama pull nomic-embed-text >> "$LOG" 2>&1 || return 1
  probe_embedding_model
}
heal_dashboard() {
  log "Dashboard down — launchctl kickstart"
  launchctl kickstart -k "gui/$(id -u)/com.vectormemory.dashboard" >> "$LOG" 2>&1 || return 1
  for i in $(seq 1 10); do
    sleep 1
    probe_dashboard && { log "Dashboard ist hoch"; return 0; }
  done
  return 1
}

# ── probe → ggf. heal → re-probe ─────────────────────────
check_component() {
  local comp="$1" probe_fn="$2" heal_fn="$3"
  if "$probe_fn"; then
    set_status "$comp" "ok" ""
    reset_fail "$comp"
    return
  fi
  log "PROBE FAIL: $comp"
  if "$heal_fn"; then
    if "$probe_fn"; then
      set_status "$comp" "ok" "recovered"
      reset_fail "$comp"
      log "RECOVERED: $comp"
      return
    fi
  fi
  local n; n=$(bump_fail "$comp")
  set_status "$comp" "fail" "down ${n}x"
  log "STILL DOWN: $comp (consecutive fails: $n)"
  if [ "$n" -ge 2 ]; then
    notify "VectorMemory Watchdog" "$comp ist down ($n× in Folge)."
  fi
}

# ── Tick ─────────────────────────────────────────────────
log "── tick ──"

check_component "docker" probe_docker heal_docker
if [ "$(get_status docker)" = "ok" ]; then
  check_component "supabase-pg"   probe_postgres      heal_supabase
  check_component "supabase-rest" probe_supabase_rest heal_supabase
else
  set_status "supabase-pg"   "skipped" "docker down"
  set_status "supabase-rest" "skipped" "docker down"
fi
check_component "ollama" probe_ollama heal_ollama
if [ "$(get_status ollama)" = "ok" ]; then
  check_component "embedding-model" probe_embedding_model heal_model
else
  set_status "embedding-model" "skipped" "ollama down"
fi
check_component "dashboard" probe_dashboard heal_dashboard

# ── Status-Snapshot ──────────────────────────────────────
{
  printf '{\n'
  printf '  "ts": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '  "overall": "%s",\n' "$OVERALL"
  printf '  "components": {\n'
  first=1
  for comp in $COMPONENTS; do
    [ $first -eq 0 ] && printf ',\n'
    first=0
    printf '    "%s": {"status": "%s", "detail": "%s"}' \
      "$comp" "$(get_status "$comp")" "$(get_detail "$comp")"
  done
  printf '\n  }\n}\n'
} > "$STATUS_FILE"

log "── tick done [$OVERALL] ──"
