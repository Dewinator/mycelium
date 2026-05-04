# DbClient Migration Tracker — Native-App Sub-Story

**Stand 2026-05-04 (195. Tick — empirical recount).** Sub-story of Issue #176 (native standalone
app, sub-task 3). Once `MYCELIUM_USE_PGLITE=1` is honoured by every service,
the MCP server boots in-process against PGlite without ever spinning up
Docker/Supabase. The factory landed on PR #209; the per-service migration
follows as one atomic PR per service.

## Foundation (already merged or in flight)

| PR | What | State |
|---|---|---|
| #209 | `DbClient` factory (`MYCELIUM_USE_PGLITE` switch, `createDbClient()`) | open, CLEAN |
| #210 | `SwarmPinService` migrated (first `.from()`-chain service) | open, CLEAN, stacked on #209 |
| #211 | `SkillsService` migrated (first RPC-only service, shared `dbClient`) | open, CLEAN, stacked on #210 |

## The 22 service-construction sites in `mcp-server/src/index.ts`

Counts come from grep of each service file's `.from(` and `.rpc(` callsites
(see [methodology](#methodology) below). "Class import" tells you whether the
service still imports the heavy `SupabaseClient` (`@supabase/supabase-js`
`createClient` pattern, like SwarmPin before #210) or already speaks
`PostgrestClient` directly (just needs constructor swap, like Skills in #211).

### Group A — already on `PostgrestClient` (constructor-only swap, ~3 lines + tests)

These services already import `PostgrestClient` from `@supabase/postgrest-js`
and create one inline in their constructor. Migration is a one-shot rename:
constructor takes `DbClient` instead of `(url, key)`, drop the inline
`new PostgrestClient(...)` block, route the existing `.from()`/`.rpc()`
chains through the injected client. The PR #211 (Skills) shape is the
template.

| # | Service | LOC | `.from(` | `.rpc(` | Notes |
|---|---|---:|---:|---:|---|
| 1 | `MemoryService` (in `services/supabase.ts`) | 632* | 6 | 14 | Co-located with `supabase.ts` helpers; ctor also takes `embeddings` |
| 2 | `ExperienceService` (in `services/experiences.ts`) | 632 | 0 | 29 | RPC-heavy; ctor also takes `embeddings` |
| 3 | `AffectService` | 144 | 0 | 2 | Tiny |
| 4 | `CausalService` | 151 | 0 | 3 | Tiny — flagged in PR #211 body as a likely next target |
| 5 | `ProjectService` | 223 | 6 | 6 | Mixed `.from`/`.rpc` |
| 6 | `MotivationService` | 195 | 2 | 3 | Ctor also takes `MOTIVATION_URL` + timeout (HTTP for the daemon side; `(url,key)` only for the read-paths) |
| 7 | `IdentityService` | 1084 | 27 | 23 | **Largest service.** Lots of callsites but every one already PostgrestClient — still mechanical, just verbose |
| 8 | `NeurochemistryService` | 169 | 0 | 9 | RPC-only, like Skills |
| 9 | `RelationsService` | 207 | 1 | 6 | Flagged in PR #211 body as a likely next target |
| 10 | `NodeIdentityService` | 227 | 5 | 0 | `.from()`-only |
| 11 | `SwarmPeersService` | 166 | 3 | 0 | `.from()`-only |
| 12 | `RegistryService` (constructed conditionally) | 125 | 0 | 3 | Two construction sites (eager + lazy); both need updating |

*The 632 LOC for `supabase.ts` is the file containing `MemoryService` plus
the shared `MARK_USEFUL_EVENT_TYPE` constant + helpers. Migrating only the
class is fine; the helpers stay.

### Group B — still on `SupabaseClient` (full swap like SwarmPin #210)

These services import `createClient, SupabaseClient` from
`@supabase/supabase-js`. Migration is the PR #210 shape: drop the import,
accept `DbClient`, widen `defaultDeps()` callsites to `{ from(table:
string): any }` because TypeScript can't unify the two backends'
`.from()` generics even though both speak the same chain shape at
runtime (the `pglite-adapter.test.ts` contract tests gate the runtime
equivalence). Per-call widening for `.rpc()` like Skills #211 covers
the rest.

| # | Service | LOC | `.from(` | `.rpc(` | Notes |
|---|---|---:|---:|---:|---|
| 13 | `SwarmAdmitService` | 352 | 6 | 1 | Inbound `POST /swarm/lessons` admission gate — exercise care, this is on the swarm hot path |
| 14 | `SwarmPublishService` | 603 | 2 | 3 | Outbound Tier-A publishing |
| 15 | `SwarmResolveContradictService` | 232 | 0 | 1 | Tiny in `.from`/`.rpc` count, RPC-only |
| 16 | `RemAuditService` | 251 | 2 | 3 | REM-cycle self-audit |
| 17 | `RemPromotionService` | 242 | 2 | 1 | Lesson tier promotion in REM |
| 18 | `RemDiversityService` | 295 | 3 | 1 | §10.4 diversity filter |
| 19 | `LessonContradictionRunner` | 322 | 2 | 1 | Inline-version of LessonContradictionGate, runs in REM |

### Group B-adjacent — helper modules wired through Group B services

These aren't services constructed in `index.ts`, but they import
`SupabaseClient` and expose `default…Deps(db)` factories that producer-
side services (currently `swarm-publish`) call to wire DB access.
Migrating the consuming Group B service to `DbClient` requires flipping
the helper's signature in lockstep — the consumer can't pass `DbClient`
to a helper that still types `SupabaseClient`.

| # | Module | LOC | `.from(` | `.rpc(` | Consumer | Notes |
|---|---|---:|---:|---:|---|---|
| 20 | `lesson-chain.ts` | 501 | 4 | 2 | `swarm-publish` (#14 above) | Exports `defaultLessonChainDeps(db: SupabaseClient)`. Migrating swarm-publish requires this helper to accept `DbClient` so the producer chain works under PGlite too. Land as part of the swarm-publish PR (or as its immediate predecessor) — not a separate service migration |

### Not in scope — no Supabase access

`BeliefService`, `GuardService` are HTTP-only (`BELIEF_URL` / `GUARD_URL`
sidecars); they have no `.from`/`.rpc` callsites and need no migration.

### Out of band — agent classes

The `AgentEventBus`, `CoactivationAgent`, and `ConscienceAgent` (lines
1247–1265 of `index.ts`) are constructed with `(SUPABASE_URL,
SUPABASE_KEY, ...)` too. Treat them as a fourth migration cluster — the
event-bus has a long-running poll loop, so its migration is non-trivial
and should land *after* the 22 services so the pglite-mode boot path is
already exercised by the time we touch the agent layer.

## Recommended PR order

1. **Group A first.** Constructor-only swaps are mechanical, low risk, and
   each one shrinks the surface area of "still on the old pattern" — useful
   pressure for keeping the migration moving. Order within Group A:
   1. `causal` (151 LOC) — already named in #211 body; smallest non-trivial
   2. `relations` (207 LOC) — also named in #211 body
   3. `affect` (144 LOC) — tiniest of all
   4. `neurochemistry` (169 LOC) — RPC-only, like Skills
   5. `swarm-peers` (166 LOC), `node-identity` (227 LOC) — `.from()`-only
   6. `projects` (223 LOC) — mixed
   7. `motivation` (195 LOC) — ctor takes HTTP URL too; widen carefully
   8. `experiences` (632 LOC, RPC-heavy) — biggest RPC-only refactor
   9. `MemoryService` (in `supabase.ts`, ~20 callsites) — central, save for
       later when the migration shape is well-trodden
   10. `identity` (1084 LOC, 50 callsites) — leave for last in Group A;
       largest mechanical change; risk is verbosity not unknowns
   11. `registry` — two construction sites in `index.ts`; verify both
2. **Group B** (SwarmPin shape, full migration). Tackle smallest first to
   keep PRs reviewable:
   1. `swarm-resolve-contradict` (232 LOC, 1 callsite) — smallest
   2. `rem-promotion` (242 LOC, 3 callsites)
   3. `rem-audit` (251 LOC, 5 callsites)
   4. `rem-diversity` (295 LOC, 4 callsites)
   5. `lesson-contradiction-runner` (322 LOC, 3 callsites)
   6. `swarm-admit` (352 LOC, 7 callsites) — care: hot admission path
   7. `swarm-publish` (603 LOC, 5 callsites) — biggest in this group; **must
     also flip `lesson-chain.ts`'s `defaultLessonChainDeps(db)` signature
     in the same PR** (see Group B-adjacent table above)
3. **Agent layer** (`AgentEventBus`, `CoactivationAgent`, `ConscienceAgent`)
   — last; needs its own design doc because of the polling loop.
4. **Async boot flip.** Once every consumer takes `DbClient`, replace the
   inline `new PostgrestClient(...)` in `index.ts` with `await
   createDbClient({ ... })`. That's the moment `MYCELIUM_USE_PGLITE=1`
   actually lights up. **This step gates Issue #176 sub-task 3
   completion.**

## Methodology

```bash
# `.from(` and `.rpc(` callsite count per service file
for f in mcp-server/src/services/*.ts; do
  from=$(grep -c "\.from(" "$f")
  rpc=$(grep -c "\.rpc(" "$f")
  echo "$f: from=$from rpc=$rpc"
done

# Which import is still in use?
grep -l "from \"@supabase/supabase-js\"" mcp-server/src/services/*.ts
grep -l "PostgrestClient" mcp-server/src/services/*.ts
```

The counts are upper bounds (some `.from(` matches occur inside comments or
string literals); the order-of-magnitude is what matters for sequencing.

## Gating signal

When the table above shows **0** services left in Group A and Group B,
Reed can flip the boot flag in `index.ts` and PR the async-boot
refactor. That PR closes sub-task 3 of #176.
