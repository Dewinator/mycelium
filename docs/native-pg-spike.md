# Spike 1 — embedded Postgres without Docker

> Status: **complete — Path A.2 (PGlite) validated end-to-end at migration level**
> Issue: [#177](https://github.com/Dewinator/mycelium/issues/177) (sub-task of [#176](https://github.com/Dewinator/mycelium/issues/176))
> Branch / PR: `agent/spike-1-embedded-pg` (initial), `agent/pglite-spike-revalidate-79-green` (re-run after #180 fix)
> Code: [`experiments/native-pg/`](../experiments/native-pg/)
> Reports: [`report-embedded-postgres.json`](../experiments/native-pg/report-embedded-postgres.json), [`report-pglite.json`](../experiments/native-pg/report-pglite.json)
> Platform measured: macOS arm64 (Apple Silicon), Node v25.9

## TL;DR

The embedded-postgres subprocess approach the issue proposed (`@embedded-postgres/*`) **does not work for mycelium today** — the upstream zonky binaries do not include `pgvector`, and the bundle has no `pg_config` or server headers, so we cannot build the extension on the user's machine. Adopting it would force us to build and host our own per-platform `vector.so` artifacts and copy them into the bundle at install time.

There is a much better path: **`@electric-sql/pglite`** (WASM Postgres) ships with pgvector built in, runs in-process inside Node, and is one cross-platform npm dep. After the [#180 fix](https://github.com/Dewinator/mycelium/issues/180) landed (active migration `038_trust_substrate_minimal.sql`), the spike now runs **all 79 active migrations green** with eight contrib extensions wired in. Cold-start is ~4.9 s (WASM init + pgvector load); the full migration walk completes in ~1.7 s. See [Path forward](#path-forward).

## Spike scope (per #177 acceptance)

The original spec asked for: lifecycle wrapper, pgvector working, all migrations applied, full `npm test` green, plus a "what we learned" doc.

This tick focused on the parts that **answer the feasibility question**:
- start/stop a Postgres process without Docker (both candidates)
- get pgvector loaded
- walk our existing migrations and find where things break

The "wire it into mcp-server / pass all 920+ tests / replace PostgREST" pieces were intentionally not done — once Reed picks a path, those become well-scoped follow-up tickets rather than exploratory work.

## Two candidates evaluated

| | `embedded-postgres` (subprocess) | `@electric-sql/pglite` (WASM, in-process) |
|---|---|---|
| Postgres version | 18.3 | 17.5 |
| pgvector available | ❌ not bundled | ✅ 0.8.1 (latest), built-in |
| Cold start | ~3.2s initdb + 0.1s postmaster | ~5.0s WASM init |
| Disk footprint | 39 MB data dir | data dir only — no platform binary |
| `node_modules` size | 145 MB (Postgres binary per platform) | 23 MB (single WASM) |
| Cross-platform | needs separate npm package per arch | one WASM works on macOS / Win / Linux / browser |
| Concurrency | full multi-connection PG | single connection — needs queueing wrapper |
| Subprocess management | yes (start, monitor, stop, restart on crash) | no — lives in Node process |
| pg_config / headers | ❌ stripped from bundle | n/a |
| Build pgvector ourselves? | required, per platform per PG-major | not needed |

### Path A.1 — `embedded-postgres` (subprocess) — blocked

The package works as advertised: `pg.initialise()` runs `initdb`, `pg.start()` boots a postmaster on a chosen port, `getPgClient()` hands back a node-postgres connection. On macOS-arm64, cold-start of a fresh data directory took **3.2 s of initdb plus 0.1 s of postmaster boot**, and the data directory ended at **39 MB**.

But our migration 001 failed immediately with `extension "vector" is not available`. The bundle lists 60 contrib extensions in `pg_available_extensions`; `vector` is not among them. Inspection of `node_modules/@embedded-postgres/darwin-arm64/native/`:

- `bin/` — only `initdb`, `pg_ctl`, `postgres`. No `psql`, no `pg_dump`, no `pg_config`.
- `include/` — does not exist. No server headers.
- `lib/postgresql/*.dylib` — all standard contrib modules, no `vector.dylib`.

So we **cannot compile pgvector against this bundle on the user's machine** (no headers, no pg_config), and we cannot use `psql`-based tools (no `psql`, no `pg_dump`).

To make this path viable we would need:

1. Our own CI that builds `vector.dylib` / `vector.so` / `vector.dll` against each (PG major × platform) combination.
2. Publish those as `@mycelium/pgvector-darwin-arm64-pg18` etc.
3. A post-install step that copies the right one into the bundled `lib/postgresql/` and the matching `vector--*.sql` + `vector.control` into `share/postgresql/extension/`.
4. Re-do that whole pipeline every time we bump the embedded-postgres version (pgvector ABI is per PG-major).
5. Replace `psql` migration runner with a Node script that talks libpq via the `pg` package.

Estimated 2–3 days of additional work just to make `CREATE EXTENSION vector` succeed on one platform, then more to repeat for Win + Linux.

### Path A.2 — `@electric-sql/pglite` (WASM) — recommended

PGlite is a WASM build of Postgres 17.5 that runs inside the Node process. It distributes a `~23 MB` npm package (3.7 MB gzipped) and bundles pgvector 0.8.1 plus 30+ contrib extensions as opt-in submodules.

Cold-start on the same machine: **~4.9 s** (WASM compile + extension wiring + initdb-equivalent + pgvector load). After warm-up, queries are direct in-process function calls.

With the eight extensions our migrations actually use wired in (`vector`, `pg_trgm`, `pgcrypto`, `uuid_ossp`, `btree_gin`, `btree_gist`, `citext`, `hstore`, `tablefunc`), the spike now walks **all 79 active migrations green**. Total migration time end-to-end: **~1.7 s**. Slowest individual migrations (single-digit-percent of total): `037_pki_lineage.sql` (190 ms), `015_experiences.sql` (118 ms), `062_compute_affect.sql` (88 ms).

#### Re-run history

The first run of this spike halted at `040_signed_revocations.sql` because `revoked_keys` was created **only** in `supabase/migrations.deferred/038_federation_trust.sql` and active migrations never created it. That was a fresh-install bug for **any** Postgres distribution, not a PGlite limitation — filed as [#180](https://github.com/Dewinator/mycelium/issues/180), fixed in active migration `038_trust_substrate_minimal.sql` (parks the minimum substrate — `trust_roots` + `revoked_keys` schemas — in the active path, leaving the federation RPCs deferred). After that fix landed on `main`, the spike was re-run end-to-end and reaches the latest active migration without errors.

This means there are **no remaining latent fresh-install ordering bugs** in the 79 active migrations as of the re-run date — at least none that surface against PGlite-Postgres-17.5 with the eight extensions wired in.

## Path forward

**Recommend: pivot the #176 native-app architecture from `embedded-postgres` (subprocess) to `@electric-sql/pglite` (WASM, in-process).**

Why this is strictly better than what #176 currently proposes:

1. **No Docker** — the goal of #176, met.
2. **No platform-specific binary downloads** — one WASM works everywhere Node runs (macOS, Windows, Linux, even browser if we ever want a web demo).
3. **No subprocess lifecycle to manage** — no port conflicts, no stale postmaster on crash, no signal handling, no pidfiles. The DB lives and dies with the Node process.
4. **`node_modules` shrinks 145 MB → 23 MB**, install is ~6× faster.
5. **pgvector is solved** — version 0.8.1 (latest), zero per-platform packaging work.
6. **Tauri shell becomes simpler** — only one subprocess (the MCP server), not two (PG + MCP).

Trade-offs to be honest about:

- **Single connection.** Our current code uses a connection pool. We'll need a small queue wrapper around PGlite or accept serialized DB access. For our workload (one MCP client at a time, plus a small dashboard) that's almost certainly fine.
- **Postgres 17, not 18.** We've never depended on a 17→18 feature, but worth verifying.
- **No external `psql` access for debugging.** Need to expose a "SQL prompt" inside the dashboard or a tiny CLI that pipes through PGlite. Not hard.
- **PostgREST replacement is a separate question.** Today the dashboard server proxies PostgREST; with PGlite, no PostgREST. Either embed a thin REST-over-PGlite shim, or move the dashboard to a direct in-process query path (cleaner long-term).

## Suggested follow-up sub-tasks (if Path A.2 is approved)

These are issue-shaped work items, ordered by dependency. Each is its own PR. Estimates assume tick pace.

1. ~~**Latent migration bug fix** — `revoked_keys` is in deferred 038 but referenced by active 040.~~ **Done.** Filed as [#180](https://github.com/Dewinator/mycelium/issues/180), fixed in active migration `038_trust_substrate_minimal.sql`. Spike re-run confirms all 79 active migrations green.
2. **PGlite adapter under `mcp-server/src/native/pglite.ts`** — same shape as `services/supabase.ts`, with a serialized query queue. ~1 tick. *Foundation in flight as PR [#185](https://github.com/Dewinator/mycelium/pull/185) (issue [#184](https://github.com/Dewinator/mycelium/issues/184)).*
3. **Drop PostgREST in the native build** — dashboard-server gets a `/db` endpoint that routes through the PGlite adapter. ~1–2 ticks (existing PostgREST proxy stays for the Docker build during transition).
4. **Spike 2 adapted** — `node-llama-cpp` for embeddings + chat (issue [#178](https://github.com/Dewinator/mycelium/issues/178)). Independent of this spike's outcome. *In flight: PRs [#187](https://github.com/Dewinator/mycelium/pull/187), [#188](https://github.com/Dewinator/mycelium/pull/188), [#189](https://github.com/Dewinator/mycelium/pull/189), [#190](https://github.com/Dewinator/mycelium/pull/190), [#191](https://github.com/Dewinator/mycelium/pull/191), [#192](https://github.com/Dewinator/mycelium/pull/192), [#193](https://github.com/Dewinator/mycelium/pull/193).*
5. **Tauri shell wraps Node + PGlite + llama.cpp** — single binary, tray icon, OS data dir. Multi-tick.
6. **Cross-platform CI** — even with WASM, we still need to build and sign per-platform Tauri installers. Multi-tick.

## Reproducing the measurements

```bash
cd experiments/native-pg
npm install                        # downloads embedded-postgres binary + pglite WASM (~145 MB total)

node spike.mjs --migrate           # tries embedded-postgres path; fails at 001 (CREATE EXTENSION vector)
node spike-pglite.mjs --migrate    # tries pglite path; expect "migrations all green (79)"
```

Both scripts dump a JSON report to stdout and a one-line verdict to stderr. The committed `report-*.json` files in this directory are from the spike's reference run after the [#180 fix](https://github.com/Dewinator/mycelium/issues/180) landed.

## Pillar check

| Pillar | Effect of adopting PGlite |
|---|---|
| 1 — no cloud dependency | strengthened (no Docker, no daemon, fully embedded) |
| 6 — security | data dir under user control; no socket exposed; OS-keystore encryption is now possible because the file is just a directory |

No pillar weakened.
