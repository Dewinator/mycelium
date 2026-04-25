#!/usr/bin/env bash
# install.sh — one-liner bootstrap for mycelium on macOS and Linux.
#
# Usage:
#   curl -sSf https://raw.githubusercontent.com/Dewinator/mycelium/main/install.sh | bash
#   bash install.sh [options]
#
# Options:
#   --yes               assume "yes" for all prompts (non-interactive)
#   --no-autostart      do not register a launchd / systemd service
#   --target DIR        install directory (default: ./mycelium)
#   --branch BRANCH     git branch to check out (default: main)
#   --skip-models       skip ollama model pulls
#   --skip-docker       skip docker container start (use external Postgres)
#   --print-only        only print what *would* be done, never execute installs
#   --help              show this help
#
# Environment overrides:
#   MYCELIUM_REPO_URL   default https://github.com/Dewinator/mycelium.git
#
# This script never silently sudos. Every elevated step asks first.

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
NO_AUTOSTART=0
SKIP_MODELS=0
SKIP_DOCKER=0
PRINT_ONLY=0
TARGET_DIR="${PWD}/mycelium"
BRANCH="main"
REPO_URL="${MYCELIUM_REPO_URL:-https://github.com/Dewinator/mycelium.git}"

# ─── arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)            ASSUME_YES=1 ;;
    --no-autostart)   NO_AUTOSTART=1 ;;
    --skip-models)    SKIP_MODELS=1 ;;
    --skip-docker)    SKIP_DOCKER=1 ;;
    --print-only)     PRINT_ONLY=1 ;;
    --target)         shift; TARGET_DIR="$1" ;;
    --branch)         shift; BRANCH="$1" ;;
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
  # ask_yes_no "Question?" → returns 0 for yes, 1 for no
  local q="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then return 0; fi
  printf "${C_BOLD}?${C_RESET} %s [y/N] " "$q"
  local ans
  read -r ans </dev/tty || ans="n"
  [[ "$ans" =~ ^[YyJj] ]]
}

run_or_print() {
  # If --print-only, just print the command. Otherwise execute it.
  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    printf "${C_DIM}$ %s${C_RESET}\n" "$*"
    return 0
  fi
  "$@"
}

# ─── OS detection ────────────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin) OS="mac" ;;
    Linux)
      OS="linux"
      if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        DISTRO="${ID:-unknown}"
        DISTRO_LIKE="${ID_LIKE:-}"
      else
        DISTRO="unknown"; DISTRO_LIKE=""
      fi
      ;;
    *)
      err "unsupported OS: $(uname -s) — install.sh covers macOS and Linux. Windows users: see install.ps1 (planned)."
      exit 1 ;;
  esac
  ARCH="$(uname -m)"
}

# Per-OS install command for a known dependency.
install_command_for() {
  local dep="$1"
  case "$OS:$dep" in
    mac:git)        echo "xcode-select --install   # or: brew install git" ;;
    mac:node)       echo "brew install node" ;;
    mac:docker)     echo "brew install --cask docker   # then launch Docker.app once" ;;
    mac:psql)       echo "brew install libpq && brew link --force libpq" ;;
    mac:ollama)     echo "brew install ollama" ;;

    linux:git)      install_command_linux git git ;;
    linux:node)     echo "see https://nodejs.org/en/download/package-manager (we won't pick a Node manager for you)" ;;
    linux:docker)   echo "see https://docs.docker.com/engine/install/ — the convenience script there is the most portable path" ;;
    linux:psql)     install_command_linux postgresql-client postgresql ;;
    linux:ollama)   echo "curl -fsSL https://ollama.com/install.sh | sh" ;;

    *) echo "(no canned install command — see upstream docs)" ;;
  esac
}

install_command_linux() {
  # arg1 = debian/ubuntu pkg, arg2 = fedora pkg
  local deb="$1" rpm="$2"
  case "${DISTRO}:${DISTRO_LIKE}" in
    debian:*|ubuntu:*|*:*debian*|*:*ubuntu*) echo "sudo apt-get update && sudo apt-get install -y $deb" ;;
    fedora:*|rhel:*|centos:*|*:*fedora*|*:*rhel*) echo "sudo dnf install -y $rpm" ;;
    arch:*|*:*arch*) echo "sudo pacman -S --noconfirm $deb" ;;
    *) echo "(install '$deb' or '$rpm' via your distro's package manager)" ;;
  esac
}

# ─── dependency check ────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

# Returns 0 if Node is >= 20, 1 otherwise.
node_version_ok() {
  have node || return 1
  local major
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
  [[ "$major" -ge 20 ]]
}

check_dep() {
  local dep="$1" label="$2" required="$3"   # required = required|recommended
  local present=0
  if [[ "$dep" == "node" ]]; then
    if node_version_ok; then present=1; fi
  elif [[ "$dep" == "docker" ]]; then
    if have docker && docker compose version >/dev/null 2>&1; then present=1; fi
  else
    if have "$dep"; then present=1; fi
  fi

  if [[ "$present" -eq 1 ]]; then
    ok "$label"
    return 0
  fi

  if [[ "$required" == "required" ]]; then
    warn "$label is missing"
  else
    warn "$label is missing (recommended)"
  fi
  hint "install: $(install_command_for "$dep")"
  MISSING+=("$dep:$label:$required")
  return 1
}

# ─── steps ───────────────────────────────────────────────────────────────────
step_banner() {
  cat <<'BANNER'

   ╔══════════════════════════════════════════╗
   ║   mycelium  —  real open AI              ║
   ║   one-liner installer (mac / linux)      ║
   ╚══════════════════════════════════════════╝
BANNER
}

step_check_deps() {
  step "1) checking dependencies"
  MISSING=()
  check_dep git    "git"                            "required" || true
  if [[ "$SKIP_DOCKER" -eq 0 ]]; then
    check_dep docker "docker + compose plugin"      "required" || true
  else
    info "skipping docker check (--skip-docker)"
  fi
  check_dep node   "node ≥ 20"                      "required" || true
  check_dep psql   "psql client (for migrations)"   "required" || true
  check_dep ollama "ollama (for embeddings)"        "recommended" || true

  local missing_required=0
  for entry in "${MISSING[@]:-}"; do
    [[ -z "$entry" ]] && continue
    local req="${entry##*:}"
    if [[ "$req" == "required" ]]; then missing_required=1; fi
  done

  if [[ "${#MISSING[@]}" -eq 0 ]]; then
    ok "all dependencies present"
    return 0
  fi

  say ""
  if [[ "$missing_required" -eq 1 ]]; then
    err "required dependencies are missing — see hints above for the install commands."
    say ""
    if ask_yes_no "show the exact commands and exit so you can run them yourself?"; then
      for entry in "${MISSING[@]}"; do
        local dep label req
        dep="${entry%%:*}"
        rest="${entry#*:}"
        label="${rest%:*}"
        req="${rest##*:}"
        printf "  %s\n" "$(install_command_for "$dep")"
      done
      say ""
      info "rerun install.sh once dependencies are in place."
      exit 0
    else
      err "aborting — please install the missing required dependencies first."
      exit 1
    fi
  else
    warn "only recommended dependencies missing — continuing without them."
  fi
}

step_clone() {
  step "2) source code"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    info "existing checkout at $TARGET_DIR — pulling latest on $BRANCH"
    run_or_print git -C "$TARGET_DIR" fetch origin
    run_or_print git -C "$TARGET_DIR" checkout "$BRANCH"
    run_or_print git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH"
    ok "repository up to date"
  elif [[ -d "$TARGET_DIR" && -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
    err "target directory exists and is not empty: $TARGET_DIR"
    err "pick another with --target or move the existing folder out of the way."
    exit 1
  else
    info "cloning $REPO_URL → $TARGET_DIR (branch: $BRANCH)"
    run_or_print git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
    ok "cloned"
  fi
}

step_setup() {
  step "3) running scripts/setup.sh (docker + .env + migrations + build)"
  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    hint "would run: bash $TARGET_DIR/scripts/setup.sh"
    return 0
  fi
  if [[ "$SKIP_DOCKER" -eq 1 ]]; then
    info "skipping setup.sh (you opted out of docker; configure docker/.env and run migrations manually)"
    return 0
  fi
  ( cd "$TARGET_DIR" && bash scripts/setup.sh )
  ok "setup.sh complete"
}

step_models() {
  step "4) ollama models"
  if [[ "$SKIP_MODELS" -eq 1 ]]; then
    info "skipping model pulls (--skip-models)"
    return 0
  fi
  if ! have ollama; then
    warn "ollama not installed — skipping model pulls. Install ollama, then run: ollama pull nomic-embed-text"
    return 0
  fi
  for model in nomic-embed-text qwen3:8b; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
      ok "$model already pulled"
    else
      info "pulling $model (this may take a few minutes)…"
      run_or_print ollama pull "$model" || warn "failed to pull $model — continue without it"
    fi
  done
}

step_autostart_mac() {
  local plist_path="$HOME/Library/LaunchAgents/com.mycelium.dashboard.plist"
  local node_bin
  node_bin="$(command -v node)"
  if [[ -f "$plist_path" ]]; then
    ok "LaunchAgent already exists: $plist_path"
    return 0
  fi
  info "writing LaunchAgent → $plist_path"
  mkdir -p "$(dirname "$plist_path")"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mycelium.dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$TARGET_DIR/scripts/dashboard-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$TARGET_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TARGET_DIR/.logs/dashboard.out.log</string>
  <key>StandardErrorPath</key><string>$TARGET_DIR/.logs/dashboard.err.log</string>
</dict>
</plist>
PLIST
  mkdir -p "$TARGET_DIR/.logs"
  launchctl unload "$plist_path" 2>/dev/null || true
  launchctl load "$plist_path"
  ok "dashboard service running on http://127.0.0.1:8787"
}

step_autostart_linux() {
  local unit_path="$HOME/.config/systemd/user/mycelium-dashboard.service"
  local node_bin
  node_bin="$(command -v node)"
  if [[ -f "$unit_path" ]]; then
    ok "systemd-user unit already exists: $unit_path"
    return 0
  fi
  info "writing systemd-user unit → $unit_path"
  mkdir -p "$(dirname "$unit_path")"
  cat > "$unit_path" <<UNIT
[Unit]
Description=mycelium dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
ExecStart=$node_bin $TARGET_DIR/scripts/dashboard-server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now mycelium-dashboard.service
  ok "dashboard service running on http://127.0.0.1:8787"
  hint "tip: 'systemctl --user status mycelium-dashboard' to inspect."
}

step_autostart() {
  step "5) auto-start"
  if [[ "$NO_AUTOSTART" -eq 1 ]]; then
    info "skipping auto-start (--no-autostart)"
    return 0
  fi
  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    hint "would install $OS auto-start unit pointing at $TARGET_DIR/scripts/dashboard-server.mjs"
    return 0
  fi
  case "$OS" in
    mac)   step_autostart_mac ;;
    linux) step_autostart_linux ;;
  esac
}

step_final() {
  step "6) wire it into your agent"
  cat <<EOF

   mycelium is installed at: ${C_BOLD}$TARGET_DIR${C_RESET}
   dashboard:                ${C_BOLD}http://127.0.0.1:8787${C_RESET}
   setup page (per-client):  ${C_BOLD}http://127.0.0.1:8787/setup${C_RESET}

   The setup page lists copy-paste config snippets for Claude Code,
   Claude Desktop, Codex, Cursor, Cline, Continue, Zed and openClaw.

   Quick example — Claude Code (~/.claude.json):

       {
         "mcpServers": {
           "mycelium": {
             "command": "node",
             "args": ["$TARGET_DIR/mcp-server/dist/index.js"]
           }
         }
       }

   Then restart your agent. ${C_GREEN}Done.${C_RESET}

EOF
}

# ─── main ────────────────────────────────────────────────────────────────────
main() {
  step_banner
  detect_os
  info "detected: ${C_BOLD}$OS${C_RESET} ($ARCH)${DISTRO:+, distro: ${C_BOLD}$DISTRO${C_RESET}}"
  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    warn "running in --print-only mode: no installs, no clones, no service registration"
  fi
  step_check_deps
  step_clone
  step_setup
  step_models
  step_autostart
  step_final
}

main "$@"
