# Embedding regeneration migration — design (#178 follow-up)

**Status:** spec / proposed. No code in this PR; this doc fixes the approach
before the implementation slice ships.

**Driver:** PR #191 (cosine cross-validation spike) measured cross-provider
embedding similarity on the same `nomic-embed-text-v1.5` GGUF and reported
diagonal cosine **avg 0.888 / p05 0.756 / min 0.727** — well below the
0.95 acceptance threshold. Switching `MYCELIUM_LLM_PROVIDER` on an existing
install therefore *silently degrades recall quality* unless every stored
embedding is regenerated under the new provider.

This doc specifies the schema, the startup guard, the regeneration script,
and the CI smoke gate that together make `MYCELIUM_LLM_PROVIDER` safe to
switch.

## Problem

Today `memories.embedding VECTOR(768)` carries no provenance. The MCP
server reads `EMBEDDING_MODEL` / `MYCELIUM_LLM_PROVIDER` from env at
startup and trusts that every stored vector came from the same path. PR
#191 demonstrates that assumption is wrong even when the *model identifier*
is identical: the GGUF tokeniser, normalisation behaviour, and quant level
all shift the vector enough to drop semantic recall meaningfully.

Failure mode if we ship #178 without this work:

1. User on Docker stack accumulates ~1k memories under
   `ollama:nomic-embed-text:v1.5`.
2. They install the native build (Tauri shell, sub-task 5 of #176), which
   defaults to `llama-cpp:nomic-embed-text-v1.5:Q5_K_M`.
3. Recall continues to *work* — vectors are still 768-dim — but quality
   silently drops. New memories get the new provider's vectors; old ones
   keep the old. The two clouds drift apart.
4. The user reports "recall got dumber after the update" with no
   actionable cause.

## Identity scheme

A provider identity is the triple **`provider:model:quant_or_version`**,
serialised as a single lowercase string. Examples:

| Stack                                | Identity                                       |
| ------------------------------------ | ---------------------------------------------- |
| Docker default today                 | `ollama:nomic-embed-text:v1.5`                 |
| Native build (PR #187 default)       | `llama-cpp:nomic-embed-text-v1.5:q5_k_m`       |
| Native build (smaller quant)         | `llama-cpp:nomic-embed-text-v1.5:q4_k_m`       |
| OpenAI fallback (hypothetical)       | `openai:text-embedding-3-small:v3`             |

The `quant_or_version` slot is mandatory. For Ollama we use the model's
manifest version (`v1.5`); for llama-cpp the GGUF quant tag.

`EmbeddingProvider` gains a single new property:

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
  identity: string; // lowercase "provider:model:quant_or_version"
}
```

`OllamaEmbeddingProvider` returns `ollama:${model}:${manifestVersion}` —
the manifest version is read from Ollama's `/api/show` response. Falls
back to `unknown` if Ollama is too old to expose it; the guard then
treats the row as a legacy row (see below).

`LlamaCppEmbeddingProvider` (PR #187) returns
`llama-cpp:${modelSlug}:${quantTag}` derived from the GGUF filename or
the `general.quantization_version` field in the GGUF header.

## Schema

Add one column on `memories`:

```sql
-- supabase/migrations/NNN_embedding_provenance.sql
ALTER TABLE memories
  ADD COLUMN embedding_provenance TEXT NOT NULL
    DEFAULT 'ollama:nomic-embed-text:v1.5';

CREATE INDEX memories_embedding_provenance_idx
  ON memories (embedding_provenance);
```

The default makes the migration **lossless for every existing install** —
all current Docker-stack rows are by definition `ollama:nomic-embed-text:v1.5`.
Index supports the cheap "what fraction of rows are out of sync" query
the dashboard will surface.

The same column is added on every other table that stores its own
embedding column. Audit list (run `grep -rn 'VECTOR(768)' supabase/migrations`):

- `memories.embedding`
- `experiences.embedding`
- `lessons.embedding`
- `intentions.embedding`
- `stimuli.embedding`
- any future `*_embeddings` table

Each gets the same `embedding_provenance TEXT NOT NULL DEFAULT '...'`
column in the same migration.

## Startup guard

On MCP server boot, after migrations finish:

1. Read `provider.identity` from the configured `EmbeddingProvider`.
2. Query `SELECT embedding_provenance, COUNT(*) FROM memories GROUP BY 1`.
3. Decide:
   - **Empty DB / first run** → no rows, write nothing, proceed.
   - **All rows match `provider.identity`** → proceed.
   - **Mismatch found**:
     - If `MYCELIUM_ALLOW_PROVIDER_SWITCH=1` → log a single warning and
       proceed in **degraded-recall mode**. Recall queries get a banner
       in the dashboard ("regeneration pending — N/M rows still on
       `<old>`"). New writes use the new provider's identity and tag the
       row accordingly.
     - Else → **refuse to start**. Print the regeneration command,
       exit 1.

The refusal is intentionally loud. A user who picks a new GGUF quant
gets a clear "you changed providers — run `npm run regen-embeddings`"
message instead of degraded recall.

## Regeneration script

`scripts/regen-embeddings.mjs`:

- Walks every table with an `embedding` column.
- Selects rows where `embedding_provenance != current_provider.identity`.
- Re-embeds in batches of 50 (configurable via `MYCELIUM_REGEN_BATCH`).
- Writes back `embedding` and `embedding_provenance` in the same UPDATE.
- Idempotent: if interrupted, the next run picks up where the previous
  left off (rows with the new identity are skipped).
- Reports progress to stderr: `regen memories: 423/1024 (41%, 12 min ETA)`.
- Final summary: per-table count regenerated, wall-clock time, p99 embed
  latency.

The script is also the only way to legitimately bulk-rewrite vectors;
it deliberately does **not** flip `embedding_provenance` without
re-embedding, so a botched edit can't poison the column.

## CI smoke gate

`mcp-server/src/__tests__/embedding-provenance-cosine.test.ts`:

A frozen reference set — `experiments/native-llm/reference-set/{identity}.json`,
20 representative German+English mycelium texts plus their embedding
under that identity, committed to the repo. The test:

1. Detects the configured `EmbeddingProvider.identity`.
2. Loads the matching reference file.
3. Re-embeds all 20 inputs with the live provider.
4. Asserts diagonal cosine ≥ **0.99** for the same identity (PR #191's
   *intra-provider* sanity floor — same code, same model, same quant
   should reproduce vectors near-identically modulo float jitter).
5. **Skips** if no reference file exists for the configured identity —
   fail-open is the right default; CI should not break for a contributor
   who tries an exotic provider.

Pairing this test with the existing `npm test` makes "I changed provider
or quant and forgot to regenerate the reference set" a build break, not
a runtime surprise.

## Sequencing

This work cannot land while PR #187 is open — it touches
`mcp-server/src/services/embeddings.ts` (the new `identity` field on
`EmbeddingProvider`) and #187 also edits that file.

Suggested ship order once #187 is on `main`:

1. **PR A** — `EmbeddingProvider.identity` interface + implementations
   on both `OllamaEmbeddingProvider` and `LlamaCppEmbeddingProvider`.
   Pure additive contract; no behaviour change. ~80 lines + tests.
2. **PR B** — migration `NNN_embedding_provenance.sql` + `MemoryService`
   teaches every insert to write the column. Default value handles all
   pre-existing rows. ~150 lines + tests.
3. **PR C** — startup guard + dashboard banner. Refuse-to-start path
   + `MYCELIUM_ALLOW_PROVIDER_SWITCH` escape hatch. ~120 lines + tests.
4. **PR D** — `scripts/regen-embeddings.mjs` + the CI smoke gate.
   Brings the loop closed. ~250 lines + reference-set commit.

Each PR is independently mergeable and reverts cleanly.

## Out of scope

- **Online (zero-downtime) regeneration.** v1 is offline-only — the
  MCP server is unavailable while regen runs. A v2 could double-write
  during the transition, but that's complexity nobody has asked for.
- **Cross-dimensional migration** (e.g., 768 → 1024 if a future model
  changes dimensionality). The schema's `VECTOR(768)` is hard-coded;
  changing it is a separate, larger migration.
- **Vector compression / quantisation in pgvector.** Orthogonal — owned
  by a future native-app perf sub-task of #176.

## Pillar check

- **Pillar 1 (decentralised AI)** — neutral. Does not change what runs
  where; only protects recall quality across provider swaps.
- **Pillar 4 (truthfulness)** — strengthened. Replaces silent recall
  degradation with an explicit, named failure mode the user can act on.
- **Pillar 6 (security)** — neutral. No new exposed surfaces, no new
  network calls.

No pillar weakened.
