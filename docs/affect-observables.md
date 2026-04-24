# Affect from observables — design doc for `compute_affect()`

Status: design, not yet implemented. Referenced by issue #11.

## Why this doc exists

The current `agent_affect` singleton (migration 019) is updated by
`affect_apply(event, intensity)` calls scattered through `remember`, `recall`,
`absorb`, `digest`. This makes the mood disc on the soul-tab depend on the
LLM honestly setting `valence` / `arousal` in `record_experience` — which in
practice it underfeeds (neutral most of the time even when activity is rich).

The fix is to **compute affect from observables**. The LLM only reads
`agent_affect`; it never writes to it authoritatively. Existing
`update_affect` calls are demoted to pure logging via `memory_events`.

This doc specifies the formulas before any SQL migration is written, so the
formulas are reviewable independent of implementation choices (trigger vs.
cron, plpgsql vs. sql-language, etc.).

## Data surfaces (already in the schema)

Every input to `compute_affect()` must come from a column that already
exists. No new observable tables.

| Surface | Migration | Relevant columns |
|---|---|---|
| `experiences` | 015 | `outcome`, `difficulty`, `user_sentiment`, `tools_used`, `created_at` |
| `memories` | 002 | `useful_count`, `created_at`, `category`, `tags` |
| `skill_outcomes` | 021 | `skill`, `task_type`, `outcome`, `n`, `avg_difficulty`, `last_at` |
| `memory_events` | 047 | `event_type`, `context`, `created_at`, `trace_id` |
| `stimuli` | 022 | `status`, `band`, `collected_at` |
| `agent_affect` | 019 | target row — `compute_affect()` writes here |

`memory_events.event_type` is the key signal: `recalled`, `used_in_response`,
`agent_error`, `agent_completed`, `mark_useful`, `contradiction_detected`,
`contradiction_resolved`, `positive_feedback`, `negative_feedback`. `context`
carries per-event payload (e.g. recall hit count, similarity score).

A `contradiction_resolved` event shares the `trace_id` of the originating
`contradiction_detected`, so the frustration term can close the loop with a
cheap trace-id join instead of walking the memory-relations graph.

## Formulas

All outputs clamped to `[0, 1]` except `valence` which is `[-1, 1]`. Time
windows below are starting defaults — see Tuning notes.

### valence — recency-weighted outcome balance

```
outcome_score(outcome) =
  +1.0 if 'success'
  +0.2 if 'partial'
  -1.0 if 'failure'
   0.0 if 'unknown'

weight(e) = exp(- hours_since(e.created_at) / 24)   -- 24h half-life-ish

valence = sum( weight(e) * outcome_score(e.outcome) )  /  sum( weight(e) )
         over experiences in last 72h
```

Returns `0` if no experiences in window (avoids divide-by-zero).

### arousal — activity intensity

```
event_rate    = count(memory_events last 15min) / 15        -- events/min
tool_diversity = count(distinct tool in experiences.tools_used last 60min) / 10
novel_stimuli  = count(stimuli WHERE status='new' AND collected_at > now()-'6h') / 20

arousal = clamp(0.5 * min(event_rate, 1.0)
              + 0.3 * min(tool_diversity, 1.0)
              + 0.2 * min(novel_stimuli, 1.0))
```

Rationale: arousal spikes during bursts of tool-use and when new external
stimuli land, not when nothing happens.

### curiosity — low-confidence recall + unreflected backlog

```
empty_recalls  = count(memory_events WHERE event_type='recalled'
                       AND (context->>'hits')::int = 0
                       AND created_at > now()-'24h')
low_conf_recalls = count(memory_events WHERE event_type='recalled'
                         AND (context->>'score')::float < 0.4
                         AND created_at > now()-'24h')
cluster_gaps   = count(experiences WHERE NOT reflected
                       AND created_at > now()-'48h')
               / greatest(1, count(experiences WHERE created_at > now()-'48h'))

curiosity = clamp(0.3                           -- baseline
                + 0.02 * empty_recalls
                + 0.01 * low_conf_recalls
                + 0.3  * cluster_gaps)
```

Rationale: curiosity rises when the system keeps asking questions it can't
answer (empty recalls) and when there is unreflected episodic material
waiting to be distilled into lessons.

### satisfaction — success rate × user sentiment × useful-count delta

```
success_rate = count(experiences WHERE outcome='success' AND created_at > now()-'24h')
             / greatest(1, count(experiences WHERE created_at > now()-'24h'))

pleased_ratio = count(experiences WHERE user_sentiment IN ('pleased','delighted')
                      AND created_at > now()-'24h')
              / greatest(1, count(experiences WHERE user_sentiment IS NOT NULL
                                AND created_at > now()-'24h'))

useful_delta  = count(memory_events WHERE event_type='mark_useful'
                      AND created_at > now()-'6h')
              - count(memory_events WHERE event_type='mark_useful'
                      AND created_at BETWEEN now()-'12h' AND now()-'6h')

satisfaction = clamp(0.6 * success_rate
                   + 0.3 * pleased_ratio
                   + 0.05 * tanh(useful_delta / 5.0) + 0.05)
```

Rationale: satisfaction is a lagging signal, so a 24h window. The
`useful_delta` term captures "users are finding more of my memories useful
right now than they were earlier."

### frustration — errors + empty recalls + open conflicts

```
retry_rate    = count(memory_events WHERE event_type='agent_error'
                      AND created_at > now()-'24h')
              / greatest(1, count(memory_events WHERE event_type='agent_completed'
                                  AND created_at > now()-'24h'))

zero_hit_ratio = count(memory_events WHERE event_type='recalled'
                       AND (context->>'hits')::int = 0
                       AND created_at > now()-'24h')
               / greatest(1, count(memory_events WHERE event_type='recalled'
                                   AND created_at > now()-'24h'))

open_conflicts = count(memory_events WHERE event_type='contradiction_detected'
                       AND created_at > now()-'48h'
                       AND NOT EXISTS (…resolution event with same trace_id…))

frustration = clamp(0.4 * retry_rate
                  + 0.4 * zero_hit_ratio
                  + 0.05 * min(open_conflicts, 4))
```

The decay already implemented in `affect_get()` (migration 019) continues to
apply on top — frustration bleeds off even when `compute_affect()` doesn't
run.

### confidence — weighted skill success rate

```
For skills used in the last 48h, weighted by recency of last_at:
  numerator   = sum( n(outcome='success') * exp(-hours_since(last_at)/48) )
  denominator = sum( n(*)                 * exp(-hours_since(last_at)/48) )

confidence = clamp(numerator / greatest(1, denominator))
```

Fallback: if no skill_outcomes activity in 48h, hold previous value
(confidence shouldn't crash to zero just because the agent was idle).

## When `compute_affect()` runs

Two writers, no more:

1. **Trigger on `experiences` INSERT** — fires after each episodic write.
   Cheap, keeps valence/satisfaction/confidence fresh.
2. **Trigger on `memory_events` INSERT** of a small whitelist:
   `recalled`, `agent_error`, `agent_completed`, `mark_useful`,
   `contradiction_detected`. Keeps arousal/curiosity/frustration fresh.

No cron. No MCP-tool-driven writes. `affect_apply()` from migration 019 is
kept for read-compat but the MCP tools (`remember`, `recall`, `absorb`,
`digest`) stop calling it — they log to `memory_events` instead, which the
trigger above picks up.

## Tuning notes

All weights and time windows in the formulas above are **first-pass
guesses**. They must be revisited after 1–2 weeks of real data:

- Per-formula weights (e.g. `0.5 / 0.3 / 0.2` in arousal) should come from
  correlating each term against the ground-truth signal we actually care
  about. For satisfaction that ground-truth is user feedback; for
  frustration it's observed retry storms; for valence it's post-hoc
  labelling of good/bad sessions.
- Time windows (15 min for event rate, 24 h for outcome balance, 48 h for
  conflicts) should be re-derived from the actual distribution of event
  inter-arrival times, not kept because they feel round.
- Baselines (e.g. curiosity's `0.3`) should be chosen so that an idle agent
  sits near neutral, not pinned at an extreme.

Tuning lives in this doc, **not** in the migration. The migration exposes
the weights as constants at the top of `compute_affect()` so they can be
updated without a schema change.

## Decomposition across autonomy ticks

The issue is explicitly too big for one tick. Suggested order:

1. **Doc** — observables → formulas mapping. (done, PR #15)
2. **`recalled` event emission** — MCP tools emit `recalled` memory_events
   with `{hits, score, query_length}` so the future triggers have input
   data from day one. Additive; doesn't replace `affect_apply`. (done)
3. **`mark_useful` / `agent_completed` / `agent_error` emission** — MCP
   plumbing so satisfaction (`useful_delta`) and frustration (`retry_rate`)
   have their input data. Additive. (done)
4. **`contradiction_detected` emission** — ConscienceAgent emits this
   alongside `conscience_warning` (shared `trace_id`) so frustration's
   `open_conflicts` term has a data source and a future
   `contradiction_resolved` event can correlate back. Additive. (done)
4b. **`contradiction_resolved` emission** — `supersede_memory` checks for a
   prior `contradiction_detected` event between (old, new) and emits the
   matching resolution with the same `trace_id`. Lets the frustration term
   count *open* conflicts only, without walking the relations graph.
   Additive. (done)
5. Snapshot-migration: freeze the current `agent_affect` row into a
   historical anchor table before `compute_affect()` starts overwriting.
6. Migration: `compute_affect()` as a pure SQL function returning JSONB
   (no side-effects yet, so it can be tested against live data first).
7. Migration: triggers on `experiences` and `memory_events` that call
   `compute_affect()` and patch `agent_affect`.
8. MCP-server refactor: stop calling `affect_apply` from `remember` /
   `recall` / `absorb` / `digest`; keep the `memory_events` log as the
   authoritative input.
9. CLAUDE.md — link this doc under the Roadmap. (done, PR #15)
10. Post-observation tuning pass (after ~2 weeks of live data).

Each step should be a separate PR so the diff stays reviewable.
