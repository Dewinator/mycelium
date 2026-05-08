# LoCoMo benchmark for Mycelium

> Public benchmark adapter that lets anyone reproduce — and compare —
> Mycelium's memory quality against published numbers from Mem0, Zep,
> MemGPT/Letta, LangMem, and full-context-LLM baselines.

**English instructions are below the German section.**

---

## 🇩🇪 Anleitung (Deutsch)

### Was ist das?

LoCoMo (*Long Conversation Memory*, Snap Research 2024) ist der etablierte
Benchmark für „kognitive Schichten" / Memory-Layer für LLM-Agenten.
Konkurrenten wie **Mem0**, **Zep / Graphiti**, **MemGPT / Letta** und
**LangMem** publizieren ihre Zahlen darauf. Dieser Adapter fährt LoCoMo
gegen Mycelium und schreibt einen vergleichbaren Bericht.

### Was du brauchst

1. **Mycelium komplett aufgesetzt** — Docker-Stack läuft (Supabase /
   pgvector), Ollama läuft mit `nomic-embed-text` gepullt, MCP-Server
   gebaut (`cd mcp-server && npm run build`).
2. **Python ≥ 3.10**.
3. **LoCoMo-Datensatz** als JSON-Datei.
4. **Mindestens einen LLM-Zugang** — entweder ein API-Key oder Claude
   Code via OAuth (Pro/Max-Abo).

### Schritt 1 — Setup

```bash
cd scripts/benchmarks/locomo
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
```

### Schritt 2 — Dataset besorgen

Lade den LoCoMo-Datensatz von Hugging Face herunter und lege ihn als
`data/locomo10.json` ab:

```bash
mkdir -p data
# Datensatz: https://huggingface.co/datasets/snap-research/locomo
# Lade die JSON-Datei (z.B. locomo10.json) und kopiere sie nach data/
```

Der Loader akzeptiert zwei Datenformen — die rohe Hugging-Face-JSON und
flache `sessions`-Listen. Beide werden automatisch erkannt.

### Schritt 3 — LLM-Provider konfigurieren

In `config.yaml` setzt du, **wer die Antworten generiert** und **wer
sie bewertet** (LLM-as-judge). Du kannst beide Rollen unterschiedlich
besetzen.

#### Variante A — OpenAI API-Key (deine Flat / dein API-Budget)

```yaml
answer_provider:
  kind: openai
  model: gpt-4o-mini      # günstiger Answerer
  api_key_env: OPENAI_API_KEY

judge_provider:
  kind: openai
  model: gpt-4o           # für Vergleichbarkeit mit Mem0/Zep-Papers
  api_key_env: OPENAI_API_KEY
```

```bash
export OPENAI_API_KEY="sk-..."
```

#### Variante B — Claude Code via OAuth (Pro/Max-Abo, keine API-Kosten)

Setzt das `claude` CLI voraus, einmal eingeloggt:

```bash
npm install -g @anthropic-ai/claude-code
claude login          # öffnet Browser, OAuth-Flow
```

Dann in `config.yaml`:

```yaml
answer_provider:
  kind: claude_oauth
  model: sonnet           # nur Info — das Abo wählt das echte Modell
  max_tokens: 256

judge_provider:
  kind: claude_oauth
  model: opus
  max_tokens: 256
```

⚠️ Realismus: Claude Pro/Max hat Rate-Limits. Bei vollem LoCoMo
(~2 000 Antworten + ~2 000 Judge-Calls) wirst du gedrosselt. Empfehlung:
für OAuth nur Smoke-Runs (`--limit-conversations 1 --limit-questions 5`),
für volle Läufe einen API-Key.

#### Variante C — Anthropic API-Key

```yaml
answer_provider:
  kind: anthropic
  model: claude-haiku-4-5-20251001
  api_key_env: ANTHROPIC_API_KEY
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

#### Variante D — Lokal mit Ollama (komplett kostenlos)

```bash
ollama pull qwen2.5:7b-instruct
```

```yaml
answer_provider:
  kind: ollama
  model: qwen2.5:7b-instruct
  base_url: "http://127.0.0.1:11434"
```

Hinweis: Ein lokales 7B-Modell als Judge **verfälscht** die Zahlen
gegenüber publizierten Mem0/Zep-Werten. Wenn du Mycelium gegen die
publizierten Zahlen stellen willst, **muss der Judge GPT-4o-Klasse
sein** (oder das Modell, das die Originalpaper benutzt haben).

### Schritt 4 — Smoke-Test (≤ 5 Min, ~kostenlos)

```bash
python run_benchmark.py \
  --config config.yaml \
  --limit-conversations 1 \
  --limit-questions 5
```

Schaut der Bericht (`results/<timestamp>.md`) sinnvoll aus, bist du
ready für den vollen Lauf.

### Schritt 5 — Voller LoCoMo-Lauf

```bash
python run_benchmark.py --config config.yaml --reset-db
```

`--reset-db` truncated Mycelium's `memories`-Tabelle zwischen
Konversationen, damit sich kein Wissen aus Konversation A in die
Recall-Treffer für Konversation B mischt. Das braucht `psql` im PATH
und einen Zugang zur Supabase-Postgres-DB
(`SUPABASE_DB_URL=postgresql://…` in der Env).

Laufzeit grob: ~1–3 Stunden für den vollen Datensatz, abhängig von
Modellwahl und Hardware.

### Schritt 6 — Ergebnisse vergleichen

In `results/` liegen pro Lauf zwei Dateien:

- `<run_id>.md` — Kurzbericht mit Headline-Zahlen + Per-Kategorie-Tabelle
- `<run_id>.json` — Roh-Daten inkl. jeder Frage, Antwort, Judge-Begründung

Vergleichswerte (Stand der jeweiligen Veröffentlichung — bitte vor
deinem Vergleich aktuell nachprüfen, die Zahlen bewegen sich):

- **Mem0** — Paper auf arXiv, GitHub: `mem0ai/mem0`
- **Zep / Graphiti** — Paper auf arXiv, GitHub: `getzep/graphiti`
- **MemGPT / Letta** — GitHub: `letta-ai/letta`

**Wichtig für Vergleichbarkeit:** Stelle sicher, dass du dasselbe
Judge-Modell und denselben LoCoMo-Subset wie das Vergleichspaper
benutzt. Sonst sind die Zahlen nicht aussagekräftig — egal wie gut
oder schlecht Mycelium abschneidet.

### Caveats — ehrliche Einschränkungen

- Mycelium's `recall` filtert **nicht** automatisch nach `source`. Ohne
  `--reset-db` kann Wissen über Konversationen hinweg bluten.
- `category` beim Ingest ist immer `general` — Mycelium's Auto-Kategorisierung
  via `absorb` ist nur aktiv, wenn `mycelium.ingest_tool: absorb` gesetzt ist.
- LoCoMo-Antworten sind oft kurze Phrasen. F1/EM auf normalisierten
  Tokens reicht als Sanity-Check, ist aber **nicht** das, was die Papers
  reporten — die headline-Zahl ist immer die LLM-Judge-Accuracy.
- Affect-Bias bei `recall` ist via `ignore_affect: true` defaultmäßig
  abgeschaltet, damit der Lauf reproduzierbar ist.

---

## 🇬🇧 Instructions (English)

### What is this?

LoCoMo (*Long Conversation Memory*, Snap Research 2024) is the standard
benchmark for AI memory layers / cognitive layers. Established
competitors — **Mem0**, **Zep / Graphiti**, **MemGPT / Letta**,
**LangMem** — publish numbers on it. This adapter runs LoCoMo against
Mycelium and produces a comparable report.

### Prerequisites

1. **Mycelium fully set up** — Docker stack running (Supabase /
   pgvector), Ollama running with `nomic-embed-text` pulled, MCP
   server built (`cd mcp-server && npm run build`).
2. **Python ≥ 3.10**.
3. **LoCoMo dataset** as a JSON file.
4. **At least one LLM access path** — either an API key, or Claude
   Code via OAuth (Pro/Max subscription).

### Step 1 — Setup

```bash
cd scripts/benchmarks/locomo
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
```

### Step 2 — Get the dataset

Download the LoCoMo dataset from Hugging Face and place it at
`data/locomo10.json`:

```bash
mkdir -p data
# Dataset: https://huggingface.co/datasets/snap-research/locomo
# Download the JSON (e.g. locomo10.json) and copy it to ./data/
```

The loader accepts two on-disk shapes — the raw Hugging-Face JSON and
flat `sessions`-list shapes. Both are auto-detected.

### Step 3 — Configure your LLM providers

`config.yaml` sets **who answers** and **who judges**. The two roles
can use different providers.

#### Option A — OpenAI API key (your flat / API budget)

```yaml
answer_provider:
  kind: openai
  model: gpt-4o-mini       # cheap answerer
  api_key_env: OPENAI_API_KEY

judge_provider:
  kind: openai
  model: gpt-4o            # for comparability with Mem0 / Zep papers
  api_key_env: OPENAI_API_KEY
```

```bash
export OPENAI_API_KEY="sk-..."
```

#### Option B — Claude Code via OAuth (Pro/Max sub, no API cost)

Requires the `claude` CLI installed and logged in once:

```bash
npm install -g @anthropic-ai/claude-code
claude login            # opens browser, OAuth flow
```

Then in `config.yaml`:

```yaml
answer_provider:
  kind: claude_oauth
  model: sonnet            # informational only — the sub picks the real model
  max_tokens: 256

judge_provider:
  kind: claude_oauth
  model: opus
  max_tokens: 256
```

⚠️ Realism: Claude Pro/Max has rate limits. Full LoCoMo
(~2 000 answers + ~2 000 judge calls) will hit them. Recommendation:
use OAuth only for smoke runs (`--limit-conversations 1 --limit-questions 5`),
use an API key for full runs.

#### Option C — Anthropic API key

```yaml
answer_provider:
  kind: anthropic
  model: claude-haiku-4-5-20251001
  api_key_env: ANTHROPIC_API_KEY
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

#### Option D — Local Ollama (completely free)

```bash
ollama pull qwen2.5:7b-instruct
```

```yaml
answer_provider:
  kind: ollama
  model: qwen2.5:7b-instruct
  base_url: "http://127.0.0.1:11434"
```

Note: a local 7B model **as judge skews results** versus published
Mem0/Zep numbers. To compare against published numbers, the **judge
must be GPT-4o-class** (or whatever the source paper used).

### Step 4 — Smoke test (≤ 5 min, ~free)

```bash
python run_benchmark.py \
  --config config.yaml \
  --limit-conversations 1 \
  --limit-questions 5
```

If `results/<timestamp>.md` looks sensible, you're ready for a full
run.

### Step 5 — Full LoCoMo run

```bash
python run_benchmark.py --config config.yaml --reset-db
```

`--reset-db` truncates Mycelium's `memories` table between
conversations so knowledge from conversation A doesn't leak into
recall hits for conversation B. This needs `psql` in PATH and access
to the Supabase Postgres DB (`SUPABASE_DB_URL=postgresql://…`
in the env).

Wall-clock estimate: ~1–3 h for the full dataset depending on model
choice and hardware.

### Step 6 — Compare results

`results/` contains two files per run:

- `<run_id>.md` — short report with headline numbers + per-category table
- `<run_id>.json` — raw data including every question, answer, and
  judge reasoning

Reference numbers (as of their respective publications — please
re-check before your comparison; numbers move):

- **Mem0** — paper on arXiv, GitHub: `mem0ai/mem0`
- **Zep / Graphiti** — paper on arXiv, GitHub: `getzep/graphiti`
- **MemGPT / Letta** — GitHub: `letta-ai/letta`

**For comparability:** make sure you use the same judge model and the
same LoCoMo subset as the paper you're comparing against. Otherwise
the numbers are not meaningful — regardless of how Mycelium scores.

### Caveats — honest limitations

- Mycelium's `recall` does **not** automatically filter by `source`.
  Without `--reset-db`, knowledge can bleed across conversations.
- `category` at ingestion time is always `general` — Mycelium's
  auto-categorization via `absorb` only kicks in when
  `mycelium.ingest_tool: absorb` is set.
- LoCoMo answers are often short phrases. F1 / EM on normalized tokens
  is a useful sanity check, but it's **not** the headline number in
  the published papers — that's always the LLM-judge accuracy.
- Affect bias on `recall` is disabled by default via
  `ignore_affect: true` for reproducibility.

---

## File layout

```
scripts/benchmarks/locomo/
├── README.md                # this file
├── requirements.txt         # Python deps
├── config.example.yaml      # template, copy → config.yaml
├── run_benchmark.py         # main entrypoint
├── locomo_loader.py         # dataset reader
├── mycelium_client.py       # MCP stdio wrapper
├── llm_provider.py          # OpenAI / Anthropic / Claude OAuth / Ollama
├── judge.py                 # F1, EM, LLM-as-judge
├── data/                    # gitignored — put locomo10.json here
└── results/                 # gitignored — output reports
```
