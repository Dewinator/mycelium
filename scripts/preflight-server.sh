#!/usr/bin/env bash
# preflight-server.sh — Wave 2 second-peer pre-flight checks.
#
# Operationalises the pre-flight bullets in docs/wave-2-second-peer.md so
# Reed can verify a rented server is ready BEFORE running install.sh. Each
# check prints a single ✓/⚠/✗ line; non-zero exit if any required check
# fails. All checks are read-only — nothing is installed or modified.
#
# Usage:
#   bash scripts/preflight-server.sh                # check local host
#   PEER_HOST=mycelium.example.org bash scripts/preflight-server.sh
#   PEER_HOST=… TARGET_DIR=/opt/mycelium bash scripts/preflight-server.sh
#
# Environment:
#   PEER_HOST    Optional FQDN — if set, DNS-resolves and probes outbound
#                connectivity from this host's perspective.
#   TARGET_DIR   Optional install dir — defaults to /opt/mycelium. Checked
#                for writability (parent must exist; dir itself may not).
#   SKIP_NET     Set to 1 to skip outbound HTTPS probes (offline runs).
#   STRICT_OPENSSL  Set to 1 to fail (not warn) if OpenSSL < 3.

set -euo pipefail

if [[ -t 1 ]] && [[ "${NO_COLOR:-}" != "1" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

ok()   { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; PASS=$((PASS + 1)); }
warn() { printf "${C_YELLOW}⚠${C_RESET} %s\n" "$*"; WARN=$((WARN + 1)); }
fail() { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; FAIL=$((FAIL + 1)); }
hint() { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }
section() { printf "\n${C_BOLD}${C_CYAN}── %s ──${C_RESET}\n" "$*"; }

PASS=0
WARN=0
FAIL=0

PEER_HOST="${PEER_HOST:-}"
TARGET_DIR="${TARGET_DIR:-/opt/mycelium}"
SKIP_NET="${SKIP_NET:-0}"
STRICT_OPENSSL="${STRICT_OPENSSL:-0}"

have() { command -v "$1" >/dev/null 2>&1; }

# ─── 1) OS ───────────────────────────────────────────────────────────────────
section "1) OS"
case "$(uname -s)" in
  Linux)
    ok "Linux ($(uname -r))"
    ;;
  Darwin)
    warn "macOS — fine for the local Mac, but the second peer is expected to be Linux"
    ;;
  *)
    fail "unsupported OS: $(uname -s)"
    ;;
esac

# ─── 2) Disk space (≥ 8 GB free at TARGET_DIR's filesystem) ─────────────────
section "2) Disk space"
parent="$(dirname "$TARGET_DIR")"
if [[ ! -d "$parent" ]]; then
  fail "parent dir '$parent' does not exist (cannot install into $TARGET_DIR)"
else
  if free_kb=$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 {print $4}'); then
    if [[ -n "$free_kb" ]] && [[ "$free_kb" =~ ^[0-9]+$ ]]; then
      free_gb=$(( free_kb / 1024 / 1024 ))
      if (( free_gb >= 8 )); then
        ok "${free_gb} GB free on $(df -P "$parent" | awk 'NR==2 {print $6}') (need ≥ 8)"
      else
        fail "only ${free_gb} GB free on $(df -P "$parent" | awk 'NR==2 {print $6}'); qwen3:8b alone is ~5 GB"
      fi
    else
      warn "could not parse df output for $parent"
    fi
  else
    warn "df failed on $parent"
  fi
fi

# ─── 3) RAM (≥ 8 GB) ─────────────────────────────────────────────────────────
section "3) RAM"
ram_gb=""
if [[ "$(uname -s)" == "Linux" ]] && [[ -r /proc/meminfo ]]; then
  ram_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  ram_gb=$(( ram_kb / 1024 / 1024 ))
elif [[ "$(uname -s)" == "Darwin" ]]; then
  # /usr/sbin is sometimes pruned from PATH (Claude Code agent shell, sudo);
  # sysctl on macOS lives there by default.
  sysctl_bin="$(command -v sysctl || true)"
  if [[ -z "$sysctl_bin" ]] && [[ -x /usr/sbin/sysctl ]]; then
    sysctl_bin=/usr/sbin/sysctl
  fi
  if [[ -n "$sysctl_bin" ]]; then
    ram_bytes=$("$sysctl_bin" -n hw.memsize 2>/dev/null || echo 0)
    ram_gb=$(( ram_bytes / 1024 / 1024 / 1024 ))
  fi
fi
if [[ -n "$ram_gb" ]] && (( ram_gb >= 8 )); then
  ok "${ram_gb} GB RAM (need ≥ 8)"
elif [[ -n "$ram_gb" ]]; then
  fail "${ram_gb} GB RAM; Docker (~500 MB) + qwen3:8b resident (~5 GB) needs ≥ 8 GB"
else
  warn "could not detect RAM size on this OS"
fi

# ─── 4) Target dir writable ─────────────────────────────────────────────────
section "4) Target dir"
if [[ -d "$TARGET_DIR" ]]; then
  if [[ -w "$TARGET_DIR" ]]; then
    ok "$TARGET_DIR exists and is writable"
  else
    fail "$TARGET_DIR exists but is not writable by $(id -un)"
  fi
elif [[ -d "$parent" ]] && [[ -w "$parent" ]]; then
  ok "parent $parent is writable; $TARGET_DIR will be created by install.sh"
else
  fail "neither $TARGET_DIR nor parent $parent is writable by $(id -un)"
  hint "consider \`sudo install -d -o $(id -un) $TARGET_DIR\` before running install.sh"
fi

# ─── 5) Outbound HTTPS ──────────────────────────────────────────────────────
section "5) Outbound HTTPS"
if [[ "$SKIP_NET" == "1" ]]; then
  warn "skipping network probes (SKIP_NET=1)"
else
  probe_url() {
    local url="$1" label="$2"
    if curl -fsS --max-time 8 -o /dev/null "$url" 2>/dev/null; then
      ok "$label reachable ($url)"
    else
      fail "$label unreachable ($url)"
    fi
  }
  if have curl; then
    probe_url "https://github.com" "GitHub"
    probe_url "https://registry.ollama.ai" "Ollama registry"
  else
    fail "curl not installed — cannot verify outbound HTTPS"
  fi
fi

# ─── 6) OpenSSL (Ed25519 needs OpenSSL ≥ 3, LibreSSL is rejected) ──────────
section "6) OpenSSL"
openssl_bin="${OPENSSL_BIN:-openssl}"
if have "$openssl_bin"; then
  version_line=$("$openssl_bin" version 2>/dev/null || true)
  case "$version_line" in
    "OpenSSL 3."*|"OpenSSL 4."*|"OpenSSL 5."*)
      ok "$openssl_bin → $version_line"
      ;;
    "OpenSSL "*)
      msg="$openssl_bin → $version_line; mTLS federation needs OpenSSL ≥ 3 for Ed25519"
      if [[ "$STRICT_OPENSSL" == "1" ]]; then fail "$msg"; else warn "$msg"; fi
      hint "set OPENSSL_BIN to a 3.x build (\`brew install openssl@3\`) before enabling MYCELIUM_FEATURE_FEDERATION"
      ;;
    "LibreSSL "*)
      msg="$openssl_bin is LibreSSL ($version_line); LibreSSL has no Ed25519 — rejected by federation cert init"
      if [[ "$STRICT_OPENSSL" == "1" ]]; then fail "$msg"; else warn "$msg"; fi
      hint "install OpenSSL 3.x and set OPENSSL_BIN — only matters for Wave-2 mTLS step 8 (deferred build)"
      ;;
    *)
      warn "$openssl_bin reported unknown version: ${version_line:-<empty>}"
      ;;
  esac
else
  warn "openssl not on PATH — install.sh installs Docker which doesn't require it, but the federation listener will"
fi

# ─── 7) PEER_HOST sanity (only when caller asserts one) ──────────────────────
section "7) PEER_HOST"
if [[ -z "$PEER_HOST" ]]; then
  warn "PEER_HOST not set — DNS + reverse-proxy checks skipped"
  hint "rerun with PEER_HOST=mycelium.example.org once the FQDN is provisioned"
else
  if have getent; then
    if getent hosts "$PEER_HOST" >/dev/null 2>&1; then
      ok "$PEER_HOST resolves: $(getent hosts "$PEER_HOST" | awk '{print $1}' | head -1)"
    else
      fail "$PEER_HOST does not resolve"
    fi
  elif have host; then
    if host "$PEER_HOST" >/dev/null 2>&1; then
      ok "$PEER_HOST resolves"
    else
      fail "$PEER_HOST does not resolve"
    fi
  else
    warn "neither getent nor host installed — cannot verify DNS"
  fi

  if [[ "$SKIP_NET" != "1" ]] && have curl; then
    # /.well-known/mycelium-node returns 503 until step 3 + restart, but
    # any HTTP response (even 404 / 503) means the reverse proxy and TLS
    # are wired. Connection refused / TLS failure is what we want to
    # catch here, not application-layer status codes.
    if curl -ksS --max-time 8 -o /dev/null -w '' "https://$PEER_HOST/" 2>/dev/null; then
      ok "https://$PEER_HOST/ accepts TLS handshakes"
    else
      warn "https://$PEER_HOST/ did not complete a TLS handshake — proxy/cert may not be live yet"
    fi
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
printf "\n"
printf "${C_BOLD}── summary ──${C_RESET}\n"
printf "  pass:  %d\n" "$PASS"
printf "  warn:  %d\n" "$WARN"
printf "  fail:  %d\n" "$FAIL"

if (( FAIL > 0 )); then
  printf "\n${C_RED}preflight: NOT READY${C_RESET} — resolve the ✗ items before running install.sh\n" >&2
  exit 1
fi
if (( WARN > 0 )); then
  printf "\n${C_YELLOW}preflight: ready with caveats${C_RESET} — review ⚠ items; install.sh will work but optional features may be limited\n"
  exit 0
fi
printf "\n${C_GREEN}preflight: READY${C_RESET} — go run install.sh\n"
exit 0
