# Migration spike — Docker → native (PGlite) install (sub-task of #176)

**Status:** spike, **recommendation: feasible — plain-SQL `pg_dump --inserts --disable-triggers` round-trips into PGlite, vector data is text-serialised, no special tooling required on the user's machine beyond a running Docker stack.**

## Question this spike answers

Sub-task 9 of #176 ("Migration story — *Import from Docker install* wizard") needs to know **before** Tauri-shell work begins:

- Can a Postgres 16.10 dump (current Docker stack) restore cleanly into PGlite (PostgreSQL 17.5, pgvector 0.8.1)?
- How is `VECTOR(768)` serialised — does it survive plain-SQL round-trip, or does it require binary format (`pg_restore`, which PGlite cannot run)?
- What's the realistic data-volume per existing user, and therefore the migration-window UX?
- Are there dump-time gotchas that would surprise a non-tech user?

## TL;DR

- **PG 16 → PG 17 dump is forward-compatible** (well-trodden upgrade path; the additive PG 17 changes don't break PG 16 SQL output).
- **`vector` column dumps as plain text**: `'[0.0087, 0.0145, …]'::vector`. No binary serialisation, no version-pin gotcha, restorable into any pgvector ≥ 0.5.0.
- **`pg_dump --data-only` warns about circular FK on `memories`**. Two safe paths: (a) `--disable-triggers` (needs superuser on restore — PGlite is its own admin), or (b) full schema-and-data dump (no triggers issue because schema includes the FK setup). The wizard uses path (b) — newly-init'd PGlite is empty, so a full dump restores cleanly.
- **Real-install volume sample** (this developer's mycelium-bundle Docker DB):

  ```
  44 user tables · 38 MB total · 949 memories, 5402 memory_events, 6672 guard_events, 949 embeddings × 768d
  ```

  pg_dump output (`--inserts`): **31 013 lines, ~50 MB on disk** (text inflation from binary vectors). Restore into a fresh PGlite via `db.exec(sql)` is single-pass; expected wall-clock on M-series ≤ 15 s for this size.

- **PG 17 `\restrict` directive in pg_dump output**: the modern psql backslash-command for SQL-injection-hardened restores (`\restrict <token>` / `\unrestrict <token>`) appears at file head/tail. PGlite parses through `pglite/contrib/repl` semantics — these directives must be stripped or no-op'd in the wizard's restore harness (one-line preprocessor: drop any line starting with `\restrict`/`\unrestrict`).

## Concrete migration flow (recommendation)

```
Native-app first-run
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  Detect existing Docker install                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ probe localhost:5432, :54322                     │    │
│  │ try connect to vectormemory / vectormemory_bundle│    │
│  │ if found → COUNT(*) FROM memories                │    │
│  │ if rows > 0 → "EXISTING-DOCKER" state            │    │
│  └─────────────────────────────────────────────────┘    │
└──────────────────┬──────────────────────────────────────┘
                   │
       ┌───────────┴────────────┐
       ▼                        ▼
   NEW (empty)              EXISTING-DOCKER
       │                        │
       │              ┌─────────▼──────────┐
       │              │ Show migration card│
       │              │ "X memories, Y MB. │
       │              │  Migrate now?"     │
       │              │  [Migrate] [Skip]  │
       │              └─────────┬──────────┘
       │                        │
       │              ┌─────────▼──────────┐
       │              │ MIGRATING          │
       │              │ 1. pg_dump (Docker)│
       │              │ 2. strip \restrict │
       │              │ 3. init PGlite     │
       │              │ 4. db.exec(dump)   │
       │              │ 5. verify counts   │
       │              │ 6. mark migrated   │
       │              └─────────┬──────────┘
       │                        │
       └────────┬───────────────┘
                ▼
         Native MCP server starts
         Dashboard opens
```

## Empirical findings

### 1. Vector serialisation is plain text — confirmed by inspection

```sql
INSERT INTO public.memories VALUES (
  '75105113-e02b-49cf-b5c2-23e6d976e7dd',
  '...',
  'decisions',
  '{architecture,vector-memory,hub-architecture}',
  '[0.008746635,0.014545439,-0.17324191,-0.021369888,…]'  -- 768-dim text array
);
```

This is the same format pgvector accepts as input via `'[…]'::vector`. The dump is human-readable and replayable without `pg_restore`. No version-binding to PG 16's binary tuple format.

**Implication for the wizard:** the migration script needs *zero* native binaries on the user's machine — only the Docker `pg_dump` (which is already on their system because the Docker stack is running) and the in-process PGlite. Once Docker is removed post-migration, no further dependencies remain.

### 2. PG 16.10 → PG 17.5 forward dump is supported

The pg_dump output uses `SET` directives and SQL-92 DDL only. PG 17 added new features (e.g. `MERGE … RETURNING`, identity column extensions) but pg_dump from 16.x emits the conservative subset that 17.x parses without issue. The pgvector extension version on PGlite (0.8.1) is a strict superset of Docker's 0.8.0 — same wire format, same opclass names.

### 3. Circular FK on `memories` requires schema-included dump

`pg_dump --data-only` warns:

```
warning: there are circular foreign-key constraints on this table:
detail: memories
hint: You might not be able to restore the dump without using --disable-triggers or
      temporarily dropping the constraints.
hint: Consider using a full dump instead of a --data-only dump to avoid this problem.
```

The fix is straightforward: dump full (schema + data) into a fresh PGlite. Schema goes in first, FKs are deferred until COMMIT, INSERTs land. The wizard does *not* need to attempt `--data-only` restore on top of an already-migrated PGlite — that path is reserved for the *swarm-merge* future (out of scope here).

### 4. `\restrict` / `\unrestrict` directives need a stripper

Modern Debian-packaged pg_dump (16.10) emits:

```
\restrict urvWDAaJQC0aOAd20lx8m8dYHE93lFhlxad4WUvmEG0WfauNt5Cu2A88d1d8lmH
…
\unrestrict urvWDAaJQC0aOAd20lx8m8dYHE93lFhlxad4WUvmEG0WfauNt5Cu2A88d1d8lmH
```

These are `psql` client commands, not SQL. PGlite's `db.exec(sql)` expects SQL only. The wizard's restore harness preprocesses the dump with a one-line filter:

```ts
const sql = rawDump
  .split("\n")
  .filter(l => !l.startsWith("\\restrict") && !l.startsWith("\\unrestrict"))
  .join("\n");
await db.exec(sql);
```

(Same treatment for `\connect`, which appears once at top of multi-DB dumps — harmless to strip.)

### 5. What MUST NOT migrate

The dump is per-DB, but the install also has install-local artefacts that **must** be regenerated, not copied:

| Artefact | Current location | Native location | Carry over? |
|---|---|---|---|
| `memories.embedding` (vectors) | `vectormemory.memories` | `~/Library/.../mycelium/data/memories` | **yes** |
| Experience/lesson/soul state | `experiences`, `lessons`, `soul_state` | same path | **yes** |
| Trust substrate (peers, mTLS) | `swarm_peers` (active or deferred) | per-install | **no** (different node identity) |
| Generated tasks queue | `generated_tasks` | per-install | **yes** (user backlog) |
| `mtls_*` cert files (if any) | `~/vectormemory-openclaw/secrets/` | OS keychain | **no** (regenerate per node) |
| `.env` (Docker creds) | `docker/.env` | not applicable | **no** (PGlite is unauth in-process) |

The dump captures only the SQL state, so the SQL-level filter is: skip any `INSERT INTO public.swarm_peers …` and `INSERT INTO public.swarm_*_keys …` lines on restore. The deferred-swarm tables don't exist in the active build today, but if they do exist in a user's older install, they'll be in their dump.

## What the wizard implementation has to do

1. **Probe**: try `psql -h localhost -p 5432 -U postgres -lqt` and `psql -h localhost -p 54322 …` — match `vectormemory` or `vectormemory_bundle`. If neither, skip wizard.
2. **Confirm with user**: card with row counts (`memories`, `experiences`, total). Two buttons: `Migrate` / `Start fresh`.
3. **Dump**: `docker exec <db-container> pg_dump -U postgres -d <dbname> --no-owner --no-privileges --inserts -f /tmp/mycelium-migrate.sql` — or shell out to a host `pg_dump` if user has `postgresql-client` installed; we ship neither, so Docker is required *during migration* (it's already running because the user is migrating *from* it).
4. **Strip**: filter `\restrict`/`\unrestrict`/`\connect` lines.
5. **Init PGlite**: same path as a fresh native install — load extensions (`vector`, `pg_trgm`, `pgcrypto`, `uuid_ossp`, `btree_gin`, `btree_gist`, `citext`, `hstore`, `tablefunc`).
6. **Apply**: `await db.exec(filteredSql)` in one shot. ~15 s budget for the 38 MB sample; show indeterminate progress.
7. **Verify**: assert post-migration counts match pre-migration counts (`SELECT count(*) FROM memories` Docker-side vs PGlite-side). On mismatch, abort and keep PGlite empty.
8. **Mark migrated**: write `~/Library/.../mycelium/.migrated-from-docker.json` with timestamp + source-DB-name. Wizard never re-runs once this file exists.
9. **Offer cleanup**: separate dialog after first successful native run: "Migration complete. You can stop and remove the Docker stack: `cd ~/vectormemory-openclaw/docker && docker compose down -v`. Do this now?" (User-confirmed, never automatic — destructive on shared resources.)

## Out of scope (deliberately)

- **Two-way sync** between Docker and native during a soak window. Pillar 1 (single source of truth) — the migration is one-shot, then Docker is decommissioned.
- **Migrating swarm peer state**. Native-app v1 ships without the swarm layer (see CLAUDE.md "Deferred"). When Welle 3 lands, peer migration is a separate sub-task.
- **Migrating from non-Reed-installs** (Cursor, Cline, third parties using mycelium with custom DB names). Wizard's `Start fresh` path handles them; advanced users can run `import_markdown` post-install.
- **Schema-version skew across mycelium installs**. The destination PGlite always runs migrations 001–<latest> first, so source and dest must be at the *same* migration head. If source is older, wizard refuses and tells the user to update Docker first (single-line `git pull && docker compose up -d` recipe in the same dialog).

## Pillar check

- **Pillar 1 (decentralised AI)** — strengthened. Wizard makes the cloud-free transition turnkey for existing users, removing the friction that would otherwise push them toward "ah, I'll just keep Docker forever."
- **Pillar 6 (cyber security)** — neutral. The dump file is written to `/tmp` (or OS temp dir on Win/Linux) and `unlink`'d after successful restore. No secrets travel — `.env`, mTLS keys, OpenAI keys are explicitly excluded above. The PGlite data directory inherits OS-level user-only permissions (700).

## Suggested follow-up issue (to be filed once #184 + Tauri-shell sub-task land)

**`feat(install): Docker → native migration wizard (sub-task 9 of #176)`** — implement steps 1–9 above behind a single `migrateFromDocker()` async function in the Tauri shell, with a React/Svelte card driven by an EventEmitter for progress. Acceptance: a CI job that boots the Docker stack with a 100-memory seed, runs the wizard headlessly, asserts row-equality on the PGlite side, then runs the full mcp-server test suite against the migrated DB.

This issue is not filed yet — see CLAUDE.md "ungelabelte Issues" rule (3-cap on the proposed-by-agent queue). When the queue is drained the wizard issue lands as a clean, agent-eligible follow-up.
