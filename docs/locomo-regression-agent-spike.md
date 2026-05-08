# Spike — `LocomoRegressionAgent` (built-in memory-quality regression bench)

**Status:** spike (not yet implemented)
**Anchors:** issue (TBD on landing), depends on baseline run from #213
**Owner:** Reed (PL), implementor TBD via tick

## Goal

Detect regressions in mycelium's memory quality without external infrastructure. Whenever something in the recall pipeline changes — embedding provider swap (#187/#190), spreading-activation tweak, scope-aware-recall updates, REM diversity filter — we want a numerical signal *from inside mycelium itself* that says "memory got worse" before it ships.

Today, this would only surface if Reed manually re-ran `experiments/locomo/run-and-judge-all.sh`. That's fine for a one-shot baseline, but it's not how a brain stays healthy. The brain needs its own self-test loop.

## Non-goals

- **No CI integration in this spike.** CI is a separate channel (and a separate issue) — this spike is about the *built-in* path. CI may later call the same agent for pre-merge gating.
- **No replacement of LoCoMo with a synthetic bench.** LoCoMo is the empirical anchor. The agent runs the real benchmark on real data; it does not invent a faster proxy.
- **No vendor / no gateway.** Same constraint as the rest of mycelium: Ollama or llama.cpp via the existing provider abstractions (`EmbeddingProvider`, `ChatProvider`), period.

## Architecture

The agent lives next to the existing five (`event-bus`, `coactivation-agent`, `conscience-agent`, `salience-reactor`, REM digest):

```
mcp-server/src/agents/
├── event-bus.ts              (existing)
├── coactivation-agent.ts     (existing)
├── conscience-agent.ts       (existing)
├── salience-reactor.ts       (existing)
└── locomo-regression-agent.ts  (NEW — this spike)
```

It implements the `Agent` interface exported from `event-bus.ts` (`name`, `start()`, `stop()`), but it is **not** event-driven — it's a wall-clock timer. That's deliberately different from the other four. Memory regression is a property of the *whole* memory system, not of any single event, so no event-bus subscription is needed.

```ts
export interface LocomoRegressionConfig {
  enabled: boolean;                  // MYCELIUM_LOCOMO_REGRESSION=1
  intervalHours: number;             // default 168 (weekly)
  conversation: string;              // default "conv-26" (smallest)
  maxQa?: number;                    // default null = full conv (~199 QA)
  topK: number;                      // default 25
  driftThresholdPp: number;          // default 5  → emit stimulus on drop
  embeddingProvider: EmbeddingProvider; // injected, not constructed
  chatProvider: ChatProvider;        // injected, not constructed
}
```

Provider injection matters: the agent must use whatever the running mycelium instance has configured. If you're on llama.cpp natively, the bench runs against llama.cpp. If you're on Ollama dev-time, it runs against Ollama. Same code path the user actually uses → same regression signal.

## Schedule

- **Env-toggled.** `MYCELIUM_LOCOMO_REGRESSION=0` by default. Opt-in until the spike phase is over and the bench has stabilised.
- **Wall-clock timer**, not event-based. `setInterval(intervalHours * 3600 * 1000, run)`.
- **Skews start by ±10%** so multiple instances don't collide with each other or with REM.
- **Defers to nightly-sleep.** If `runRem()` is in flight, wait — the bench reads memories that the digest may be writing.
- **Backs off on consecutive failures.** Three failures in a row → exponential backoff to once per 24 h.

Default cadence: **weekly on the canonical conversation (~30 min wallclock).** That is enough to catch regressions on a real codebase, cheap enough to run without cost, and short enough that a developer doesn't notice the load.

A second tier — full 10-conversation run — is left to the manual script. The agent should NOT auto-run a 6 h job; that's a Reed-decision, not an agent-decision.

## Bootstrap dependency

LoCoMo dataset (`experiments/locomo/dataset/`) is gitignored. The agent must check on first run and either:

- **(preferred)** call `git clone --depth 1 https://github.com/snap-research/locomo.git experiments/locomo/dataset` itself, or
- skip with a `console.warn` and emit a single stimulus telling the user to bootstrap.

Cloning is ~3 MB and one network call — acceptable. Skip-with-warning is the safe fallback if the network is unavailable.

## Output channels

After each run the agent writes to **three** durable places:

1. **Pinned vector-memory** (project-scoped to `mycelium`). One row per run:
   ```
   [📌 projects] LoCoMo regression 2026-05-15:
   conv-26, accuracy 41.7%, evidence-recall 88.4%,
   per-cat {1: 52.3%, 2: 28.4%, 3: 35.0%, 4: 60.0%, 5: 33.3%},
   judge=local-qwen2.5:7b-instruct, providers=ollama|llama-cpp,
   commit-sha=<sha>
   ```
   Future sessions can `recall query="LoCoMo regression"` and instantly see the trend.

2. **`docs/benchmarks/locomo-history.md`** (committed). Append-only Markdown table:
   ```
   | date       | commit  | accuracy | ev-recall | cat 1 | cat 2 | cat 3 | cat 4 | cat 5 |
   |------------|---------|---------:|----------:|------:|------:|------:|------:|------:|
   | 2026-05-15 | a1b2c3d | 41.7%    | 88.4%     | 52.3% | 28.4% | 35.0% | 60.0% | 33.3% |
   ```
   The agent stages and commits this file with `chore(bench): locomo regression <date>` (no PR — direct to the local working copy; whether to push is a user decision).

3. **GitHub Issue** — only on **drift > `driftThresholdPp`**. Body links to the previous and current rows in `locomo-history.md`, lists per-category deltas, and tags `bench-regression`. Issue is opened by the agent, label `agent-opened`, requires Reed triage.

The pinned memory in (1) is the most important channel because it survives between Claude Code / Cursor / Codex sessions. (2) gives a human-readable trend. (3) only fires when something actually broke.

## Drift detection

```ts
const previous = await loadLastRow();        // from locomo-history.md
const delta_pp = (current.accuracy - previous.accuracy) * 100;
if (delta_pp < -config.driftThresholdPp) {
  await emitDriftStimulus({ previous, current, delta_pp });
  await openDriftIssue({ ... });
}
```

Per-category deltas are surfaced too — a 5 pp overall drop with a 15 pp single-hop drop is a sharper signal than the headline.

The opposite case (improvement > `driftThresholdPp`) is **not** silent: agent emits a `mark_used` event on the configuration changes since last run (recent `decisions` memories tagged `recall-tuning`, `embedding-provider`, etc.) so spreading-activation links them to the win. This makes the brain learn what changes correlate with quality gains.

## Pruning

Predictions for old runs accumulate. Every 30 days the agent purges `experiments/locomo/out/<sample_id>/predictions.jsonl` for runs whose summary is already in `locomo-history.md`. The summary is the durable artefact; the per-QA jsonl is the working file.

## Risks / open questions

- **Cold-start judge agreement.** Local qwen-as-judge has its own drift. Spike-recommend: keep judge model pinned to a specific Ollama tag (`qwen2.5:7b-instruct`, exact digest captured at agent-init time) so judge-drift doesn't get confused with memory-drift. Re-pin only on user opt-in.
- **Provider mismatch on first run.** If the embedding provider was switched between baseline and first regression run, the absolute number will drop because cosine-spaces don't transfer (cf. #187 cross-validation spike). The agent should **store the embedding provider name** with each row and refuse to compare across providers — only same-provider runs feed drift detection.
- **Bench drift vs. memory drift.** LoCoMo dataset is fixed, but if Reed adds new conversations or edits the schema, every prior row becomes incomparable. Mitigation: hash the dataset file at run time, store the hash in each row, only compare same-hash runs.
- **REM contention.** The bench inserts ~340 turns into one project, then immediately reads them back. If REM is mid-cluster on those memories, results jitter. Mitigation: bench creates its own per-run project (`locomo-regression-<ts>`), reads its own data, deletes the project at the end. No shared state with permanent memories.

## Out-of-scope (for the implementing PR)

- Tauri tray-item "Run regression bench now" — separate issue once the agent ships.
- Public dashboard over `locomo-history.md` — separate issue.
- Multi-conversation regression (>1 conv per run) — only after we have 4+ data points and trust the single-conv signal.
- LLM-as-judge cross-check via cloud (already in scope of #213, not here).

## Acceptance for the spike → implementation PR

- `mcp-server/src/agents/locomo-regression-agent.ts` lands.
- Disabled by default (`MYCELIUM_LOCOMO_REGRESSION` opt-in).
- Wired in `mcp-server/src/index.ts` next to the other agents.
- One smoke test: run with `--dry-run`, verify it would have written the three output channels (no actual side effects).
- `docs/benchmarks/locomo-history.md` exists with a header row + the baseline row from #213.
