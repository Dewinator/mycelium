# Engram-Integration ins vector-memory MCP

Datum: 2026-04-21
Bezugsquelle: `cueplex-engram` v0.15.0 (HEAD 12b9ee9, 2026-04-19) — 10 Agents, 14 MCP-Tools, 20 Migrations, 737 aktive Memories.

## Ausgangslage

vector-memory (vectormemory-openclaw) hatte schon **mehr Migrations (45) und mehr Tools (~90)** als engram. Kernunterschied war *nicht* der Reifegrad, sondern zwei strukturelle Primitive, die engram hat und wir nicht:

1. **Explizite, typisierte Relations zwischen Memories.** Wir hatten nur die undirected/weight-only Hebbian-Links aus Migration 007. Damit ließ sich "A supersedes B" oder "A caused_by B" nicht ausdrücken.
2. **Ein kanonischer Event-Log.** Unsere Lifecycle-Signale waren über mehrere Tabellen verstreut (access-count, neurochem-history, experience_causes, guard_events). Kein Stream, kein per-Agent-Cursor, keine trace_id-Korrelation.

Beides sind Voraussetzungen für einen engram-artigen **Agent-Event-Bus**. Der Rest (Conscience / Consolidator / Synthesizer / Saga / Skuld / Observer) ist Feature-Aufbau *oben drauf*.

## Umgesetzt in dieser Session

### Migration 046 — memory_relations
Neue Tabelle mit 13 Typen (`caused_by`, `led_to`, `supersedes`, `contradicts`, `related`, `overrides`, `originated_in`, `learned_from`, `depends_on`, `exemplifies`, `fixed_by`, `repeated_mistake`, `validated_by`). Gerichtet. `UNIQUE (a_id, b_id, type)`, idempotente Verstärkung via `chain_memories()`. Plus RPCs `memory_why(id)` und `memory_neighbors(id, depth, types)`.

### Migration 047 — memory_events
Append-only Event-Sourcing-Log. 25 Event-Types als CHECK. Nullable `memory_id` für Bus-Level-Events. `trace_id UUID` zur Gruppierung. Auto-Trigger `memories_log_created_trig` erzeugt `'created'`-Events bei jedem INSERT. Plus `memory_history(id)` + `memory_events_since(cursor)` als Poll-Primitive.

### Migration 048 — Bitemporal + Co-Activation Count
`memories.valid_from / valid_until / invalidated_by`. Trigger setzt `valid_until=NOW()` bei `stage='archived'`. `memory_links.coactivation_count` neu (Hebbian bekommt jetzt ein echtes Event-Zählwerk, nicht nur eine Gewichtskurve). RPC `supersede_memory(old, new, reason)` schreibt Relation, Event und setzt Bitemporal-Bounds in einem Aufruf.

### Migration 049 — memory_patterns
Tag-Ko-Vorkommen-Analyse. Support + Lift pro Tag-Paar. Live-Test fand sofort echte Assoziationen: `vectorworks-mcp × vwmcp` (Lift 63), `apple × mail`, `eurotruss × traverse_alu_fd31`.

### MCP-Tools (6 neu)
`chain`, `why`, `memory_history`, `memory_neighbors`, `supersede_memory`, `memory_patterns`. Alle in `src/tools/relations.ts` bzw. `patterns.ts`. Services unter `src/services/relations.ts`.

### Agent-Event-Bus (Phase 3 Foundation)
- `src/agents/event-bus.ts` — 5s-Polling, Cursor pro Agent, Cold-Start-Lookback 10min, Cycle-Guard (`source.startsWith('agent:')`).
- `src/agents/coactivation-agent.ts` — erster konkreter Subscriber. Hört auf `used_in_response`, batcht per trace_id mit 30s Debounce, ruft `coactivate_pair()` pairwise auf. Das ersetzt die bisherige "Client muss selbst ko-aktivieren"-Logik.
- **Opt-in:** `OPENCLAW_AGENT_BUS=1` in der MCP-Config aktiviert den Bus. Default aus, damit Produktionsinstanz unverändert läuft bis das Feature explizit ausgerollt wird.

## Bewusst weggelassen

| engram-Feature | Warum nicht übernommen |
|---|---|
| Separate `training_data`-Tabelle (LoRA) | OpenClaw-Gateway hat eigene Trainings-Pipeline; Duplikation vermeiden. |
| Eigenes Ollama-Deployment im MCP | Wir nutzen das bereits laufende lokale Ollama + Qwen über OpenClaw-Gateway. Zweitinstanz wäre RAM-Verschwendung auf M4/16GB. |
| Prom-Metrics + Dashboard-Tab-Redesign | Unser Dashboard (Port 8787) deckt das bereits ab. |
| Hooks-REST (`/api/hook/*`) | In Claude Code laufen Hooks heute via direkter MCP-Tool-Calls; REST-Fassade wäre Scope-Creep. |

## Phase 3b — Offen (nicht blockierend)

Die engram-Agents, die einen LLM-Call brauchen, sollten zum **OpenClaw-Gateway (`ws://127.0.0.1:18789`)** sprechen, nicht ein zweites Ollama starten:

- **ConscienceAgent**: `subscribedEvents=['created']`. Bei jedem neuen Memory → Qwen-Prompt "widerspricht das früherem Wissen?" über Gateway. Bei Widerspruch `log_memory_event(..., 'conscience_warning')` + optional `chain(new, old, 'contradicts')`.
- **ConsolidatorAgent**: Polling auf `experiences` statt `memory_events`. Bei N unreflektierten Episoden → `reflect()` + `record_lesson()` via vorhandene Tools. Das ist fast schon implementiert (wir haben `digest` + `reflect` als manuelle Tools) — Agent-Variante = automatisiert, stündlich.
- **SynthesizerAgent**: `subscribedEvents=['promoted']`. Wenn 3+ Lessons gleiche Tag-Cluster haben (über `memory_patterns`) → Meta-Rule als neues Memory mit type=rule.
- **SagaAgent**: Kein Subscriber — nur Read-Interface. Lässt sich komplett über `memory_neighbors` bauen.

## Konkrete nächste Schritte

1. **In Produktion aktivieren:** `OPENCLAW_AGENT_BUS=1` in der Repo-`.mcp.json` setzen. Server neu starten.
2. **`used_in_response`-Events tatsächlich generieren.** Aktuell schreibt niemand diese Events. Entweder: (a) im digest-Tool bei `tools_used` die genannten Memory-IDs als Event loggen, oder (b) im recall-Tool einen optionalen `emit_used=true` Parameter.
3. **Dashboard: Relations-Tab.** Synaptischer Graph aus `memory_relations` — Force-Physics-Canvas wie bei engram. Port 8787 um einen Tab erweitern.
4. **ConscienceAgent als erstes Gateway-backed Agent.** Minimaler Prompt, Qwen mit 16k context.

## Testbefehl

```bash
# Migrations einspielen
cd ~/vectormemory-openclaw && bash scripts/migrate.sh

# Build
cd mcp-server && npm run build

# Smoke-Test
source ~/vectormemory-openclaw/docker/.env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 54322 -U postgres -d vectormemory -c \
  "SELECT jsonb_pretty(memory_patterns(0.01, 10, NULL));"
```
