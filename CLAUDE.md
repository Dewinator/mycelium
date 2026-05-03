# CLAUDE.md — mycelium

## Projektziel

mycelium ist eine **eigenständige kognitive Schicht für LLM-Agenten**: persistentes Vektorgedächtnis (Supabase + pgvector, lokal per Docker), Affekt-Regulator, 3-System-Neurochemie, Experience/Soul-Stack, Active Inference, Motivation-Engine, Genome-basierte Evolution und mTLS-Federation. Spricht MCP und funktioniert mit jedem MCP-fähigen Client — Claude Code, Cursor, Cline, Codex, openClaw oder einem anderen.

Historischer Kontext: Der erste Einsatzzweck war, das dateibasierte Markdown-Memory von openClaw durch einen skalierbaren Vektorstore zu ersetzen; daher stammt der Repo-Anfang. Die Architektur ist inzwischen weit darüber hinausgewachsen und frameworkagnostisch.

## Architektur-Übersicht

```
┌─────────────────────┐     MCP Protocol      ┌──────────────────────┐
│                     │ ◄──────────────────── │                      │
│   MCP client (any)  │                        │   mycelium MCP       │
│   (Claude/LLM)      │ ────────────────────► │  Server (TypeScript)  │
│                     │   remember / recall    │                      │
└─────────────────────┘                        └──────────┬───────────┘
                                                          │
                                               Supabase JS Client
                                                          │
                                               ┌──────────▼───────────┐
                                               │  Supabase (lokal)    │
                                               │  Docker Compose      │
                                               │  ┌────────────────┐  │
                                               │  │ PostgreSQL     │  │
                                               │  │ + pgvector     │  │
                                               │  │ + Embeddings   │  │
                                               │  └────────────────┘  │
                                               └──────────────────────┘
```

## Deployment-Modell

mycelium ist ein **standalone MCP Server**, der in beliebige MCP-fähige Clients eingebunden wird. Kein vorgeschriebenes Agent-Framework. Entwicklung findet hier auf GitHub statt — Installation auf dem Zielrechner (z.B. Mac M4 mit 16 GB RAM).

```
Zielrechner (Mac / Linux)
├── MCP client                  ← Claude Code, Cursor, Cline, Codex, openClaw, … (frei wählbar)
├── Ollama                      ← brew install ollama
├── Docker Desktop              ← für Supabase
│   └── Supabase (PostgreSQL + pgvector)  ~500 MB RAM
└── mycelium/                   ← git clone + ./setup.sh
    └── MCP Server (Node.js)
```

**Ressourcenbedarf:** ~1 GB RAM gesamt (Supabase ~500 MB, Ollama Embedding ~270 MB)

### Installation auf Zielrechner
```bash
git clone https://github.com/Dewinator/mycelium.git
cd mycelium
./setup.sh    # Prüft Abhängigkeiten, startet Supabase, baut MCP Server
# → Gibt MCP-Client-Config zum Einfügen aus
```

## Techstack

| Komponente | Technologie | Zweck |
|---|---|---|
| **Vektordatenbank** | Supabase (self-hosted Docker) + pgvector | Speicherung & Suche von Embeddings |
| **Embedding-Modell** | Ollama lokal (`nomic-embed-text`, 768 Dim., ~270 MB RAM) | Textumwandlung in Vektoren (kostenlos, flat) |
| **MCP Server** | Custom TypeScript MCP Server (`@modelcontextprotocol/sdk`) | Schnittstelle zwischen jedem MCP-Client und Supabase |
| **Client-Integration** | MCP Server Eintrag in der Client-Config (`.mcp.json`, `settings.json`, …) | Einbindung in Claude Code / Cursor / Cline / Codex / openClaw / … |
| **Sprache** | TypeScript (Node.js) | MCP Server, Migrations, Scripts |
| **Containerisierung** | Docker Compose | Lokales Supabase-Hosting |

## Memory-Architektur (Ziel)

### In mycelium (primary)
- **Vector store** auf Supabase pgvector mit Hybrid-Suche (Vektor + Volltext), HNSW-Index
- **Automatische Embedding-Generierung** bei Speicherung via Ollama `nomic-embed-text` (lokal) oder OpenAI API
- **Soft-Forgetting** mit Audit-Trail (decay, strength, importance, pinning, useful-count)

### Optional-Framework-Beispiele
Einige Clients haben zusätzlich ein eigenes dateibasiertes Memory (z.B. openClaw's Markdown-Tiers 1–3). mycelium ersetzt oder ergänzt solche Schichten — das ist clientseitige Designentscheidung, kein Muss. `import_markdown` migriert bestehende Datei-Memories in den Vektorstore.

## Datenbankschema (pgvector)

```sql
-- Haupttabelle für Memory-Einträge
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',  -- people, projects, topics, decisions
  tags TEXT[] DEFAULT '{}',
  embedding VECTOR(768),                     -- Dimension abhängig vom Embedding-Modell
  metadata JSONB DEFAULT '{}',
  source TEXT,                               -- Ursprungsdatei oder Konversation
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW-Index für schnelle Vektorsuche
CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);

-- GIN-Index für Volltextsuche
CREATE INDEX ON memories USING gin (to_tsvector('german', content));

-- Hybrid-Suchfunktion
CREATE FUNCTION match_memories(
  query_embedding VECTOR(768),
  query_text TEXT,
  match_count INT DEFAULT 10,
  vector_weight FLOAT DEFAULT 0.7
) RETURNS TABLE (id UUID, content TEXT, category TEXT, similarity FLOAT)
AS $$ ... $$;
```

## MCP Server Tools

Der MCP Server stellt folgende Tools bereit:

| Tool | Beschreibung |
|---|---|
| `remember` | Speichert einen neuen Memory-Eintrag mit Embedding |
| `recall` | Semantische Suche über bestehende Erinnerungen |
| `forget` | Löscht einen Memory-Eintrag |
| `update_memory` | Aktualisiert einen bestehenden Eintrag |
| `list_memories` | Listet Erinnerungen nach Kategorie |
| `import_markdown` | Importiert bestehende Markdown-Memories in die Vektordatenbank |

## Meilensteine

### M1: Infrastruktur (Supabase lokal aufsetzen)
- [ ] Docker Compose für minimales Supabase-Setup (nur PostgreSQL + pgvector + API)
- [ ] `.env`-Konfiguration mit sicheren Secrets
- [ ] pgvector-Extension aktivieren
- [ ] Datenbankschema (Migrations) erstellen
- [ ] Health-Check Script

### M2: MCP Server Entwicklung
- [ ] TypeScript-Projekt mit `@modelcontextprotocol/sdk` initialisieren
- [ ] Supabase JS Client Integration
- [ ] Embedding-Pipeline (Ollama lokal oder OpenAI API)
- [ ] `remember`-Tool implementieren
- [ ] `recall`-Tool mit Hybrid-Suche implementieren
- [ ] `forget`- und `update_memory`-Tools
- [ ] `list_memories`-Tool
- [ ] Unit Tests

### M3: Client-Integration
- [ ] MCP Server als Tool in MCP-Clients registrieren (`.mcp.json`, Cursor settings, openClaw settings, …)
- [ ] SOUL.md / AGENTS.md anpassen für Memory-Nutzung
- [ ] Automatische Memory-Extraktion aus Konversationen
- [ ] Test: Ende-zu-Ende Workflow (Speichern → Suchen → Abrufen)

### M4: Migration & Hybrid-Betrieb
- [ ] `import_markdown`-Tool: Bestehende Tier-3-Markdown-Dateien in Supabase importieren
- [ ] Embedding-Generierung für importierte Dokumente
- [ ] Parallelbetrieb: Markdown-Fallback wenn Supabase nicht erreichbar
- [ ] Validierung: Suchqualität vergleichen (alt vs. neu)

### M5: Optimierung & Produktion
- [ ] HNSW-Index-Tuning (ef_construction, m Parameter)
- [ ] Embedding-Cache für häufige Abfragen
- [ ] Memory-Deduplizierung und -Konsolidierung
- [ ] Monitoring & Logging
- [ ] Dokumentation finalisieren

---

## Roadmap — Cognitive Architecture & Evolution

Die folgenden Phasen bauen auf dem produktiven Stand auf (Migrationen 019–030).
Ziel ist ein sich selbst entwickelndes Multi-Instanz-System nach biologischem
Vorbild, mit konzentrierter Wissensvererbung und user-kuratierter Paarung.

### Landed — Affect aus Observables (Issue #11, Phasen 1–3 done)

`compute_affect()` leitet die vier Dimensionen plus valence/arousal aus
schon vorhandenen Tabellen ab (`experiences`, `memory_events`,
`skill_outcomes`, `stimuli`) und läuft per Trigger, nicht per MCP-Call.
Migration 062 lieferte SQL-Funktion + Trigger (Phase 2); Phase 3 entfernte
den Legacy-`affect_apply`-Schreibpfad aus `remember`/`recall`/`absorb`/
`infer_action`. PRs #28–#40 lieferten den Contract-Test-Layer dazu. Issue
selbst ist `agent-do-not-touch` markiert (Reed-Triage 2026-04-27) — Phase 10
(Tuning nach 1–2 Wochen Echtdaten, surface via `affect_history_series` /
Regulator-Tab in PR #55) bleibt als einziger offener Schritt und wartet auf
Datensammlung. Formelspezifikation: [docs/affect-observables.md](docs/affect-observables.md).

## Roadmap (Reed 2026-04-26)

Klare Reihenfolge — keine Vermischung:

1. **Gehirn perfektionieren.** Wissen, Erfahrung, Motivation, Stimmung,
   Neugier, Vergessen, Schlafen, Vertiefen. Persistentes Vektorgedächtnis,
   Affekt-Regulator, 3-System-Neurochemie, REM/SWS-Sleep-Cycles,
   Hub-Architektur, Spreading Activation, Emergenz-Indikatoren.
2. **Installation so einfach wie möglich.** `install.sh` mit allen
   Abhängigkeiten — Docker-Stack, Ollama-Modell, MCP-Server fertig gebaut.
3. **Dashboard verbessern.** Lesbar, vollständig, Anfänger-tauglich.
4. **Paarung / Vererbung.** (deferred — siehe `src/deferred/`,
   `migrations.deferred/` (033–036), Branch `archive/swarm-deferred`).
5. **Cross-Host-Föderation (mTLS-Listener, Autosync).** (deferred —
   `migrations.deferred/038, 041`, gleiche Branches).

Davon unberührt: die **§10-Schwarm-Mechanik** (Provenance-Commitment,
Contradicts-Gate, Diversity-Filter §10.4, REM-Self-Audit, Plagiarism-/
Sybil-Resistenz — `SWARM_SPEC.md` §10) ist auf `main` aktiv, inkl.
inbound `POST /swarm/lessons`-Admission und outbound Lesson-Feed; sie
geht mit Welle 2 (zweiter Peer) in echten Multi-Knoten-Betrieb. Die
Cross-Wave-Übersicht steht in [`docs/waves.md`](docs/waves.md).

Mehrere Gehirne entstehen durch mehrere mycelium-Instanzen — jeder Anwender
provisioniert pro Rolle (privat / coden / kochen / …) eine Instanz und
verbindet seinen MCP-Client damit. Das einzelne Gehirn weiß nichts von
anderen Gehirnen — die Cross-Host-Trust-Schicht (mTLS-Transport, autosync)
ist die deferred Lage; die §10-Self-Healing-Mechanik darunter ist es nicht.

### Vier Wellen (Reed 2026-05-02) — Bird's-eye view

Reeds Vision vom 2026-05-02 ist als vier sequentielle Wellen organisiert.
Cross-wave Übersicht (was hängt von was ab, welches Doc anchored welche
Welle, was passiert nach jedem Wave-Landing): [`docs/waves.md`](docs/waves.md).
Welle 1 ist die laufende — Details siehe direkt unten.

### Native-App Track (Reed 2026-05-02) — höchste laufende Priorität (Welle 1)

Roadmap-Schritt 2 ("Installation so einfach wie möglich") ist konkretisiert
worden zu **Path A: native standalone App** (macOS / Windows / Linux,
Doppelklick-Installer, kein Docker, kein externes Ollama). Epic: **Issue
#176**. Spike-Phase abgeschlossen — alle 10 Sub-Tasks haben einen Design-
Spike auf `main`:

- `docs/native-pg-spike.md` + `docs/native-pg-platforms-spike.md` —
  PGlite (WASM, in-process, pgvector 0.8.1 built-in) statt
  `embedded-postgres-binaries` (das kennt kein pgvector). 79/79 aktive
  Migrationen grün auf PG 17.5 + pgvector 0.8.1.
- `docs/native-llm-spike.md` + `docs/native-llm-platforms-spike.md` +
  `docs/native-llm-regen-migration.md` — `node-llama-cpp` ersetzt Ollama
  HTTP. Embeddings sind **nicht** zwischen Providern mixbar (cosine-
  Validierung); ein Provider-Wechsel erzwingt Re-Embed-Migration.
- `docs/native-tauri-shell-spike.md` — Tauri 2 Shell + Sidecar (Node
  Subprozess hostet PGlite + llama.cpp). IPC bleibt localhost HTTP für die
  Dashboard-WebView.
- `docs/native-update-ops-spike.md` + `docs/native-update-banner-spike.md`
  — `tauri-plugin-updater` (eine Toolchain) ersetzt Sparkle/MSIX/AppImage-
  Triple aus dem Original-Plan. Banner detektiert
  `window.__TAURI_INTERNALS__` und schaltet zwischen Native-Update-Button
  und Browser-Fallback.
- `docs/native-migration-spike.md` — Docker → Native Wizard via
  `pg_dump --inserts`; Vector-Spalten sind plain-text-portierbar.
- `docs/native-ci-release-spike.md` — single GitHub Release per Tag,
  alle 3 Plattform-Artefakte signiert/notarized.
- `docs/native-docs-refresh-spike.md` — Docker und Native koexistieren in
  README+setup.md; Flip auf signierte v1.0-Native-Releases gegated.

**Aktiver Code-Bestand**: `mcp-server/src/native/` (PGlite Adapter — PR #185),
`services/embeddings.ts` mit `LlamaCppEmbeddingProvider` hinter
`MYCELIUM_LLM_PROVIDER` (PR-Stack #187 → #188 → #189),
`middleware/proxy.ts` mit `EmbeddingProvider`-Injection (PR #190),
`services/chat.ts` mit `ChatProvider`-Abstraction (PR #192). Alle 9
Native-App PRs sind green und MERGEABLE.

**Queue-Stand 2026-05-03**: 14 PRs offen insgesamt — 9 Native-App (#185,
#187–#194) + 3 W4.1 anti-echo (#197 forgery, #198 plagiarism, #201
sybil-flood) + 2 W2 federation (#199 mTLS-listener null-guard, #200
move-deferred-federation-e2e). Keinerlei File-Overlap zwischen den drei
Cohorts (143rd-tick audit). Empirisch validiert (143rd + 148th tick) dass
die 13-PR-Queue in 3 verschiedenen Reihenfolgen — ascending, descending,
newest-first — konfliktfrei mergeable ist (1012/1013 Tests grün, 1
pre-existing Skip); PR #201 ist additiv (eigene neue Test-Datei +
Fixture-JSON, kein Overlap mit den 13).

**Was noch fehlt**: Implementierung von Sub-Tasks 3 (Tauri Shell), 6
(Update Channels), 7 (Migration Wizard), 8 (CI Matrix), 9 (Banner Refit),
10 (Docs Flip). Spikes liegen, Implementierung wartet auf Drain der
aktuellen 14-PR-Queue (Reed mergt manuell, kein Auto-Merge konfiguriert).

### Deferred (geparkter Code)

Pairing/Population/Federation/Teacher sind vollständig vom aktiven Build
getrennt:

- Migrationen unter `supabase/migrations.deferred/`
- TS-Code unter `mcp-server/src/deferred/` (vom `tsconfig` ausgeschlossen)
- OpenClaw-spezifischer Workspace-Provisioner unter `scripts/deferred/openclaw/`
- Voller Stand erhalten auf Branch `archive/swarm-deferred`

## Projektstruktur (Ziel)

```
mycelium/
├── CLAUDE.md                    # Diese Datei
├── README.md                    # Projektbeschreibung
├── docker/
│   ├── docker-compose.yml       # Supabase lokal
│   ├── .env.example             # Umgebungsvariablen Template
│   └── volumes/                 # Persistente Daten
├── supabase/
│   └── migrations/
│       ├── 001_enable_pgvector.sql
│       ├── 002_create_memories_table.sql
│       └── 003_create_search_functions.sql
├── mcp-server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts             # MCP Server Entrypoint
│   │   ├── tools/
│   │   │   ├── remember.ts
│   │   │   ├── recall.ts
│   │   │   ├── forget.ts
│   │   │   ├── update.ts
│   │   │   ├── list.ts
│   │   │   └── import.ts
│   │   ├── services/
│   │   │   ├── supabase.ts      # Supabase Client
│   │   │   └── embeddings.ts    # Embedding-Pipeline
│   │   └── types/
│   │       └── memory.ts
│   └── tests/
├── openclaw-config/
│   ├── TOOLS.md                 # Beispiel-Tool-Beschreibungen (funktioniert mit openClaw; andere Clients nutzen analoge Configs)
│   └── settings.example.json    # MCP Server Konfiguration
└── scripts/
    ├── setup.sh                 # Ersteinrichtung
    ├── migrate.sh               # DB-Migrationen ausführen
    └── import-memories.ts       # Markdown → Supabase Import
```

## Entwicklungsanweisungen

### Voraussetzungen (Zielrechner)
- macOS (Apple Silicon empfohlen, M1+)
- Docker Desktop
- Node.js >= 20
- Ollama (`brew install ollama` + `ollama pull nomic-embed-text`)
- Ein MCP-fähiger Client installiert und konfiguriert (z.B. Claude Code, Cursor, Cline, Codex, openClaw)

### Setup (Zielrechner)
```bash
# Einmalig:
git clone https://github.com/Dewinator/mycelium.git
cd mycelium
./setup.sh    # Alles automatisch

# Dann in die Config deines MCP-Clients einfügen (.mcp.json, Cursor settings, openClaw settings, …):
# {
#   "mcpServers": {
#     "mycelium": {
#       "command": "node",
#       "args": ["/pfad/zu/mycelium/mcp-server/dist/index.js"]
#     }
#   }
# }
```

### Konventionen
- Commit-Messages auf Englisch, Präfix: `feat:`, `fix:`, `docs:`, `infra:`, `test:`
- TypeScript mit strict mode
- SQL-Migrationen nummeriert: `NNN_beschreibung.sql`
- Alle Secrets in `.env`, nie committen
- Tests vor jedem Merge erforderlich

### Wichtige Befehle
```bash
# MCP Server
cd mcp-server && npm run dev          # Entwicklung mit Hot-Reload
cd mcp-server && npm run build        # Produktions-Build
cd mcp-server && npm test             # Tests ausführen

# Supabase
cd docker && docker compose up -d     # Starten
cd docker && docker compose down      # Stoppen
cd docker && docker compose logs -f   # Logs verfolgen

# Migrationen
cd scripts && bash migrate.sh         # Alle Migrationen ausführen
```
