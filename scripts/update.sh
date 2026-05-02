#!/usr/bin/env bash
# update.sh — in-place update for an existing mycelium installation.
#
# Pendant to install.sh. Runs idempotently:
#   1. git fetch + fast-forward (or rebase) on the configured branch
#   2. npm install + build in mcp-server/
#   3. scripts/migrate.sh (only new SQL files actually change DB state)
#   4. ollama pull for known models (idempotent)
#   5. reload launchd / systemd-user services so the new build is live
#
# Usage:
#   bash scripts/update.sh [options]
#
# Options:
#   --yes               assume "yes" for all prompts (non-interactive)
#   --branch BRANCH     git branch to update from (default: current branch)
#   --skip-models       skip ollama model pulls
#   --skip-services     do not reload dashboard/middleware services
#   --skip-migrations   do not run scripts/migrate.sh
#   --print-only        only print what *would* be done, never execute
#   --help              show this help
#
# Re-run safely: every step is a no-op if there is nothing new to do.

set -euo pipefail

# ─── colors ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

say()    { printf "%s\n" "$*"; }
info()   { printf "${C_CYAN}→${C_RESET} %s\n" "$*"; }
ok()     { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()   { printf "${C_YELLOW}⚠${C_RESET} %s\n" "$*"; }
err()    { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
step()   { printf "\n${C_BOLD}${C_BLUE}── %s ──${C_RESET}\n" "$*"; }
hint()   { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }

# ─── defaults ────────────────────────────────────────────────────────────────
ASSUME_YES=0
SKIP_MODELS=0
SKIP_SERVICES=0
SKIP_MIGRATIONS=0
PRINT_ONLY=0
BRANCH=""

# ─── arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)              ASSUME_YES=1 ;;
    --skip-models)      SKIP_MODELS=1 ;;
    --skip-services)    SKIP_SERVICES=1 ;;
    --skip-migrations)  SKIP_MIGRATIONS=1 ;;
    --print-only)       PRINT_ONLY=1 ;;
    --branch)           shift; BRANCH="$1" ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0 ;;
    *)
      err "unknown option: $1"
      exit 2 ;;
  esac
  shift
done

# ─── helpers ─────────────────────────────────────────────────────────────────
ask_yes_no() {
  local q="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then return 0; fi
  printf "${C_BOLD}?${C_RESET} %s [y/N] " "$q"
  local ans
  read -r ans </dev/tty || ans="n"
  [[ "$ans" =~ ^[YyJj] ]]
}

run_or_print() {
  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    printf "${C_DIM}$ %s${C_RESET}\n" "$*"
    return 0
  fi
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ─── locate repo ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  err "not a git checkout: $PROJECT_DIR"
  hint "update.sh expects mycelium to live in a git clone (use install.sh for fresh setups)"
  exit 1
fi

# ─── OS detection ────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS="mac" ;;
  Linux)  OS="linux" ;;
  *)      OS="other" ;;
esac

say ""
say "${C_BOLD}mycelium update${C_RESET}  ${C_DIM}— $PROJECT_DIR${C_RESET}"
say ""

# ─── 1) git pull ─────────────────────────────────────────────────────────────
step "1) git update"

if ! have git; then
  err "git not found"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -z "$BRANCH" ]]; then
  BRANCH="$CURRENT_BRANCH"
fi

if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  err "could not determine git branch (detached HEAD?). Pass --branch <name>."
  exit 1
fi

# Refuse to clobber uncommitted local changes.
if [[ -n "$(git status --porcelain)" ]]; then
  warn "working tree has uncommitted changes:"
  git status --short | sed 's/^/    /'
  if ! ask_yes_no "Continue anyway? (your changes stay; pull will use --rebase --autostash)"; then
    err "aborted"
    exit 1
  fi
fi

info "fetching origin…"
run_or_print git fetch --tags --prune origin

LOCAL_REF="$(git rev-parse "$BRANCH" 2>/dev/null || echo "")"
REMOTE_REF="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")"

if [[ -z "$REMOTE_REF" ]]; then
  err "origin/$BRANCH not found on remote"
  exit 1
fi

if [[ "$LOCAL_REF" == "$REMOTE_REF" ]]; then
  ok "already up to date on $BRANCH (@$(git rev-parse --short HEAD))"
  GIT_CHANGED=0
else
  info "incoming commits on $BRANCH:"
  git log --oneline --no-merges "$LOCAL_REF..$REMOTE_REF" 2>/dev/null | head -20 | sed 's/^/    /' || true
  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    info "switching from $CURRENT_BRANCH to $BRANCH"
    run_or_print git checkout "$BRANCH"
  fi
  run_or_print git pull --rebase --autostash origin "$BRANCH"
  ok "now at $(git rev-parse --short HEAD)"
  GIT_CHANGED=1
fi

# ─── 2) node deps + build ────────────────────────────────────────────────────
step "2) mcp-server build"

if ! have node || ! have npm; then
  err "node/npm not found — install Node.js >= 20 and re-run."
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/mcp-server" ]]; then
  warn "mcp-server/ not found — skipping build"
else
  pushd "$PROJECT_DIR/mcp-server" >/dev/null
  info "npm install (using lockfile)…"
  if [[ -f package-lock.json ]]; then
    run_or_print npm ci --no-audit --no-fund
  else
    run_or_print npm install --no-audit --no-fund
  fi
  info "npm run build…"
  run_or_print npm run build
  popd >/dev/null
  ok "mcp-server built"
fi

# ─── 3) migrations ───────────────────────────────────────────────────────────
step "3) database migrations"

if [[ "$SKIP_MIGRATIONS" -eq 1 ]]; then
  info "skipping migrations (--skip-migrations)"
elif [[ ! -x "$PROJECT_DIR/scripts/migrate.sh" ]] && [[ ! -f "$PROJECT_DIR/scripts/migrate.sh" ]]; then
  warn "scripts/migrate.sh not found — skipping"
else
  info "running scripts/migrate.sh (idempotent)…"
  run_or_print bash "$PROJECT_DIR/scripts/migrate.sh"
  ok "migrations applied"
fi

# ─── 4) ollama models ────────────────────────────────────────────────────────
step "4) ollama models"

if [[ "$SKIP_MODELS" -eq 1 ]]; then
  info "skipping model pulls (--skip-models)"
elif ! have ollama; then
  warn "ollama not installed — skipping model pulls"
else
  for model in nomic-embed-text qwen3:8b; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
      ok "$model already pulled"
    else
      info "pulling $model…"
      run_or_print ollama pull "$model" || warn "failed to pull $model — continue without it"
    fi
  done
fi

# ─── 5) reload services ──────────────────────────────────────────────────────
step "5) reload services"

reload_mac() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [[ ! -f "$plist" ]]; then
    info "no LaunchAgent for $label — skipping (run install.sh once if you want autostart)"
    return 0
  fi
  info "reloading $label"
  run_or_print launchctl unload "$plist" 2>/dev/null || true
  run_or_print launchctl load "$plist"
  ok "$label reloaded"
}

reload_linux() {
  local unit="$1"
  if ! systemctl --user list-unit-files "$unit" 2>/dev/null | grep -q "^$unit"; then
    info "no systemd-user unit for $unit — skipping"
    return 0
  fi
  info "restarting $unit"
  run_or_print systemctl --user daemon-reload
  run_or_print systemctl --user restart "$unit"
  ok "$unit restarted"
}

if [[ "$SKIP_SERVICES" -eq 1 ]]; then
  info "skipping service reload (--skip-services)"
else
  case "$OS" in
    mac)
      reload_mac "com.mycelium.dashboard"
      reload_mac "com.mycelium.middleware"
      ;;
    linux)
      reload_linux "mycelium-dashboard.service"
      reload_linux "mycelium-middleware.service"
      ;;
    *)
      warn "unknown OS — restart your mycelium services manually"
      ;;
  esac
fi

# ─── 6) summary ──────────────────────────────────────────────────────────────
step "6) done"

say ""
if [[ "$GIT_CHANGED" -eq 0 ]]; then
  ok "mycelium is up to date — nothing changed"
else
  ok "mycelium updated to $(git rev-parse --short HEAD) on $BRANCH"
fi
say ""
hint "dashboard:   http://127.0.0.1:8787"
hint "middleware:  http://127.0.0.1:18794/health"
hint "logs:        $PROJECT_DIR/.logs/"
say ""
hint "tip: restart your MCP client (Claude Code / Cursor / …) to pick up new tools"
say ""
