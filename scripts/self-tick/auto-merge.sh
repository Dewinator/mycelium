#!/usr/bin/env bash
# auto-merge.sh — auto-merge agent-eligible PRs that pass safety checks.
#
# Closes the loop on issue #144: the autonomy tick opens PRs faster than Reed
# can review by hand. This runs out-of-band from the tick (separate plist or
# manual invocation) and squash-merges PRs that satisfy ALL six conditions:
#
#   1. has the `agent-eligible` label
#   2. lacks the `agent-do-not-touch` label
#   3. mergeable=MERGEABLE AND mergeStateStatus=CLEAN
#   4. >=30 minutes old (window for Reed to intervene)
#   5. no comment body contains the literal token "HOLD"
#   6. Constitution-Diff: PR diff does NOT touch `CLAUDE.md`
#
# After any merges land, runs `scripts/migrate.sh` and `npm run build` so a
# stale local DB / dist doesn't bite the next tick.
#
# SAFE BY DEFAULT: dry-run unless --execute is passed or
# MYCELIUM_AUTOMERGE_ENABLED=1 is set in the environment.

set -euo pipefail

REPO="${MYCELIUM_REPO:-Dewinator/mycelium}"
COOLDOWN_SECONDS="${MYCELIUM_AUTOMERGE_COOLDOWN:-1800}"
LOG_FILE="${MYCELIUM_AUTOMERGE_LOG:-$HOME/Library/Logs/mycelium-automerge.log}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DRY_RUN=true

for arg in "$@"; do
  case "$arg" in
    --execute) DRY_RUN=false ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *)
      echo "auto-merge.sh: unknown arg '$arg' (try --help)" >&2
      exit 2 ;;
  esac
done

if [[ "${MYCELIUM_AUTOMERGE_ENABLED:-0}" == "1" ]]; then
  DRY_RUN=false
fi

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2
}

# Constitution-Diff guard. Conservative: any change to `CLAUDE.md` blocks the
# merge. Reed merges those by hand. The issue spec scoped this to "Core
# Pillars / Roadmap sections" but byte-exact section detection across diff
# context is brittle — refusing the whole file is the safe simplification.
constitution_diff_blocked() {
  local pr_num="$1"
  local diff
  diff=$(gh pr diff "$pr_num" --repo "$REPO" 2>/dev/null) || return 1
  if printf '%s\n' "$diff" | grep -Eq '^diff --git a/CLAUDE\.md b/CLAUDE\.md'; then
    return 0  # blocked
  fi
  return 1
}

hold_comment_present() {
  local pr_num="$1"
  local bodies
  bodies=$(gh pr view "$pr_num" --repo "$REPO" --json comments --jq '.comments[].body' 2>/dev/null) || return 1
  printf '%s\n' "$bodies" | grep -Fq 'HOLD'
}

iso_to_epoch() {
  local iso="$1"
  if command -v gdate >/dev/null 2>&1; then
    gdate -d "$iso" +%s
  else
    date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null
  fi
}

merge_one() {
  local pr_num="$1" pr_title="$2"
  if [[ "$DRY_RUN" == "true" ]]; then
    log "PR #$pr_num  WOULD-MERGE (dry-run): $pr_title"
    return 0
  fi
  log "PR #$pr_num  MERGING: $pr_title"
  if gh pr merge "$pr_num" --repo "$REPO" --squash --delete-branch; then
    local sha
    sha=$(gh pr view "$pr_num" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || echo unknown)
    log "PR #$pr_num  MERGED: commit=$sha"
    return 0
  else
    log "PR #$pr_num  MERGE-FAILED: gh pr merge returned non-zero"
    return 1
  fi
}

post_merge_actions() {
  log "post-merge: pulling main"
  (cd "$REPO_ROOT" && git fetch origin main --quiet && git checkout main --quiet && git pull --ff-only origin main --quiet) || {
    log "post-merge: git pull failed — skipping migrate/build"
    return 1
  }
  log "post-merge: applying migrations"
  if (cd "$REPO_ROOT/scripts" && bash migrate.sh >>"$LOG_FILE" 2>&1); then
    log "post-merge: migrations applied"
  else
    log "post-merge: migrate.sh FAILED (see log)"
  fi
  log "post-merge: building mcp-server"
  if (cd "$REPO_ROOT/mcp-server" && npm run build >>"$LOG_FILE" 2>&1); then
    log "post-merge: build OK"
  else
    log "post-merge: npm run build FAILED (see log)"
  fi
}

run_auto_merge() {
  local pr_list_json now_ts merged=0 considered=0
  pr_list_json=$(gh pr list --repo "$REPO" --state open \
    --json number,title,headRefName,labels,mergeable,mergeStateStatus,createdAt \
    --limit 50)
  now_ts=$(date -u +%s)

  local mode_label="DRY-RUN"
  [[ "$DRY_RUN" == "true" ]] || mode_label="EXECUTE"
  log "auto-merge run starting  mode=$mode_label  repo=$REPO"

  while read -r pr; do
    considered=$((considered + 1))
    local num title mergeable state created
    num=$(printf '%s' "$pr" | jq -r '.number')
    title=$(printf '%s' "$pr" | jq -r '.title')
    mergeable=$(printf '%s' "$pr" | jq -r '.mergeable')
    state=$(printf '%s' "$pr" | jq -r '.mergeStateStatus')
    created=$(printf '%s' "$pr" | jq -r '.createdAt')
    local has_eligible has_donottouch
    has_eligible=$(printf '%s' "$pr" | jq -r '[.labels[].name] | contains(["agent-eligible"])')
    has_donottouch=$(printf '%s' "$pr" | jq -r '[.labels[].name] | contains(["agent-do-not-touch"])')

    if [[ "$has_eligible" != "true" ]]; then
      log "PR #$num  skip: not agent-eligible"
      continue
    fi
    if [[ "$has_donottouch" == "true" ]]; then
      log "PR #$num  skip: agent-do-not-touch label set"
      continue
    fi
    if [[ "$mergeable" != "MERGEABLE" || "$state" != "CLEAN" ]]; then
      log "PR #$num  skip: mergeable=$mergeable mergeStateStatus=$state"
      continue
    fi

    local pr_ts age
    pr_ts=$(iso_to_epoch "$created" || echo 0)
    if [[ "$pr_ts" == "0" || -z "$pr_ts" ]]; then
      log "PR #$num  skip: could not parse createdAt='$created'"
      continue
    fi
    age=$((now_ts - pr_ts))
    if (( age < COOLDOWN_SECONDS )); then
      log "PR #$num  skip: too young ($age s < $COOLDOWN_SECONDS s)"
      continue
    fi
    if hold_comment_present "$num"; then
      log "PR #$num  skip: HOLD comment present"
      continue
    fi
    if constitution_diff_blocked "$num"; then
      log "PR #$num  skip: Constitution-Diff (CLAUDE.md touched)"
      continue
    fi

    if merge_one "$num" "$title"; then
      [[ "$DRY_RUN" == "true" ]] || merged=$((merged + 1))
    fi
  done < <(printf '%s' "$pr_list_json" | jq -c '.[]')

  log "auto-merge run done  considered=$considered  merged=$merged"

  if (( merged > 0 )); then
    post_merge_actions || true
  fi
}

# Run only when executed directly. When sourced (e.g. by tests), only the
# functions above are exported and the main loop stays inert.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_auto_merge
fi
