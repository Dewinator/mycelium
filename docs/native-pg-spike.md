# Spike 1 — embedded Postgres without Docker

> Status: **complete (recommendation ready)**
> Issue: [#177](https://github.com/Dewinator/mycelium/issues/177) (sub-task of [#176](https://github.com/Dewinator/mycelium/issues/176))
> Branch / PR: `agent/spike-1-embedded-pg`
> Code: [`experiments/native-pg/`](../experiments/native-pg/)
> Reports: [`report-embedded-postgres.json`](../experiments/native-pg/report-embedded-postgres.json), [`report-pglite.json`](../experiments/native-pg/report-pglite.json)
> Platform measured: macOS arm64 (Apple Silicon), Node v25.9

## TL;DR

The embedded-postgres subprocess approach the issue proposed (`@embedded-postgres/*`) **does not work for mycelium today** — the upstream zonky binaries do not include `pgvector`, and the bundle has no `pg_config` or server headers, so we cannot build the extension on the user's machine. Adopting it would force us to build and host our own per-platform `vector.so` artifacts and copy them into the bundle at install time.

There is a much better path: **`@electric-sql/pglite`** (WASM Postgres) ships with pgvector built in, runs in-process inside Node, and is one cross-platform npm dep. It runs **34 of our 78 migrations green** with eight contrib extensions wired in. The first failure is a latent bug in our own migration sequence (`revoked_keys`), not a pglite limitation. See [Path forward](#path-forward).

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

Cold-start on the same machine: **~5 s** (WASM compile + extension wiring + initdb-equivalent + pgvector load). After warm-up, queries are direct in-process function calls.

With the eight extensions our migrations actually use wired in (`vector`, `pg_trgm`, `pgcrypto`, `uuid_ossp`, `btree_gin`, `btree_gist`, `citext`, `hstore`, `tablefunc`), the spike walked **34 of our 78 migrations green** before halting at `040_signed_revocations.sql`.

That halt is **not a pglite limitation** — it's a latent bug in our own migration sequence:

- `040_signed_revocations.sql` does `ALTER TABLE revoked_keys ADD COLUMN ...`
- `revoked_keys` is created in `supabase/migrations.deferred/038_federation_trust.sql`
- Active migrations never create `revoked_keys`

So a fresh install of the active sequence on **any** Postgres distribution should hit the same wall. This is the same class of bug as #174 (036_fix_ancestors_trigger). Filing a separate issue for that — it will need fixing whether we adopt PGlite or not.

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

1. **Latent migration bug fix** — `revoked_keys` is in deferred 038 but referenced by active 040. Either add an active migration that creates the table (subset of 038), or move 040 to deferred. ~½ tick. *Independent of native-app decision — file as separate issue.*
2. **PGlite adapter under `mcp-server/src/native/pglite.ts`** — same shape as `services/supabase.ts`, with a serialized query queue. ~1 tick.
3. **Drop PostgREST in the native build** — dashboard-server gets a `/db` endpoint that routes through the PGlite adapter. ~1–2 ticks (existing PostgREST proxy stays for the Docker build during transition).
4. **Spike 2 adapted** — `node-llama-cpp` for embeddings + chat (issue #178). Independent of this spike's outcome.
5. **Tauri shell wraps Node + PGlite + llama.cpp** — single binary, tray icon, OS data dir. Multi-tick.
6. **Cross-platform CI** — even with WASM, we still need to build and sign per-platform Tauri installers. Multi-tick.

## Spike 1.5 — adapter shipped

> Status: **adapter foundation landed**
> Issue: [#184](https://github.com/Dewinator/mycelium/issues/184) (sub-task of [#176](https://github.com/Dewinator/mycelium/issues/176))
> Code: [`mcp-server/src/native/`](../mcp-server/src/native/), tests under [`mcp-server/src/__tests__/native/`](../mcp-server/src/__tests__/native/)

### What landed

- **`mcp-server/src/native/pglite.ts`** — `PGliteAdapter` class with a `QueryBuilder` that mirrors the slice of `@supabase/postgrest-js`'s surface our services in `mcp-server/src/services/` actually use:
  - `from(t).select|insert|update|delete().eq|neq|gt|gte|lt|lte|in|or|order|limit().single|maybeSingle()`
  - `rpc(name, args)` with named-arg call shape and PostgREST-equivalent scalar-vs-set unwrapping.
  - Returns the same `{ data, error }` envelope as `PostgrestClient`, including `PGRST116` for `single()` misses.
- **`mcp-server/src/native/factory.ts`** — `createNativeDb({ dataDir, migrationsDir, skipMigrations })` wires the eight contrib extensions (`vector`, `pg_trgm`, `pgcrypto`, `uuid_ossp`, `btree_gin`, `btree_gist`, `citext`, `hstore`, `tablefunc`) and runs migrations on first start. Default data dir per platform: `~/Library/Application Support/mycelium/data` (macOS), `$XDG_DATA_HOME/mycelium/data` (Linux), `%APPDATA%/mycelium/data` (Windows). Override via `MYCELIUM_PGLITE_DATA_DIR`.
- **`mcp-server/src/native/migration-runner.ts`** — idempotent migration runner. Walks `supabase/migrations/*.sql` lexicographically, tracks applied files in a small `mycelium_pglite_migrations` bookkeeping table, throws on first failure so server bootstrap bails before MCP tools start serving.
- **`mcp-server/src/__tests__/native/pglite-adapter.test.ts`** — 16 contract tests against a real in-memory PGlite instance. Cover insert/select/update/delete, single/maybeSingle, in() with empty array, neq+gte combinations, or() filter, jsonb round-trip, vector column, rpc scalar + setof, queue serialization, and queue-survives-error. All green.

### Design choices worth flagging

- **Single Promise-chain queue.** PGlite is single-connection by design; concurrent service calls would race on the shared cursor. The adapter serializes every op through one queue and keeps the chain alive past failures (the catch-and-swallow in `run()` is intentional: a SQL error must not poison subsequent ops).
- **Explicit Postgres casts on serialized parameters.** PGlite is stricter than PostgREST about parameter typing. The `serializeValue` helper emits `$N::vector` for numeric arrays (pgvector textual `[a,b,c]` form), `$N::text[]` for string arrays (Postgres array literal `{"a","b"}`), and `$N::jsonb` for objects / mixed arrays. Without the casts, parametrized inserts into VECTOR / JSONB columns fail with "could not determine data type of parameter $N".
- **`or()` parser is deliberately narrow.** Accepts the PostgREST `col.op.val,col.op.val` shape with `eq/neq/lt/lte/gt/gte`, throws on anything else. Matches what `services/identity.ts` actually emits today; failing loudly beats silently dropping clauses.
- **Surface intentionally narrow.** Adding a verb is a few lines; aiming for full PostgREST parity would be expensive scaffolding for behavior nothing exercises. Grep `\.from\(|\.rpc\(` under `mcp-server/src/` to enumerate the live surface.

### Out of scope for this PR (deliberate split)

The full #184 acceptance asks for the `MYCELIUM_DB_BACKEND=pglite` env switch wired through `MemoryService` *and* the other 23 services that construct their own `PostgrestClient`, plus a CI gate running the entire test suite under `MYCELIUM_DB_BACKEND=pglite`. That is a cross-cutting refactor of every service constructor — kept out of this PR so the foundation lands cleanly first. Tracked as the immediate next sub-task; this PR ships the adapter, factory, migration runner, and contract tests so the wire-up has something stable to plug into.

## Reproducing the measurements

```bash
cd experiments/native-pg
npm install                        # downloads embedded-postgres binary + pglite WASM (~145 MB total)

node spike.mjs --migrate           # tries embedded-postgres path; fails at 001
node spike-pglite.mjs --migrate    # tries pglite path; succeeds through 034, halts at 040
```

Both scripts dump a JSON report to stdout and a one-line verdict to stderr. The committed `report-*.json` files in this directory are from the spike's reference run.

## Pillar check

| Pillar | Effect of adopting PGlite |
|---|---|
| 1 — no cloud dependency | strengthened (no Docker, no daemon, fully embedded) |
| 6 — security | data dir under user control; no socket exposed; OS-keystore encryption is now possible because the file is just a directory |

No pillar weakened.
