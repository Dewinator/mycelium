# Wave 3 swarm-discovery spike index

Throwaway-by-design empirical validation harness for the Wave 3 P2P
discovery design. Each spike answers one specific question that the
design in [`docs/swarm-discovery-spike.md`](../../docs/swarm-discovery-spike.md)
makes a claim about; running the spike either grounds the claim or
forces the doc to update. The design doc is the canonical reasoning;
this directory is the receipts.

All spikes ran on macOS-arm64 / Node 25.9. Linux (Avahi) and Windows
re-validation, and cross-host (two physical machines on one LAN), are
the named open gaps — see "What this index does NOT cover" at the
bottom.

## Running a spike

```bash
cd experiments/swarm-discovery
npm install                    # one-time, pulls bonjour-service
npm run spike:<name>           # see scripts in package.json
```

Each spike writes a `report-<name>.json` next to the script with
verbatim measurements. Reports are committed alongside the spike so
findings survive a `node_modules` wipe.

## Spike index

Ordered by the dependency chain — each later spike presupposes findings
from the earlier ones.

| # | Spike | Question | Key result | Commit | Doc anchor |
|---|---|---|---|---|---|
| 1 | `spike-mdns.mjs` | Does `bonjour-service` publish + browse `_mycelium._tcp.local` on macOS at all? | Publish 254 ms, self-discover 613 ms in single process. Library viable. | `edb60f6` | TL;DR + library-pick table |
| 2 | `spike-mdns.mjs --publish` / `--discover` (two-process) | Does discovery work across separate Node processes (the realistic shape)? | First-seen at 32 ms, no interference with macOS mDNSResponder. | `33068f6` | TL;DR §1 |
| 3 | `spike-mdns-fetch.mjs` | Full pointer→fetch loop — does mDNS-as-pointer + HTTPS fetch + shape-validate hold end-to-end? | 37 ms total (resolve 21 ms + fetch 14 ms + parse). Pointer architecture validated. | `fccb3d1` | TL;DR §1, "Full pointer→fetch loop" |
| 4 | `spike-fetch-hostile.mjs` | What happens when the publisher is hostile (404, malformed JSON, wrong shape, slow, huge body)? | 5/5 handled gracefully. Slow + huge are DoS vectors → body cap + 2 s timeout. | `498564e` | "Negative-path validation" |
| 5 | `spike-mdns-fetch.mjs` (with `selfCapBytes`) | Does the happy-path fetch enforce the same body cap the hostile spike used? | After fix: 64 KiB default cap; happy path 263 B / `capped=false` / 686 ms. | `e57ae1d` | "Hardening gap (closed 2026-05-03)" |
| 6 | `spike-mdns-fanout.mjs` | Does fan-out hold at N=3 (home WiFi) and N=10 (office WiFi)? | N=3: max 625 ms, parallel fetch 28 ms. N=10: max 1088 ms, parallel fetch 61 ms. Zero duplicate `up` events. TXT↔body `node_id` consistency holds. | `dc9241e` | "Multi-publisher fan-out" |
| 7 | `spike-mdns-self-filter.mjs` | Does the discoverer reliably skip its own publish via TXT `node_id` match? | Self-echo arrives at first_seen=5 ms; `txt.node_id == own` filter drops it cleanly. | `71bd74e` | "Self-filter under prod model" |
| 8 | `spike-mdns-churn.mjs` | Does `bonjour-service` emit `down` events when a publisher is SIGKILL'd? | **No.** Zero `down` events in 15 s. Implementation needs additional liveness mechanism. | `f165b27` | "Liveness / publisher churn" |
| 9 | `spike-mdns-heartbeat.mjs` | Does heartbeat-eviction (option a) work as a substitute for missing `down` events? | Detection at 15003 ms (3×5 s threshold), zero false-positive evictions on survivors, 263 B / 6 ms per heartbeat. ECONNREFUSED is fail-fast (≤4 ms). | `ceb4262` | "Heartbeat-eviction validation of option (a)" |
| 10 | `spike-mdns-rejoin.mjs` | When an evicted publisher restarts (same `node_id`, new ephemeral port), does the long-lived browser re-surface it? | **No.** Zero `up` events in 30 s. Browse-once-then-heartbeat is insufficient — implementation needs an explicit re-discovery path. | `0b3ec74` | "Rejoin after eviction" |
| 11 | `spike-mdns-cold-rebrowse.mjs` | Does instantiating a fresh `Bonjour()` instance on eviction (option III) surface the rejoined publisher? | **Yes.** Cold-rebrowse settles in 1325 ms (< 2 s budget), harvest is full-replacement of all 3 publishers, re-admit lands at 2005 ms from respawn. End-to-end kill→re-admit ≈ 18–23 s. | `2ed2768` | "Cold-rebrowse validation of option (III)" |
| 12 | `spike-mdns-wake.mjs` | When the publisher rebinds to a new port without restarting (laptop wake / network change), does in-process destroy+republish work, and do remote peers handle it the same way as SIGKILL+respawn? | In-process destroy+republish: 260 ms wall-time. macOS mDNSResponder serves no stale port records to fresh browsers post-destroy. Remote-peer cold-rebrowse-on-eviction handles the new port identically — no separate "wake" wire message needed. | `0fda017` | "Publisher-side wake / network-change re-announce" |
| 13 | `spike-mdns-self-echo-timing.mjs` | What is the realistic distribution of self-echo latency under healthy conditions, and what threshold should the "mDNS appears blocked" detector use? | K=10 trials: median 898 ms, p95/max 983 ms, zero timeouts. Recommended threshold `4 × p95` ≈ 4 s — 7.6× tighter than the doc's prior 30 s placeholder. Control trial (no publish) confirmed silence is unambiguous. | `b83aff2` | "mDNS blocked by enterprise WiFi" — threshold |

## Reports

Each spike emits a `report-*.json` with the raw measurements that the
design doc cites. The reports are the source of truth for any number
quoted in the doc; if the doc and a report disagree, the report wins.

## What this index does NOT cover

These remain genuinely open and are explicitly *not* answered by any
spike here. The design doc names each one as deferred:

- **Cross-host** — two physical machines on one LAN. All spikes above
  run as multiple processes on one host (loopback HTTP, single
  mDNSResponder daemon). The library's `up`-event payload includes
  remote peer IPs, so cross-host validation is mostly about confirming
  the existing pipeline rather than discovering new failure modes —
  but it has not been run.
- **Linux (Avahi)** and **Windows** — `bonjour-service` claims pure-JS
  portability; this needs to be re-confirmed empirically per platform
  before locking the library pick.
- **IPv6 mDNS** — the design doc punts this to the first
  implementation PR ("not a spike-time decision"). `bonjour-service`
  defaults to v4+v6, but Tauri-bundled Node builds sometimes disable
  v6 mDNS.
- **N > 10 publisher fan-out** — the threat model caps the candidate
  queue at 256, but the empirical fan-out spike only goes to N=10.
  Stress at the cap is left to the implementation.

## Why this lives in `experiments/`, not in the codebase

The design doc's framing: discovery is transport-side, not
wire-format-side. None of the code here ships. The spike harness
exists to inform the *Wave-3 implementation issue* (named in the doc
as "Concrete next steps" issue 1) before any production code lands.
When that issue is filed and implemented, the implementation should
lift `fetchUrl` (with the 64 KiB `selfCapBytes` cap and 2 s timeout)
and the heartbeat-eviction loop (5 s interval, 3 fail threshold,
on-eviction cold-rebrowse with 2 s settle window) verbatim from these
spikes. The reference shapes are intentionally ready-to-port.
