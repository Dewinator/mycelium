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
#   gh pr list --repo X --state open --json ... --limit ...   → pr-list.json
#   gh pr diff <num> --repo X                                  → pr-diff-<num>.txt
#   gh pr view <num> --repo X --json comments --jq ...         → pr-comments-<num>.txt
#   gh pr view <num> --repo X --json mergeCommit --jq ...      → pr-merge-<num>.txt
#   gh pr merge <num> ...                                      → pr-merge-result-<num> (exit code)
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
        # detect comments-vs-mergecommit by looking for --json comments / mergeCommit
        if printf '%s\n' "$@" | grep -q 'comments'; then
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

printf '\n'
printf 'auto-merge tests: %d passed, %d failed\n' "$PASSED" "$FAILED"
if (( FAILED > 0 )); then
  exit 1
fi
