# Waves — Reed's 2026-05-02 vision, in shipping order

> Last refreshed: 2026-05-02
> This is the bird's-eye view that ties Wave 1 → Wave 4 together. Per-wave
> design docs live next to this file; this page exists so a fresh reader
> (next-tick agent or new collaborator) does not have to reconstruct the
> sequencing from scattered intentions and CLAUDE.md sections.

mycelium's near-term roadmap is organized as four sequential **waves**.
Each wave has a single observable end-state, an explicit dependency on the
previous wave, and a canonical artifact (doc or script) that anchors it.
A wave does not start until the previous wave's end-state is real — not
"design merged", but "the thing actually works in production".

| Wave | End-state (observable) | Status | Anchor doc |
|---|---|---|---|
| **1 — Native standalone app** | Doppelklick-Installer pro Plattform; no Docker; no Ollama install. | Spike phase complete (10/10), implementation in flight (9-PR queue). 30%. | [`native-app-track.md`](native-app-track.md) |
| **2 — Second peer + public seed** | Reed's rented server runs a second mycelium node (Profil A); first `TrustEdge` to local Mac live; inbound + outbound lessons verified end-to-end. | Setup-skript-ready, blocked on Reed's "Server steht"-signal. 90%. | _no canonical doc yet — see "Wave 2" below_ |
| **3 — Tracker-free P2P discovery** | Two mycelium instances on the same WiFi find each other automatically; mTLS-trust + lesson exchange without any external server. | Design spike merged, no code yet. 10%. | [`swarm-discovery-spike.md`](swarm-discovery-spike.md) |
| **4 — Anti-echo-chamber empirical defense** | Synthetic adversarial lessons (manipulative inputs, one-sided sources, consensus echoes) are demonstrably rejected by §10.4 + REM-self-audit on a real multi-node test swarm; results published as Constitution-Defense-Report. | Theory exists in `SWARM_SPEC.md` §10; production validation deferred until a real multi-node swarm exists post-Wave-2. 10%. | _no canonical doc yet — see "Wave 4" below_ |

## Why this order, not parallel

The temptation to start Wave 3 before Wave 2 finishes (or to "design Wave 4
in parallel") is real. The reason the order is sequential:

- **Wave 2 unlocks Wave 3 and Wave 4 with the same artifact** — a real
  second peer. Without it, P2P discovery has nothing to discover and the
  anti-echo defense has nothing to be tested against. Trying either as a
  pure unit-test exercise produces the failure mode Reed explicitly named:
  "the mechanic looks fine in theory, falls over in production."
- **Wave 1 unblocks Wave 2 indirectly** — the second peer can run on the
  Docker stack today, but every additional install Reed performs locks the
  team into the Docker UX. Native first means the second peer ships on the
  same artifact every other operator will use.
- **Wave 4 must be last** because it is the only wave whose value is a
  *measurement*, not a feature. You can only measure resilience on a
  system whose other moving parts are stable.

## Pillar check (per wave)

- **Wave 1 strengthens Pillar 1 (no cloud)** — moves from "needs Docker
  daemon" to "fully embedded". No pillar weakened.
- **Wave 2 strengthens Pillar 2 (federation)** — first non-trivial
  topology. Pillar 1 unchanged because the second node is also user-owned.
- **Wave 3 strengthens Pillar 1 + Pillar 6** — discovery-without-tracker
  removes the last server dependency (no central peer registry); mDNS +
  DHT advertisements use the same signed `NodeAdvertisement` machinery,
  so found ≠ trusted by construction.
- **Wave 4 validates Pillar 3 (cognitive sovereignty)** — without
  empirical defense data, the swarm's resistance to mainstream-drift /
  echo-manipulation / truth-by-repetition is just a claim.

## Wave 1 — native standalone app

**Owner doc:** [`native-app-track.md`](native-app-track.md) (covers all 10
sub-tasks, the spike → impl mapping, and the recommended 9-PR merge order).

**Current state (2026-05-02):** all 10 sub-task spikes shipped; 9 PRs
open and `MERGEABLE`; 998/999 tests green when applied in the recommended
order. Implementation of sub-tasks 3 (Tauri shell), 6 (update channels),
7 (migration wizard), 8 (CI matrix), 9 (banner refit), 10 (docs flip) is
explicitly gated on queue drain — the highest-value tick action while
the queue is full is *making the merge cheaper*, not adding more diffs.

## Wave 2 — second peer + public seed

**No anchor doc yet** — the operational runbook lives partly in
`SWARM_SPEC.md` (§4 wire format, §6 trust bootstrap) and partly in
intention metadata. This is a future doc gap; if Wave 2 stalls past Reed's
"Server steht"-signal, the highest-value tick action will be writing
`docs/wave-2-second-peer.md` covering: setup-script bring-up, migrations
to apply, Ollama models to pull (`nomic-embed-text` + `qwen3:8b`),
`MYCELIUM_PUBLIC_URL` + mTLS-cert provisioning, the first `TrustEdge`
handshake to the local Mac, and inbound/outbound lesson verification
checklist.

**Profile:** Profil A (Supabase + nomic-embed + qwen3:8b for REM). The
second peer ships on Docker today even though Wave 1 is in flight —
choosing native for the second peer would couple Wave 2 to Wave 1's
queue-drain timeline, and Wave 2 already has the higher unblock ratio
(it gates Waves 3 + 4).

**Blocker:** Reed-side server provisioning. Code-side is 90% — every
script and migration the second peer needs already exists in this repo.

## Wave 3 — tracker-free P2P discovery

**Owner doc:** [`swarm-discovery-spike.md`](swarm-discovery-spike.md).

**Current state (2026-05-02):** design spike on `main`, no code yet. The
spike answers four questions: smallest v1-wire-protocol extension, library
choice for LAN-mDNS + WAN-DHT inside the Tauri sidecar, how discovery
hands off to existing `node_identity` / `TrustEdge` / signed
`NodeAdvertisement` machinery, and which discovery-enabled attacks the
v1.1 self-healing layer (§10) already neutralizes.

**Wave 1 forward-compat:** the Tauri shell spike has been retrofitted with
a Wave-3-forward-compat section (`docs/native-tauri-shell-spike.md`)
covering UDP cap, wire-port split, wake hooks, cert dir — so v1.x design
decisions still in flight do not have to be retrofitted later.

**Sequencing:** does **not** ship in v1.x. Discovery work begins after
Wave 2 is live, because discovery without a second peer is untestable.

## Wave 4 — anti-echo-chamber empirical defense

**No anchor doc yet** — the *theory* lives in `SWARM_SPEC.md` §10
(six self-healing mechanisms: provenance commitment, contradiction gate,
diversity filter, REM-self-audit, plagiarism detection, Sybil resistance).
The *empirical defense report* will be `docs/constitution-defense-report.md`
once the test campaign runs.

**Test design (high-level, from intention #5):**
- Inject synthetic adversarial lessons into a local test swarm:
  manipulative inputs, one-sided sources, consensus echoes ("truth by
  repetition" amplification).
- Observe whether §10.4 (diversity filter) + REM self-audit reject them.
- Failure mode: if production rejects-rate < spike-rate, the §10
  guarantees are theoretical. That outcome would invalidate the Pillar 3
  claim and trigger a re-design before any Wave-4-marketing claim is made.

**Blocker:** needs a real multi-node swarm (Wave 2 + at least one
additional peer beyond Reed's two) so that the test population is
non-trivial. Until then, the highest-value preparatory work is curating
the adversarial-lesson corpus — a small set of canonical manipulative
patterns that can be re-run as a regression suite.

## What changes after each wave

| After wave | What becomes possible | What becomes obsolete |
|---|---|---|
| Wave 1 lands | Beginners install in one click. Sub-task 7 migration wizard moves users off Docker. | The "Docker prerequisite" paragraph in `setup.md`. |
| Wave 2 lands | First real `TrustEdge`. Inbound `/swarm/lessons` admission endpoint sees real traffic. Reed's local Mac stops being a single-node demo. | The "single-node only" caveats in `SWARM_SPEC.md`. |
| Wave 3 lands | LAN peers find each other without operator config. v1.x bootstrap-list discovery (§4.1, §4.2, §7) becomes a fallback, not the primary. | The "operator pastes a peer URL into config" UX. |
| Wave 4 lands | Pillar 3 claim becomes empirical, not aspirational. The Constitution-Defense-Report is publishable. | The footnote in `CONSTITUTION.md` deferring §10.4 validation. |

## Out of scope for these four waves

- Mobile (iOS / Android) — separate roadmap.
- Cloud-hosted variant — explicitly rejected per the Souveränität pillar.
- Pairing / population evolution / federation governance — fully deferred,
  see `archive/swarm-deferred` branch and `mcp-server/src/deferred/`.
