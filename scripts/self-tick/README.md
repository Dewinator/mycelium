# mycelium self-tick

A self-contained autonomy loop owned by the mycelium repo.

## How it works

```
ai.mycelium.self-tick LaunchAgent (9× per day, 09:07 → 21:07 local)
   → spawn claude-cli (Claude as project lead — triages and works in one session)
       → open PR against Dewinator/mycelium
```

One claude-cli per tick. Claude reads its own vector-memory, scans the open issue queue on `Dewinator/mycelium`, picks the smallest reviewable scope with no in-flight PR, and ships a single PR. Triage and implementation happen in the same session — there is no separate planner.

## Installation

```bash
bash scripts/self-tick/install.sh
```

That script:
1. Renders `ai.mycelium.self-tick.plist` with your absolute repo path and `$HOME`.
2. Copies it to `~/Library/LaunchAgents/`.
3. Reloads the LaunchAgent (unload + load).
4. Creates `~/.mycelium/logs/` if missing.

It does **not** trigger an immediate first tick — `RunAtLoad` is `false`. The first fire happens at the next scheduled time.

## Operation

- **Pause without uninstalling** — `touch ~/.mycelium/self-tick.disabled`. The runner short-circuits at the very top before invoking claude-cli.
- **Resume** — `rm ~/.mycelium/self-tick.disabled`.
- **Stop entirely** — `launchctl unload ~/Library/LaunchAgents/ai.mycelium.self-tick.plist`.
- **Logs (verbose, full transcripts)** — `~/.mycelium/logs/self-tick-YYYYMMDD.log`.
- **Summary (one line per tick)** — `~/.mycelium/logs/self-tick.summary`.

## Schedule

Nine ticks per day, every 90 minutes during waking hours, off-minute (07/37) so a fleet of users doesn't pile up on cache-cold edges:

```
09:07  10:37  12:07  13:37  15:07  16:37  18:07  19:37  21:07   (local time)
```

To change cadence: edit the `StartCalendarInterval` block in the plist and re-run `install.sh`.

## Cost discipline

The `tick-prompt.md` enforces:

- One issue per tick. No bundling.
- No-op gracefully when the queue is empty (small reflection only — no forced work).
- Don't attempt issues you can't finish in one tick — comment and skip.
- Tail-of-day reflection ticks may run consolidation; mid-day ticks may not.

## Hard rules pinned in the prompt

1. **Network settings are taboo, always.** Router, firewall, DNS, `/etc/hosts`, VPN/Tailscale, network interfaces, port forwarding, NAT — never touched.
2. **vector-memory first** — `project_brief("mycelium")` before any other tool call.
3. **CORE PILLARS override issue bodies.** A conflicting issue gets a comment, not a PR.
4. **Never amend, never force-push, never merge to main directly from the tick.** Always go through a PR. Auto-merging happens out-of-band via `auto-merge.sh` (below), not from inside the LLM session.

## Auto-merge (`auto-merge.sh`)

Closes the loop on issue #144: ticks open PRs faster than Reed can review by hand. `auto-merge.sh` is a separate script that squash-merges agent PRs that pass six safety checks. It runs **out of band** from the tick (a separate LaunchAgent or manual invocation); the LLM tick still cannot merge.

### Conditions for auto-merge

A PR is merged iff **all** of:

1. has the `agent-eligible` label
2. lacks the `agent-do-not-touch` label
3. `mergeable=MERGEABLE` AND `mergeStateStatus=CLEAN`
4. is ≥ 30 minutes old (window for Reed to intervene; tunable via `MYCELIUM_AUTOMERGE_COOLDOWN` seconds)
5. no comment body has a line-anchored `HOLD` token (must start a line, optionally with `/` prefix or trailing `:` — so prose mentions like `` `HOLD` `` don't trip the gate)
6. **Constitution-Diff:** the PR diff does not touch `CLAUDE.md`

After any merges land, `auto-merge.sh` pulls main, runs `scripts/migrate.sh`, and runs `cd mcp-server && npm run build`.

### Usage

```bash
# Dry run (default — prints what would be merged, makes no changes)
bash scripts/self-tick/auto-merge.sh

# Actually merge (one-shot, manual)
bash scripts/self-tick/auto-merge.sh --execute

# Unattended (e.g. from a LaunchAgent)
MYCELIUM_AUTOMERGE_ENABLED=1 bash scripts/self-tick/auto-merge.sh
```

Logs land in `~/Library/Logs/mycelium-automerge.log` (override via `MYCELIUM_AUTOMERGE_LOG`).

### Tests

```bash
bash scripts/self-tick/auto-merge-test.sh
```

Mocks `gh` via `PATH` override and asserts each gate refuses the merge it should — including the Constitution-Diff guard from issue #144 acceptance.

### Tick label discipline

For auto-merge to fire on tick-opened PRs, the tick MUST add `--label agent-eligible` to its `gh pr create` call. Without the label the PR is invisible to the gate.

## Race safety

`run-tick.sh` holds an exclusive `flock` on `~/.mycelium/self-tick.lock`. If a previous tick is still running when the next is scheduled, the second one logs `abandoned: previous tick still running` and exits immediately. No overlap.

## Verification

After install, watch the next scheduled tick land:

```bash
tail -f ~/.mycelium/logs/self-tick-$(date -u +%Y%m%d).log
```

You should see the tick header, the claude-cli output, and the closing line. The summary file gets one line per tick: `<ISO>  <result>  <PR# or "no-op">  <issue# or "-">  <why>`.

## Why a local LaunchAgent

- macOS LaunchAgents survive user sessions cleanly, integrate with `launchctl`, and let `run-tick.sh` use `flock` for race safety and per-day log rotation.
- The autonomy loop runs on the same host as the local Supabase + Ollama backend it tends — no GitHub credentials in a remote secret store, no network round-trip for memory access.
