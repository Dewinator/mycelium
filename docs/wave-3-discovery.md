# Wave 3 — tracker-free P2P discovery

> Last refreshed: 2026-05-03
> Anchor doc for Wave 3 of [`docs/waves.md`](waves.md). Closes the doc
> shape gap that left Wave 3 as the only row in the waves table whose
> anchor pointed at a *spike* doc instead of a wave-state-and-sequencing
> summary (Wave 2 has [`wave-2-second-peer.md`](wave-2-second-peer.md),
> Wave 4 has [`wave-4-anti-echo.md`](wave-4-anti-echo.md)). The design
> substrate continues to live in [`swarm-discovery-spike.md`](swarm-discovery-spike.md)
> — that document answers *what* and *why*. This document answers *what
> ships in what order*, *what is blocking what*, and *what can an agent
> usefully do today while Waves 1 and 2 are in flight*.

## End-state (observable)

A fresh mycelium installation on macOS, Windows, or Linux finds another
mycelium installation on the same WiFi within seconds of joining the
network — without the operator pasting a peer URL into config. The
discovered peer enters the dashboard as `auto-discovered, untrusted`;
one operator click on each side promotes the `TrustEdge.weight` from 0
to `base_weight`, and Lessons begin flowing under §7 polling.

When all four checks below pass on Reed's two-laptop home WiFi, Wave 3
is done:

1. Both laptops, started from a clean state, see each other in the
   "candidate peers" dashboard panel within 4 s of mDNS publish (the
   `MYCELIUM_MDNS_BLOCKED_TIMEOUT_MS` budget that
   [`spike-mdns-self-echo-timing.mjs`](../experiments/swarm-discovery/spike-mdns-self-echo-timing.mjs)
   anchors at p95 = 983 ms).
2. SIGKILL'ing one of the laptops' mycelium processes evicts that peer
   from the other laptop's active candidate set within ≤15 s and shows it
   as offline in the dashboard (the heartbeat-eviction budget
   [`spike-mdns-heartbeat.mjs`](../experiments/swarm-discovery/spike-mdns-heartbeat.mjs)
   measured at 15003 ms ±3 ms).
3. Restarting the killed laptop's mycelium re-admits it on the other
   laptop within ≤23 s end-to-end (the cold-rebrowse-on-eviction budget
   [`spike-mdns-cold-rebrowse.mjs`](../experiments/swarm-discovery/spike-mdns-cold-rebrowse.mjs)
   measured at 18 s typical, 23 s worst-case).
4. Closing one laptop's lid and reopening it re-publishes the peer's
   mDNS record in <1 s (the in-process destroy+republish budget
   [`spike-mdns-wake.mjs`](../experiments/swarm-discovery/spike-mdns-wake.mjs)
   measured at 260 ms) and the other laptop sees the new ephemeral port
   on the next cold-rebrowse cycle.

If a third operator's laptop joins the same WiFi, all three nodes see
each other; if a fourth does, all four do. (The fan-out spike,
[`spike-mdns-fanout.mjs`](../experiments/swarm-discovery/spike-mdns-fanout.mjs),
proved this clean at N=10 on macOS-arm64 with zero duplicate `up` events
and parallel-fetch confirmed.)

L2 (WAN/DHT) end-state is **deferred to a Wave-3 follow-up**, not part
of the wave-done bar. L1 (LAN/mDNS) alone satisfies the source intention
("zwei mycelium-Instanzen finden einander, etablieren mTLS-Trust,
beginnen Lessons auszutauschen") for the home/office case, which is the
overwhelming majority of operator setups Reed has named. L2 ships when
Wave 2 has produced ≥2 stable public peers and the swarm has enough
reachable nodes for the DHT to be useful (the spike's "Off by default
until swarm ≥ ~10 pub" gate).

## Why Wave 3 is gated on Wave 1 *and* Wave 2

Wave 3 has two upstream dependencies, not one. Both are real, and the
weaker dependency is the one that gets forgotten:

- **Wave 1 (native app, epic [#176](https://github.com/Dewinator/mycelium/issues/176))
  is the structural blocker for L1.** The mDNS responder + browser run
  inside the Tauri sidecar — the same Node subprocess that hosts PGlite
  + llama.cpp per [`docs/native-tauri-shell-spike.md`](native-tauri-shell-spike.md).
  The Tauri OS hooks (`wake`, `network-change`) the publisher-side
  re-announce path requires (per `spike-mdns-wake.mjs`) only exist
  inside a Tauri shell. Implementing L1 against the Docker setup would
  run the mDNS responder in a container — UDP multicast across Docker's
  bridge network is the kind of subtly-broken setup that produces
  "works on my machine, fails in production" bug reports and gives
  operators no path to fix it. The native sidecar is the supported
  surface for this layer, and that surface only exists once Wave 1
  lands.
- **Wave 2 (second peer + public seed,
  [`wave-2-second-peer.md`](wave-2-second-peer.md)) is the operational
  blocker for L2.** A DHT with one bootstrap node is a list, not a
  network. The L2 design (spike doc §"L2 — Kademlia DHT") explicitly
  defers DHT default-on until Wave 2 + at least one public seed produce
  the first two stable bootstrap candidates. Shipping L2 before Wave 2
  would mean shipping a feature whose first-run experience is "joined
  the DHT, found nobody."

In other words: **L1 needs Wave 1's Tauri shell as its host, L2 needs
Wave 2's public peers as its substrate.** Neither is replaceable with
a unit-test workaround. This is the same shape Wave 4 hits — the value
is observable only on a real multi-node setup — and the same response
applies: do the design work now, defer the implementation until the
dependencies land.

## Sequencing inside Wave 3

The wave decomposes into the six issues the spike doc's "Concrete next
steps" table already enumerates. They are reproduced here as the
canonical landing order so the agent that picks Wave 3 up after Waves 1
and 2 ship does not have to re-derive the dependency graph:

| order | issue title (spike §"Concrete next steps") | depends on | agent-eligible? |
|---|---|---|---|
| W3.1 | `feat(discovery): mDNS responder + browser in Tauri sidecar (L1)` | Wave 1 sub-task 3 (Tauri shell) merged | yes (post Wave 1) |
| W3.2 | `feat(discovery): "candidate peers" dashboard panel + promote action` | W3.1 | yes (post W3.1) |
| W3.3 | `feat(discovery): private libp2p Kademlia DHT client (L2), default-off` | Wave 2 + ≥2 stable public peers | yes (post Wave 2) |
| W3.4 | `feat(discovery): DHT pointer publish + lookup tool` | W3.3 | yes |
| W3.5 | `docs(discovery): operator guide — when to enable L1/L2, what each leaks` | W3.1 + W3.3 | yes |
| W3.6 | `feat(discovery): rate-limit + sanity caps on L1/L2 candidate ingestion` | W3.1 + W3.3 | yes |

W3.1 alone satisfies the source intention's *minimum* end-state: two
laptops on the same WiFi find each other, mTLS-trust handshake fires,
Lessons start flowing. Reed's "Familie / WG / Büro" use case is fully
covered by L1; L2 is the "wider internet" upgrade. Treat the wave as
*shippable at W3.1+W3.2+W3.6* for the LAN case, with W3.3+W3.4+W3.5
extending to WAN once Wave 2 produces the public seed.

## What is empirically settled vs. what implementation still owns

The spike chain (commits `33068f6` → `9b11fc4`, 11 spikes total)
removed the largest design risks before the wave starts. The
implementation does **not** have to re-prove these properties; the
spike reports under [`experiments/swarm-discovery/`](../experiments/swarm-discovery/)
are the contract:

| concern | spike that settled it | verdict |
|---|---|---|
| Library pick (`bonjour-service` vs `mdns` vs `multicast-dns` vs `dns-sd`) | spike doc §"Library choice" + 11-spike chain on `bonjour-service` | `bonjour-service`, locked. |
| End-to-end mDNS-as-pointer wire (publish TXT → discover → fetch URL → shape-validate body) | `spike-mdns-fetch.mjs` | 37 ms total in two-process mode. |
| Hostile `/.well-known` responses (404, malformed, wrong shape, slow, huge) | `spike-fetch-hostile.mjs` | 5/5 handled gracefully. Body cap default **64 KiB**, timeout **2 000 ms**. |
| N-publisher fan-out (home N=2, office N≈10) | `spike-mdns-fanout.mjs` | Clean at N=3 and N=10; parallel fetch confirms true concurrency. |
| Liveness in the absence of `down` events on SIGKILL | `spike-mdns-churn.mjs` + `spike-mdns-heartbeat.mjs` | Heartbeat re-fetch every 5 s, evict on 3 consecutive failures, **15 s detection** ±3 ms. |
| Rejoin after eviction (publisher restarts on new ephemeral port) | `spike-mdns-rejoin.mjs` + `spike-mdns-cold-rebrowse.mjs` | Long-lived browser does NOT auto-resurface; cold-rebrowse with fresh `Bonjour()` instance harvests at ~1.3 s, **re-admit at ≈18–23 s end-to-end**. |
| Wake / network-change re-publish (laptop sleep/resume) | `spike-mdns-wake.mjs` | Publisher destroy+republish in **260 ms**; remote peers' cold-rebrowse path handles new port without any extra wire signal. |
| mDNS-blocked-network detection threshold | `spike-mdns-self-echo-timing.mjs` | K=10 trials median 898 ms / p95 983 ms / max 983 ms; threshold = `4 × p95` = **4 000 ms**, env-overridable. |
| Self-publish echo filter (don't trust your own service as a peer) | spike commit `71bd74e` | TXT `node_id` match cleanly skips own publish. |

What W3.1 still owns:
- Wiring the proven primitives into `mcp-server/`'s peer-pending pipeline
  with the `bonjour-service` types adapted to the existing
  `NodeAdvertisement` validator from `services/wire-types.ts`.
- Cross-platform re-validation of the same primitives on Linux (Avahi)
  and Windows. The spikes were all on macOS-arm64 / Node 25.9. The
  spike doc's library-choice paragraph names this as the open item.
- The "candidate peers" dashboard surface (W3.2) and the operator
  guide (W3.5).

What W3.3 still owns:
- Pinning the libp2p version (the spike doc names `js-libp2p` +
  `@libp2p/kad-dht` but does not lock a version — that lands in the
  W3.3 PR).
- Defining the `/mycelium/kad/1.0.0` protocol id and the bootstrap
  manifest format. The spike doc covers the *design*; the
  implementation lands the schema.

## W3.1 pre-implementation handoff

This section exists so the agent that picks W3.1 up after Wave 1 lands
does not have to spelunk the spike outputs and the existing peer
pipeline in parallel. The spike chain answered *what to build*; this
section answers *where it plugs in*.

### Concrete file touchpoints (existing code W3.1 must integrate with)

| concern | file | symbol(s) the wiring depends on |
|---|---|---|
| Wire shape for the discovered peer | `mcp-server/src/services/wire-types.ts` | `NodeAdvertisement` (7 fields: `node_id`, `pubkey`, `display_name?`, `endpoint_url`, `spec_version`, `signed_at`, `signature`) |
| Wire-shape rejection rules (rules 1–10 of §5) | `mcp-server/src/services/wire-validator.ts` | reuse — discovery MUST NOT relax any of them |
| HTTP fetch of `/.well-known/mycelium/node-advertisement.json` | spike `experiments/swarm-discovery/spike-mdns-fetch.mjs` (37 ms two-process) | port the body-cap (64 KiB) and timeout (2000 ms) defaults verbatim |
| Self-publish echo filter | spike commit `71bd74e` (TXT `node_id` match) | discovery MUST skip records whose advertised `node_id` equals the local `node_id` from `services/node-identity.ts` |
| Persistence of an admitted peer | `mcp-server/src/services/swarm-admit.ts` + `nodes` table (migrations 070, 071, 075) | new auto-discovered peers land as a new `nodes` row with `trust_weight = 0`, `is_self = false`, `last_seen_at = now()` — promotion to `base_weight` is the W3.2 operator action, NOT a W3.1 side effect |
| Operator-visible read of candidate peers | `mcp-server/src/services/swarm-peers.ts` (`PeerSummary`) | extend the existing read shape with `discovery_source: 'mdns' \| 'manual' \| 'dht'` so W3.2's dashboard panel can filter |

### Adapter shape: bonjour-service service record → NodeAdvertisement

The bonjour-service `up` event yields a service record with `name`,
`host`, `port`, `addresses[]`, `txt`. Discovery is **never** the source
of truth for an advertisement — the canonical advertisement always
lives at `https://<host>:<port>/.well-known/mycelium/node-advertisement.json`,
self-signed by the same key it declares. The TXT record is a *pointer*,
not a payload. The mapping is therefore strictly two-stage:

1. **TXT → fetch URL** — read `txt.node_id` and `txt.path` (default
   `/.well-known/mycelium/node-advertisement.json`), construct
   `https://<host>:<port><path>`. Reject the service if `txt.node_id`
   equals the local `node_id` (self-publish echo filter).
2. **Fetched body → `NodeAdvertisement`** — feed the response bytes
   through the existing Phase-3b validator
   (`wire-validator.ts:validateNodeAdvertisement`). Discovery does
   **not** introduce a relaxed validator: a rejected fetched body is
   a rejected peer, full stop. Body-cap and timeout per spike defaults.

The pseudo-code:

```ts
// Inside the W3.1 service (e.g. mcp-server/src/services/discovery-mdns.ts)
on('up', async (svc) => {
  if (svc.txt?.node_id === localNodeId) return;            // self-echo
  const url = buildUrl(svc.host, svc.port, svc.txt?.path);
  const body = await fetchWithCaps(url, { timeoutMs: 2000, maxBytes: 65536 });
  if (!body) return;                                        // hostile-OK per spike-fetch-hostile.mjs
  const adv = await validateNodeAdvertisement(body);        // reuses Phase 3b
  if (!adv.ok) return;
  await admitDiscoveredPeer(adv.value, { discovery_source: 'mdns' });
});
```

`admitDiscoveredPeer` is a *new* helper sibling of the existing
`swarm-admit.ts` flow — it inserts a `nodes` row with `trust_weight = 0`
rather than going through the lesson-admission path (which assumes a
trust edge already exists). This is the smallest delta that keeps the
v1 admission semantics intact.

### Open design questions the W3.1 PR has to settle

The spike chain deliberately did **not** decide these — they are
implementation-shape choices that depend on the live code, not on the
spike substrate:

1. **Service name.** Spike uses `_mycelium._tcp.local`. Confirm against
   IANA hygiene (lowercase, ≤15 chars) before locking it.
2. **TXT field set.** Spike publishes `node_id`, `path`, `spec_version`.
   Decide whether to also publish `display_name` for the dashboard
   "candidate peers" view, or to wait for the fetched advertisement to
   provide it (cleaner — TXT is just a pointer).
3. **Heartbeat budget surface.** Spike measured 15 003 ms ±3 ms
   detection. Decide whether to expose `MYCELIUM_MDNS_HEARTBEAT_MS` and
   `MYCELIUM_MDNS_FAIL_THRESHOLD` as env-overridable (yes for ops
   debuggability) or compile-time (no — operators with broken
   networks need the dial).
4. **Dashboard refresh model.** W3.2 owns the panel itself; W3.1 owns
   the read-side hook. Decide between SSE push (matches the existing
   dashboard polling pattern) and a simple `GET /swarm/discovery/candidates`
   that the dashboard polls every N seconds. SSE is cheaper post-W3.2
   but adds one new HTTP surface for W3.1.
5. **Quarantine reuse.** A peer that is quarantined via §10 mechanics
   should NOT re-appear as a candidate when its mDNS record is
   re-observed. Decide whether `admitDiscoveredPeer` reads
   `nodes.quarantined_until` before insert (yes — cheaper than the
   alternative, which is a re-quarantine pass on every `up` event).

These five questions are **not** spike-chain regressions — they are
the kind of small wiring decisions that should be made in the W3.1 PR
review with the live code in front of the reviewer, not pre-baked into
this doc.

### Test surface

The 11 spike `.mjs` files live in `experiments/swarm-discovery/` and
are *not* part of `node --test` runs (they require sudo for raw
multicast on some platforms and Reed's two-laptop home WiFi for the
end-to-end ones). The W3.1 PR adds:

- Single-process unit tests under `mcp-server/src/__tests__/` for the
  TXT → URL adapter, the self-echo filter, and the
  `admitDiscoveredPeer` insert path. These run on every `node --test`
  invocation, with mocked `bonjour-service`.
- A new `experiments/swarm-discovery/spike-mdns-mcp-server.mjs` that
  spawns the actual mcp-server process and a fake-peer process, and
  asserts the new `nodes` row appears with `trust_weight = 0`. This is
  the integration-shape spike — runs on demand, not in CI, mirrors the
  existing `spike-mdns-fetch.mjs` two-process pattern.

The W3.1 acceptance criteria are the four end-state checks in §"End-state
(observable)" above, **plus** the unit tests. Cross-platform re-runs of
the original 11 spikes on Linux and Windows are out of W3.1 scope —
that is the §"What can land NOW" item 1 above, runnable independently
on any platform with mycelium installed.

## What can land NOW (Wave 3 prep, no dependency)

Honest answer: **almost nothing implementation-side**, by design.
Wave 3's value is end-to-end discovery that only makes sense once L1's
host (Wave 1) and L2's substrate (Wave 2) exist. Trying to land L1's
mDNS layer outside the Tauri sidecar produces a Docker-container-mDNS
implementation that is strictly worse than the eventual native one and
that nobody will use. That is the failure mode the spike chain
explicitly avoided by validating against the actual sidecar shape, not
a stand-in.

What *can* land before Waves 1 + 2 ship, ranked by independence and
value:

1. **Cross-platform spike re-runs.** Re-execute the same 11 spikes on
   Linux (Avahi) and Windows. The library pick and the timing budgets
   above all carry an implicit "macOS-arm64 only" caveat that the
   implementation currently has to take on faith. Each platform is one
   PR adding a `report-<spike>-<platform>.json` next to the existing
   ones. **Scope discipline:** these are pure data-collection PRs, no
   production code; same agent-eligibility shape as the W4.1 fixture
   PRs. Subject to the same queue-drain rule (don't grow the queue past
   what Reed can absorb — cap at one cross-platform PR open at a time).
2. **Anchor doc** (this file). One-time, lands direct-to-`main`.
3. **The W3.1 issue itself**, filed on GitHub with the acceptance
   criteria from §"End-state (observable)" above and the empirical
   budgets from §"What is empirically settled". This is a
   propose-by-agent action, subject to the existing 3-issue cap on the
   propose-by-agent backlog (the Wave 3 issue would be one slot; check
   the backlog before proposing).

Items 1–3 do **not** include any of the W3.x implementation issues
above. Filing W3.2 / W3.3 / W3.5 / W3.6 *now* would just queue
hypothetical implementation work that nobody can execute against a
non-existent Tauri sidecar.

## Out of scope

- **NAT traversal for L2.** Spike doc §"Open questions deliberately
  deferred" #1: STUN/TURN is explicitly out of scope per `SWARM_SPEC.md`
  §6. A future Wave (5 or later) can add libp2p relays; Wave 3 ships
  with "your node must be reachable" as a documented constraint.
- **DHT bootstrap-set governance.** Spike doc §"Open questions" #2.
  Wave 2's "Reed's server + a single public seed" sidesteps it for v1
  of L2; the question of how the swarm long-term governs its own
  bootstrap manifest is its own design wave.
- **Human-friendly peer handles.** Spike doc §"Open questions" #3.
  `node_id` is a multihash; aliasing is a future client-side layer,
  never wire.
- **Auto-promotion of LAN peers to `TrustEdge.weight > 0`.** The
  operator-in-the-loop "click to promote" step in §"Bootstrap flow" of
  the spike is non-negotiable for v1 of Wave 3. Reed's family-WiFi case
  still wants explicit consent (kids, IoT compromise, guest devices).
  Auto-promotion is a separate feature gated on mutual signed
  assertions.
- **Wave 4-style empirical attack-class campaign against the discovery
  layer.** The §10 self-healing layer's attack classes
  ([`docs/wave-4-anti-echo.md`](wave-4-anti-echo.md)) live at the
  Lesson layer, not the discovery layer. The spike's threat model
  covers discovery-specific attacks (mDNS poisoning, mDNS flooding,
  DHT eclipse, DHT pollution, Sybil discovery) at the design level;
  whether they need their own corpus is a Wave-3-follow-up question
  decided after W3.1 ships.

## Post-Wave-3: what becomes possible

Per [`docs/waves.md`](waves.md) §"What changes after each wave":

- LAN peers find each other without operator config. The "operator
  pastes a peer URL into config" UX (v1 §3.2 / §7) becomes the fallback,
  not the primary path.
- The native-app onboarding flow can omit the "find a friend's node URL
  and paste it" step entirely for the home/office case. New operators
  see other operators on their network the moment the app starts.
- Wave 4's multi-node empirical campaign becomes cheaper to set up: the
  W4.3 "third peer beyond Reed's two" can be Reed's partner's laptop
  joining the home WiFi, with auto-discovery doing the wiring instead
  of a manual config step per node.
- Once L2 is on (post Wave 2 + ≥10 public peers), a fresh installer
  with zero bootstrap URLs has an entry point into the swarm. This is
  the final "no central authority anywhere" property — bootstrap-list
  discovery becomes a fallback for hostile networks, not a structural
  requirement.
