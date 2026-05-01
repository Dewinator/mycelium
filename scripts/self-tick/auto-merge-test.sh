#!/usr/bin/env bash
# auto-merge-test.sh — unit tests for auto-merge.sh
#
# Mocks the `gh` CLI via PATH override and asserts that each safety gate
# (especially Constitution-Diff per issue #144 acceptance) refuses merge.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/auto-merge.sh"

if [[ ! -x "$SUT" ]]; then
  echo "FAIL: $SUT missing or not executable" >&2
  exit 1
fi

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

GH_BIN="$TMP_ROOT/gh"
LOG_FILE="$TMP_ROOT/automerge.log"
GH_FIXTURE_DIR="$TMP_ROOT/fixtures"
mkdir -p "$GH_FIXTURE_DIR"

# Mock gh: reads command + args, dispatches to fixture file by sub-command
# pattern. Tests pre-populate $GH_FIXTURE_DIR with the JSON each call should
# return.
cat >"$GH_BIN" <<'MOCK'
#!/usr/bin/env bash
# Fixture dispatcher. Args:
#   gh pr list --repo X --state open --json ... --limit ...        → pr-list.json
#   gh pr diff <num> --repo X                                       → pr-diff-<num>.txt
#   gh pr view <num> --repo X --json mergeable,mergeStateStatus     → pr-state-<num>.txt
#   gh pr view <num> --repo X --json comments --jq ...              → pr-comments-<num>.txt
#   gh pr view <num> --repo X --json mergeCommit --jq ...           → pr-merge-<num>.txt
#   gh pr merge <num> ...                                           → pr-merge-result-<num> (exit code)
sub="$1"; shift
case "$sub" in
  pr)
    op="$1"; shift
    case "$op" in
      list)
        cat "$GH_FIXTURE_DIR/pr-list.json"
        ;;
      diff)
        num="$1"
        cat "$GH_FIXTURE_DIR/pr-diff-$num.txt"
        ;;
      view)
        num="$1"
        # Pick the right fixture by which --json field the SUT requested.
        # mergeable+mergeStateStatus  → pre-merge fresh-state refresh
        # comments                    → HOLD-comment guard
        # mergeCommit (default)       → post-merge sha lookup
        if printf '%s\n' "$@" | grep -q 'mergeable'; then
          cat "$GH_FIXTURE_DIR/pr-state-$num.txt" 2>/dev/null \
            || printf '{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}\n'
        elif printf '%s\n' "$@" | grep -q 'comments'; then
          cat "$GH_FIXTURE_DIR/pr-comments-$num.txt" 2>/dev/null || true
        else
          cat "$GH_FIXTURE_DIR/pr-merge-$num.txt" 2>/dev/null || echo "abc1234"
        fi
        ;;
      merge)
        num="$1"
        rc_file="$GH_FIXTURE_DIR/pr-merge-result-$num"
        if [[ -f "$rc_file" ]]; then
          exit "$(cat "$rc_file")"
        fi
        exit 0
        ;;
    esac
    ;;
esac
MOCK
chmod +x "$GH_BIN"

PASSED=0
FAILED=0
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILED=$((FAILED+1)); }
pass() { printf 'PASS: %s\n' "$*"; PASSED=$((PASSED+1)); }

reset_fixtures() {
  rm -f "$GH_FIXTURE_DIR"/*
  : >"$LOG_FILE"
}

# Helper: write a single-PR list JSON.
write_pr_list() {
  local num="$1" labels_json="$2" mergeable="$3" state="$4" created="$5" title="${6:-test PR}"
  cat >"$GH_FIXTURE_DIR/pr-list.json" <<JSON
[{"number":$num,"title":"$title","headRefName":"agent/test","labels":$labels_json,"mergeable":"$mergeable","mergeStateStatus":"$state","createdAt":"$created"}]
JSON
}

run_sut() {
  PATH="$TMP_ROOT:$PATH" \
    GH_FIXTURE_DIR="$GH_FIXTURE_DIR" \
    MYCELIUM_REPO=Dewinator/mycelium \
    MYCELIUM_AUTOMERGE_LOG="$LOG_FILE" \
    bash "$SUT" "$@" 2>&1 || true
}

# Old timestamp = 2024 → always passes 30-min gate.
OLD_TS="2024-01-01T00:00:00Z"
NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Test 1: Constitution-Diff blocks a PR with CLAUDE.md changes (issue #144 acceptance)
reset_fixtures
write_pr_list 100 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-100.txt" <<'DIFF'
diff --git a/CLAUDE.md b/CLAUDE.md
index 1234..5678 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,3 +1,4 @@
 # CLAUDE.md
+## Compromised
 ## Projektziel
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-100.txt"
out=$(run_sut --execute)
if grep -q "PR #100  skip: Constitution-Diff" "$LOG_FILE"; then
  pass "Constitution-Diff blocks PR touching CLAUDE.md"
else
  fail "Constitution-Diff did NOT block CLAUDE.md change"
  printf '%s\n' "$out"
  cat "$LOG_FILE"
fi

# Test 2: clean diff (no CLAUDE.md) is not blocked by Constitution-Diff
reset_fixtures
write_pr_list 101 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-101.txt" <<'DIFF'
diff --git a/scripts/foo.sh b/scripts/foo.sh
index 1234..5678 100644
--- a/scripts/foo.sh
+++ b/scripts/foo.sh
@@ -1 +1,2 @@
 echo hi
+echo world
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-101.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #101  WOULD-MERGE (dry-run)" "$LOG_FILE"; then
  pass "Clean diff passes Constitution-Diff in dry-run"
else
  fail "Clean diff should have produced WOULD-MERGE"
  cat "$LOG_FILE"
fi

# Test 3: line-anchored HOLD comment blocks merge
reset_fixtures
write_pr_list 102 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-102.txt" <<'DIFF'
diff --git a/x b/x
index 1..2 100644
--- a/x
+++ b/x
@@ -0,0 +1 @@
+x
DIFF
printf 'HOLD: needs design review before merging\n' >"$GH_FIXTURE_DIR/pr-comments-102.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #102  skip: HOLD comment present" "$LOG_FILE"; then
  pass "Line-anchored HOLD comment blocks merge"
else
  fail "Line-anchored HOLD comment did NOT block merge"
  cat "$LOG_FILE"
fi

# Test 4: agent-do-not-touch blocks merge
reset_fixtures
write_pr_list 103 '[{"name":"agent-eligible"},{"name":"agent-do-not-touch"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-103.txt" <<'DIFF'
diff --git a/x b/x
@@ -0,0 +1 @@
+x
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-103.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #103  skip: agent-do-not-touch" "$LOG_FILE"; then
  pass "agent-do-not-touch blocks merge"
else
  fail "agent-do-not-touch did NOT block merge"
  cat "$LOG_FILE"
fi

# Test 5: missing agent-eligible label is skipped
reset_fixtures
write_pr_list 104 '[]' MERGEABLE CLEAN "$OLD_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-104.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-104.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #104  skip: not agent-eligible" "$LOG_FILE"; then
  pass "Non-agent-eligible PR is skipped"
else
  fail "Non-agent-eligible PR should have been skipped"
  cat "$LOG_FILE"
fi

# Test 6: dirty merge state is skipped
reset_fixtures
write_pr_list 105 '[{"name":"agent-eligible"}]' CONFLICTING DIRTY "$OLD_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-105.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-105.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #105  skip: mergeable=CONFLICTING" "$LOG_FILE"; then
  pass "Dirty merge state is skipped"
else
  fail "Dirty merge state should have been skipped"
  cat "$LOG_FILE"
fi

# Test 7: too-young PR is skipped (cooldown)
reset_fixtures
write_pr_list 106 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$NOW_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-106.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-106.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #106  skip: too young" "$LOG_FILE"; then
  pass "Too-young PR is skipped (cooldown)"
else
  fail "Too-young PR should have been skipped"
  cat "$LOG_FILE"
fi

# Test 8: comment merely discussing HOLD in prose does NOT block (regression
# guard for the bug where ``no `HOLD` comment ✓`` falsely blocked PR #158).
reset_fixtures
write_pr_list 107 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-107.txt" <<'DIFF'
diff --git a/x b/x
@@ -0,0 +1 @@
+x
DIFF
printf '## Validation\n\nAll six guards fire as designed: no `HOLD` comment ✓, no CLAUDE.md touched ✓.\n' >"$GH_FIXTURE_DIR/pr-comments-107.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #107  WOULD-MERGE" "$LOG_FILE"; then
  pass "Comment that mentions HOLD in prose does NOT block"
else
  fail "Comment mentioning HOLD in prose should NOT have blocked merge"
  cat "$LOG_FILE"
fi

# Test 9: stale snapshot — PR was MERGEABLE/CLEAN at run start but flipped
# CONFLICTING by the time we'd merge it (e.g. earlier merge in this run
# touched the same migration slot). Pre-merge fresh-state refresh must
# catch it and skip cleanly instead of letting `gh pr merge` fail noisily.
# Only fires under --execute; dry-run trusts the snapshot.
reset_fixtures
write_pr_list 108 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-108.txt" <<'DIFF'
diff --git a/x b/x
@@ -0,0 +1 @@
+x
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-108.txt"
# Fresh state went stale between snapshot and merge.
printf '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}\n' >"$GH_FIXTURE_DIR/pr-state-108.txt"
run_sut --execute >/dev/null
if grep -q "PR #108  skip: state went stale" "$LOG_FILE"; then
  pass "Stale-snapshot PR is caught by pre-merge refresh under --execute"
else
  fail "Stale-snapshot PR should have been skipped pre-merge"
  cat "$LOG_FILE"
fi

# Test 10: dry-run trusts the snapshot — even with a stale fixture present,
# dry-run should still WOULD-MERGE because no merges land in dry-run, so
# cached state is accurate by definition.
reset_fixtures
write_pr_list 109 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-109.txt" <<'DIFF'
diff --git a/x b/x
@@ -0,0 +1 @@
+x
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-109.txt"
printf '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}\n' >"$GH_FIXTURE_DIR/pr-state-109.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #109  WOULD-MERGE" "$LOG_FILE" \
   && ! grep -q "PR #109  skip: state went stale" "$LOG_FILE"; then
  pass "Dry-run skips the fresh-state refresh"
else
  fail "Dry-run should not have called the fresh-state refresh"
  cat "$LOG_FILE"
fi

# Test 11: --pr <num> scopes the run to a single PR. The list contains
# three eligible PRs but the SUT only considers the targeted one.
reset_fixtures
cat >"$GH_FIXTURE_DIR/pr-list.json" <<JSON
[
  {"number":200,"title":"target","headRefName":"agent/a","labels":[{"name":"agent-eligible"}],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","createdAt":"$OLD_TS"},
  {"number":201,"title":"sibling-1","headRefName":"agent/b","labels":[{"name":"agent-eligible"}],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","createdAt":"$OLD_TS"},
  {"number":202,"title":"sibling-2","headRefName":"agent/c","labels":[{"name":"agent-eligible"}],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","createdAt":"$OLD_TS"}
]
JSON
cat >"$GH_FIXTURE_DIR/pr-diff-200.txt" <<'DIFF'
diff --git a/x b/x
@@ -0,0 +1 @@
+x
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-200.txt"
run_sut --pr 200 --dry-run >/dev/null
if grep -q "PR #200  WOULD-MERGE" "$LOG_FILE" \
   && ! grep -q "PR #201" "$LOG_FILE" \
   && ! grep -q "PR #202" "$LOG_FILE" \
   && grep -q "scope=pr=200" "$LOG_FILE" \
   && grep -q "considered=1" "$LOG_FILE"; then
  pass "--pr scopes the run to a single PR"
else
  fail "--pr should have scoped to PR #200 only"
  cat "$LOG_FILE"
fi

# Test 12: --pr <num> against a list that does not contain that number is a
# clean no-op (considered=0, merged=0, no error).
reset_fixtures
write_pr_list 210 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-210.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-210.txt"
run_sut --pr 999 --dry-run >/dev/null
if grep -q "considered=0" "$LOG_FILE" \
   && grep -q "scope=pr=999" "$LOG_FILE" \
   && ! grep -q "PR #210" "$LOG_FILE"; then
  pass "--pr <missing-num> is a clean no-op"
else
  fail "--pr 999 should have produced considered=0"
  cat "$LOG_FILE"
fi

# Test 13: --pr without a numeric arg fails with usage error
reset_fixtures
write_pr_list 211 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-211.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-211.txt"
out=$(PATH="$TMP_ROOT:$PATH" \
  GH_FIXTURE_DIR="$GH_FIXTURE_DIR" \
  MYCELIUM_REPO=Dewinator/mycelium \
  MYCELIUM_AUTOMERGE_LOG="$LOG_FILE" \
  bash "$SUT" --pr abc --dry-run 2>&1; echo "rc=$?")
if printf '%s' "$out" | grep -q "rc=2" \
   && printf '%s' "$out" | grep -q "requires a numeric PR number"; then
  pass "--pr <non-numeric> fails with rc=2"
else
  fail "--pr abc should have exited with rc=2 + usage message"
  printf '%s\n' "$out"
fi

# Test 14: UNSTABLE mergeStateStatus is skipped (failing checks). Test 6 covers
# DIRTY/CONFLICTING; UNSTABLE is the trickier state — branch is mergeable but
# CI is red. The gate's `state != CLEAN` check rejects it implicitly; this
# pins that behaviour so a future loosened-equality refactor can't silently
# auto-merge PRs whose tests are failing.
reset_fixtures
write_pr_list 112 '[{"name":"agent-eligible"}]' MERGEABLE UNSTABLE "$OLD_TS"
echo "" >"$GH_FIXTURE_DIR/pr-diff-112.txt"
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-112.txt"
run_sut --dry-run >/dev/null
if grep -q "PR #112  skip: mergeable=MERGEABLE mergeStateStatus=UNSTABLE" "$LOG_FILE"; then
  pass "UNSTABLE merge state (failing CI) is skipped"
else
  fail "UNSTABLE merge state should have been skipped"
  cat "$LOG_FILE"
fi

# Test 15: Constitution-Diff also blocks PRs that modify CONSTITUTION.md.
# The script's guard is named "Constitution-Diff" but originally only refused
# CLAUDE.md, leaving the actual Six-Pillars file unguarded. CONSTITUTION.md
# itself says: "A PR that modifies this file and is authored by an agent
# must be closed without merge." This pins that the guard now lives up to
# its name — a future loosening that drops CONSTITUTION.md from the regex
# would silently re-open the hole.
reset_fixtures
write_pr_list 113 '[{"name":"agent-eligible"}]' MERGEABLE CLEAN "$OLD_TS"
cat >"$GH_FIXTURE_DIR/pr-diff-113.txt" <<'DIFF'
diff --git a/CONSTITUTION.md b/CONSTITUTION.md
index 1234..5678 100644
--- a/CONSTITUTION.md
+++ b/CONSTITUTION.md
@@ -13,7 +13,7 @@
 ## The Six Pillars

-### 1. Decentralized, networked AI
+### 1. Centralized, cloud-hosted AI
DIFF
echo "[]" >"$GH_FIXTURE_DIR/pr-comments-113.txt"
run_sut --execute >/dev/null
if grep -q "PR #113  skip: Constitution-Diff" "$LOG_FILE"; then
  pass "Constitution-Diff blocks PR touching CONSTITUTION.md"
else
  fail "Constitution-Diff did NOT block CONSTITUTION.md change"
  cat "$LOG_FILE"
fi

printf '\n'
printf 'auto-merge tests: %d passed, %d failed\n' "$PASSED" "$FAILED"
if (( FAILED > 0 )); then
  exit 1
fi
