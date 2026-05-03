# Wave 2 — second peer + public seed

> Last refreshed: 2026-05-03
> Anchor doc for Wave 2 of [`docs/waves.md`](waves.md). Closes the doc gap
> waves.md §"Wave 2" explicitly named: "if Wave 2 stalls past Reed's
> 'Server steht'-signal, the highest-value tick action will be writing
> docs/wave-2-second-peer.md…". Wave 2 is at 90% — every script and
> migration the second peer needs already exists in this repo. The blocker
> is operational, not code.

## End-state (observable)

A second mycelium node (Profil A: Supabase + `nomic-embed-text` +
`qwen3:8b` for REM) runs on Reed's rented server. The local Mac has a
live `TrustEdge` to it. A Lesson signed on the Mac arrives on the server
within one poll cycle (and vice versa). `swarm_lessons` on both nodes
shows the cross-node row with `lesson_tier='B'` (§10.6 firebreak default).

When all three checks below pass, Wave 2 is done:

1. `curl https://${PEER_HOST}/.well-known/mycelium-node` returns a signed
   `NodeAdvertisement` from the second peer.
2. `trust_edge_log` on the Mac has a row with `peer_node_id =
   <peer.node_id>` and `reason = 'admitted'` (§10.1).
3. A test Lesson published on the Mac (Tier-A) appears on the peer via
   `GET /swarm/lessons?since=<iso>` polling, and a peer-side test Lesson
   appears on the Mac the same way.

## Profile A (chosen)

| Component         | Value                                              |
|-------------------|----------------------------------------------------|
| Vector store      | Supabase (Docker) + pgvector (79 active migrations)|
| Embedding model   | `nomic-embed-text` (Ollama, 768 dim)               |
| Synth model (REM) | `qwen3:8b` (Ollama)                                |
| Federation port   | `:8788` (mTLS, `MYCELIUM_FEATURE_FEDERATION=1`)    |
| Dashboard / swarm | `:8787` (HTTP, includes `POST /swarm/lessons`)     |
| Identity          | Ed25519 keypair under `~/.mycelium/node.key`       |
| mTLS host cert    | Self-signed Ed25519 X.509 under `~/.openclaw/keys/`|

Profile A ships on Docker even though Wave 1 (native app) is in flight.
Choosing native for the second peer would couple Wave 2 to Wave 1's
queue-drain timeline, and Wave 2 has the higher unblock ratio (it gates
Waves 3 + 4). Reference: [`docs/waves.md`](waves.md) §"Wave 2".

## Build constraint — HTTP path vs. mTLS path (validated 2026-05-03)

The bring-up sequence has two halves with different readiness:

**HTTP swarm path — works in the active build (active code in
`mcp-server/src/swarm/endpoints/`).** Step 4 (`/.well-known/mycelium-node`),
step 5 (`swarm_admit_lesson` MCP tool), step 6 (outbound polling via
`FED_SYNC_INTERVAL_MS`), step 7 (`POST /swarm/lessons` admission). These
ride on `lesson-admission.ts` + `node-advertisement.ts` + `lesson-proof.ts`,
all built by `tsc` and imported by `scripts/dashboard-server.mjs` at
runtime.

**mTLS federation listener — currently build-deferred.** The
`FederationService` lives in `mcp-server/src/deferred/services/federation.ts`,
which is excluded from `mcp-server/tsconfig.json`'s `include`
(`"exclude": ["…", "src/deferred/**"]`). `federation.js` is therefore not
emitted into `dist/services/`. The lazy import at
`scripts/dashboard-server.mjs:49` fails silently (caught, sets
`FederationService = null` and logs `federation imports failed — feature
flag set but dist missing`), but the same flag also gates the listener
mount at line 2369 — and the unconditional `new FederationService(...)`
at line 2453 will throw a TypeError when the feature flag is set.

In other words: setting `MYCELIUM_FEATURE_FEDERATION=1` against the
active build today causes the dashboard process to crash at startup, not
to silently disable federation. Step 8 (`scripts/e2e-mtls.mjs` against
`/federation/whoami`) cannot be exercised without first either (a)
re-including `src/deferred/**` in `tsconfig.json` and rebuilding, or
(b) null-guarding lines 2452–2453 so the flag becomes a graceful no-op.

CLAUDE.md roadmap step 5 ("Schwarm + Vererbung + Föderation") parks the
federation code; this doc previously implied that running federation
"just works" once the env vars are set. It does not. Wave 2's 90%
progress claim covers the HTTP path only — the mTLS path is gated on
unparking the deferred build.

## Pre-flight (Reed-side, before bring-up)

- [ ] Server reachable at a stable hostname `${PEER_HOST}` (FQDN).
- [ ] TLS-terminating reverse proxy in front of `:8787` and `:8788`, or
      direct ports open and Ed25519-cert-friendly. The federation listener
      requires OpenSSL ≥ 3 (LibreSSL has no Ed25519 — set `OPENSSL_BIN` if
      Homebrew-OpenSSL lives in a non-default path).
- [ ] Disk: ≥ 8 GB free for `qwen3:8b` quantized weights + Postgres data.
- [ ] RAM: ≥ 8 GB (Docker stack ~500 MB, Ollama ~5 GB while qwen3:8b is
      resident, headroom for embeddings).
- [ ] Outbound HTTPS to GitHub (for `git clone`) and to `ollama.ai` (for
      model pulls). Inbound 443 / 8787 / 8788 from the Mac's egress IP.
- [ ] Reed has SSH and a writable `${TARGET_DIR}` (e.g. `/opt/mycelium`).

## Bring-up sequence

All steps run on the **second peer** (the rented server) unless explicitly
prefixed `[Mac]`. None of these scripts ask interactive questions — every
parameter is env-var-driven so the whole sequence can be replayed.

### 1) Clone + provision

```bash
git clone https://github.com/Dewinator/mycelium.git "${TARGET_DIR}"
cd "${TARGET_DIR}"
bash install.sh                 # docker + ollama + nomic-embed-text + qwen3:8b
```

`install.sh` is idempotent. It pulls both Ollama models (`nomic-embed-text`
and `qwen3:8b`, see `install.sh:289`), creates `docker/.env` with random
secrets, runs all 79 migrations, and writes a macOS LaunchAgent for the
dashboard. On Linux the LaunchAgent step is a no-op — point a systemd
unit at `node scripts/dashboard-server.mjs` instead.

### 2) Bootstrap node identity

```bash
cd mcp-server && npm run build && cd ..
node scripts/init-node-identity.mjs
```

This generates `~/.mycelium/node.key` (Ed25519, 0600 inside a 0700 dir),
inserts the self-row into `nodes`, and prints the canonical `node_id`
(base58btc multihash of the pubkey, per SWARM_SPEC §3.5). Idempotent:
re-running with an existing key reloads it; an existing DB row without a
local key fails fast (the combination is unrecoverable signing-state).

Capture `node_id` — every later step that asserts a TrustEdge cites it.

### 3) Configure environment

In the dashboard env (LaunchAgent plist on macOS, systemd unit on Linux,
`docker/.env` on either):

```ini
MYCELIUM_PUBLIC_URL=https://${PEER_HOST}     # required, https only
MYCELIUM_DISPLAY_NAME=second-peer            # ≤ 64 chars (§3.3 size cap)
MYCELIUM_FEATURE_FEDERATION=1                # enables :8788 mTLS listener
FEDERATION_PORT=8788                         # default; expose accordingly
MYCELIUM_HOST_ID=second-peer                 # CN label on the host cert
```

Restart the dashboard after editing. The boot log prints the host-cert
pubkey + fingerprint — copy them.

`MYCELIUM_PUBLIC_URL` is the absolute URL where this node's swarm
endpoints are reachable. Missing value is a 503 from
`/.well-known/mycelium-node`, not a silent fallback (see
`mcp-server/src/swarm/endpoints/node-advertisement.ts:43`).

### 4) Verify the advertisement

From any host with internet:

```bash
curl -fsS "https://${PEER_HOST}/.well-known/mycelium-node" | jq .
```

Expected: a JSON record with `node_id`, `pubkey`, `endpoint_url`,
`spec_version`, `signed_at`, `signature`. Pubkey is base64url (no
padding). `endpoint_url` echoes `MYCELIUM_PUBLIC_URL`. Signature is
Ed25519 over the canonical bytes (§2.2).

### 5) [Mac] Add the peer as a TrustEdge

On the local Mac (this is the first cross-node trust write):

```bash
# Fetch the peer's signed advertisement and admit it.
curl -fsS "https://${PEER_HOST}/.well-known/mycelium-node" \
  > /tmp/peer-advert.json

# Hand it to the local mycelium MCP via the dashboard.
# `swarm_admit_lesson` is the tool an operator uses to import a peer's
# self-advertisement; it verifies the signature against the embedded
# pubkey, cross-checks the node_id derivation (rule 6 of §5), and
# writes the trust-edge row with reason='admitted' (+0.05 per §10.1).
```

The MCP tool surface is `mcp__vector-memory__swarm_admit_lesson`. Reed
calls it from his client; the Mac's `trust_edge_log` should gain a row
within one second.

Optional: if the Mac is also exposing `:8788`, the peer can reciprocate
the same step against the Mac's `/.well-known/mycelium-node` so trust
becomes bidirectional. Asymmetric trust is fine for v1.x — only the
direction with an edge admits inbound lessons.

### 6) Verify outbound (Mac → peer)

On the Mac, publish a Tier-A lesson. From the peer:

```bash
SINCE=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)        # macOS date syntax
curl -fsS "https://${MAC_PUBLIC_URL}/swarm/lessons?since=${SINCE}&limit=50" | jq .
```

The lesson appears in the response with the Mac's `node_id` as
`origin_node_id`. The peer's poll loop (default `FED_SYNC_INTERVAL_MS =
5min` in `dashboard-server.mjs`) imports it into `swarm_lessons` with
`lesson_tier='B'` — the firebreak default per §10.6. Confirm:

```sql
SELECT lesson_id, origin_node_id, lesson_tier
  FROM swarm_lessons
  WHERE origin_node_id = '<mac.node_id>'
  ORDER BY received_at DESC LIMIT 5;
```

### 7) Verify inbound (peer → Mac) via `POST /swarm/lessons`

The dedicated admission endpoint (issue #138, wired by PR #163) accepts
a signed v1.1 envelope and runs the full receiver pipeline:
wire-validator → signature check → quarantine check →
`LessonContradictionGate` → INSERT with `lesson_tier='B'` →
`+0.05` trust edge. Reference: `mcp-server/src/swarm/endpoints/lesson-admission.ts`.

From the peer, sign + push a test lesson into the Mac:

```bash
# (Build the envelope on the peer; sign with the peer's key; POST it.)
curl -fsS -X POST "https://${MAC_PUBLIC_URL}/swarm/lessons" \
  -H 'Content-Type: application/json' \
  --data @/tmp/peer-signed-lesson.json
```

Expected: `201` with the canonical `lesson_id`. On the Mac:

```sql
SELECT lesson_id, origin_node_id, lesson_tier
  FROM swarm_lessons
  WHERE origin_node_id = '<peer.node_id>'
  ORDER BY received_at DESC LIMIT 1;
```

Single-strike rules (§5 rule 19, §10.2): a malformed envelope, signature
mismatch, or chain-tip violation does NOT just reject — it sets the
offender's `nodes.quarantined_until = now() + 1h`. Verify by deliberately
sending one bad envelope and confirming the row appears.

### 8) Optional: end-to-end mTLS smoke — gated on deferred-build unpark

```bash
FED_HOST=${PEER_HOST} FED_PORT=8788 node scripts/e2e-mtls.mjs
```

`scripts/e2e-mtls.mjs` calls `/federation/whoami` over mTLS using the
Mac's own host cert as client cert (self-loop pattern; the peer must
have admitted the Mac's host pubkey to its `trust_roots` table). Status
200 + a JSON body confirms the federation listener and trust-roots
allowlist agree.

**Currently blocked** by the build constraint above (§"Build constraint
— HTTP path vs. mTLS path"): the federation listener is in
`mcp-server/src/deferred/`, excluded from `tsc`, so `federation.js`
isn't in dist and `MYCELIUM_FEATURE_FEDERATION=1` will crash the
dashboard before the listener ever starts. Steps 4–7 (HTTP path) work
without this step.

## Environment contract (peer side, summarised)

| Var                              | Required | Default     | Purpose                                               |
|----------------------------------|----------|-------------|-------------------------------------------------------|
| `MYCELIUM_PUBLIC_URL`            | yes      | —           | Absolute https URL exposed in `NodeAdvertisement`.    |
| `MYCELIUM_DISPLAY_NAME`          | no       | —           | ≤ 64 chars; cap enforced before publish (§3.3).       |
| `MYCELIUM_FEATURE_FEDERATION`    | no¹     | `0`         | mTLS listener flag. **Today's build will crash on `1`** — federation source is build-deferred (see §"Build constraint"). HTTP path (steps 4–7) does NOT need this flag. |
| `FEDERATION_PORT`                | no¹     | `8788`      | mTLS server-to-server port. Inert until federation build is unparked. |
| `MYCELIUM_HOST_ID`               | no¹     | `self`      | CN label on auto-generated host cert. Used by `scripts/deferred/lib/tls-host.mjs`. |
| `OPENSSL_BIN`                    | no¹     | Homebrew    | OpenSSL ≥ 3 binary; LibreSSL rejected. Used by deferred TLS helper. |
| `OPENCLAW_KEYS_DIR`              | no¹     | `~/.openclaw/keys` | Override host-cert directory. Honored by deferred code only — `mcp-server/src/services/` does not read this. |
| `FED_SYNC_INTERVAL_MS`           | no       | `300000`    | Outbound poll cadence; `0` disables auto-sync. Active. |
| `FED_AUDIT_RETENTION_DAYS`       | no       | `90`        | Audit-log retention for federation events. Active.    |

¹ Required only after the federation build is unparked. Until then,
setting `MYCELIUM_FEATURE_FEDERATION=1` crashes the dashboard at line
2452 of `scripts/dashboard-server.mjs` (`new FederationService(...)`
on a `null` import).

## Failure modes & recovery

| Symptom                                                       | Likely cause                                       | Fix                                                                               |
|---------------------------------------------------------------|----------------------------------------------------|-----------------------------------------------------------------------------------|
| `/.well-known/mycelium-node` → `503 MYCELIUM_PUBLIC_URL not configured` | Env var missing on the dashboard process.   | Set in env, restart dashboard.                                                    |
| Same endpoint → `503 node identity not initialized`           | `init-node-identity.mjs` not run.                  | Run it. Idempotent.                                                               |
| Federation log: "cert init FAILED — federation disabled"      | LibreSSL or OpenSSL ≥ 3 not on `$OPENSSL_BIN`.     | `brew install openssl@3` and export `OPENSSL_BIN=/opt/homebrew/bin/openssl`.      |
| `POST /swarm/lessons` → `401`                                 | Origin node unknown or signature mismatch.         | Verify the Mac admitted the peer's advertisement first (step 5).                  |
| `POST /swarm/lessons` → `403`                                 | Origin's `nodes.quarantined_until > now()`.        | Wait out the hour, or `UPDATE nodes SET quarantined_until = NULL WHERE node_id = …`. |
| Polling returns no rows                                       | `lesson_tier='A'` constraints; firebreak hides B   | Check `swarm_lessons` directly; firebreak is by design.                           |
| Trust-edge missing after admit                                | `swarm_admit_lesson` returned a non-success verdict.| Inspect MCP tool output; common cause is a wire-validator rule failure.           |

Rollback: stopping the dashboard process drops `:8787` + `:8788`; the
peer's row in the Mac's `nodes` table stays. To fully rotate identity,
delete `~/.mycelium/node.key` AND the matching `nodes` row, then re-run
`init-node-identity.mjs`. Trust edges from peers will need to be
re-admitted because the `node_id` changes with the key.

## Post-bring-up: what becomes possible

Per [`docs/waves.md`](waves.md) §"What changes after each wave":

- The first real `TrustEdge` exists. Anything that operated on a
  single-node assumption (the "single-node only" caveats in
  `SWARM_SPEC.md`) is now testable end-to-end.
- Wave 3 (tracker-free P2P discovery, [`swarm-discovery-spike.md`](swarm-discovery-spike.md))
  unblocks: implementation issue #195 has a real second peer to discover
  on the LAN once both nodes share a subnet (or for WAN, can switch to
  the bootstrap-list discovery already in §4.1, §4.2, §7).
- Wave 4 (anti-echo-chamber empirical defense) unblocks once at least
  one additional peer beyond Reed's two exists. Until then, the
  highest-value Wave-4 prep stays curating the adversarial-lesson
  corpus.

## Out of scope

- Operator UI for resolving contradicts — covered by issue #142.
- `RemDiversityService` + `LessonContradictionGate` REM-digest wiring —
  covered by issue #137.
- Native-app second peer — explicitly deferred until Wave 1 lands; see
  [`docs/native-app-track.md`](native-app-track.md).
- mDNS-discovered peer auto-trust — Wave 3, issue #195. Found ≠ trusted
  by construction; the operator still clicks "trust" before lessons flow.
