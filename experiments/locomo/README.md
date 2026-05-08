# LoCoMo benchmark for mycelium

[Snap Research LoCoMo](https://github.com/snap-research/locomo) (ACL 2024,
Maharana et al.) evaluates very-long-term conversational memory: 10
multi-session conversations between two personas, ~340 turns each, ~199
QA pairs per conversation across 5 reasoning categories (single-hop,
multi-hop, temporal, commonsense, adversarial).

This experiment plugs LoCoMo into mycelium:

1. **Ingest** every turn of a conversation as a project-scoped memory.
2. **Run** every QA pair through `MemoryService.search` (the production
   recall path, scoped to that conversation's project) plus a local LLM
   answerer.
3. **Judge** predictions vs gold answers with an LLM-as-judge.

Default judge is local `qwen3:8b` — a full run costs $0. Cross-check with
GPT-4o-mini or Claude Haiku is one flag away when you want a stronger
oracle.

## Prerequisites

- Mycelium Supabase + Ollama running (the standard mycelium dev stack).
- Built MCP-server dist (`cd mcp-server && npm run build`) — the scripts
  import from `mcp-server/dist`.
- `nomic-embed-text` and `qwen3:8b` pulled in Ollama.

## Quickstart — single-conversation smoke run

```bash
cd ~/vectormemory-openclaw

# 1. Ingest 20 turns of the smallest sample, just to sanity-check.
node experiments/locomo/ingest-locomo.mjs --conv=conv-26 --max-turns=20 --reset

# 2. Answer 5 QA pairs.
node experiments/locomo/run-locomo.mjs --conv=conv-26 --max-qa=5

# 3. Judge with local qwen.
node experiments/locomo/judge-locomo.mjs --conv=conv-26
```

After the smoke is green:

```bash
# Full single-conversation run.
node experiments/locomo/ingest-locomo.mjs --conv=conv-26 --reset
node experiments/locomo/run-locomo.mjs --conv=conv-26
node experiments/locomo/judge-locomo.mjs --conv=conv-26
```

## All 10 conversations

```bash
node experiments/locomo/ingest-locomo.mjs --all
for c in $(node -e 'const d=require("./experiments/locomo/dataset/data/locomo10.json");console.log(d.map(s=>s.sample_id).join(" "))'); do
  node experiments/locomo/run-locomo.mjs --conv=$c
  node experiments/locomo/judge-locomo.mjs --conv=$c
done
```

## Cross-check with a cloud judge

```bash
export OPENAI_API_KEY=sk-...
node experiments/locomo/judge-locomo.mjs --conv=conv-26 --judge=openai --judge-model=gpt-4o-mini

# or
export ANTHROPIC_API_KEY=...
node experiments/locomo/judge-locomo.mjs --conv=conv-26 --judge=anthropic --judge-model=claude-haiku-4-5-20251001
```

Estimated cost for a full run with `gpt-4o-mini` as judge: ~$1–2 per
conversation, ~$10–20 for all 10.

## Outputs

- `out/<sample_id>/predictions.jsonl` — one row per QA: question, gold,
  prediction, retrieved dia_ids, latency.
- `out/<sample_id>/judgment.json` — verdicts + per-category accuracy +
  retrieval-evidence-recall (fraction of QA where at least one gold
  evidence turn was retrieved in the top-K).

## Design choices

- **One project per conversation** (`locomo-<sample_id>`). Recall is
  scoped to the project, so memories from other LoCoMo conversations
  cannot leak into the answer context.
- **Direct insert, bypassing dedup.** `MemoryService.create()` skips
  inserts whose embedding cosine-sims ≥ 0.92 with an existing row. For
  short turns ("Yeah.", "Sure.") that would silently drop data, so the
  ingest writes directly to the `memories` table with `embeddings.embed`.
  All other production fields (tags, project_id, source, metadata,
  category) are populated normally.
- **Chronological context ordering.** Recall returns top-K by relevance,
  but the answerer sees them sorted by `dia_id` (session.turn) so it can
  reason about temporal order without us pre-summarising.
