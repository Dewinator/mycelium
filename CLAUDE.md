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

### In-Flight — Affect aus Observables (Issue #11)

Der aktuelle `agent_affect`-Zustand wird vom LLM per `affect_apply` gefüttert
und deshalb in der Praxis unterberichtet. Geplanter Umbau: `compute_affect()`
leitet die vier Dimensionen plus valence/arousal aus schon vorhandenen
Tabellen ab (`experiences`, `memory_events`, `skill_outcomes`, `stimuli`) und
läuft per Trigger, nicht per MCP-Call. Formelspezifikation vor Migration:
[docs/affect-observables.md](docs/affect-observables.md).

### Phase A+B — Fundament + Reproduzierbarkeit (erledigt)
- agents-Registry + Heartbeat (Migration 028)
- Provenance-Tags auf memories/experiences/lessons/soul_traits (029)
- `scripts/provision-instance.mjs` — reproduzierbarer Installer

### Aktuelle Richtung (Reed 2026-04-26 Pivot)

Fokus liegt auf dem Neurochemie-Kern: persistentes Vektorgedächtnis,
Affekt-Regulator, 3-System-Neurochemie, REM/SWS-Sleep-Cycles, Hub-Architektur,
Spreading Activation, Emergenz-Indikatoren. Das Ziel ist eine eigenständige
Anwendung, die ohne externen MCP-Client (Claude Code, openClaw, Codex) nutzbar
ist — eingebaute LLM-Einbindung, Agent-Erstellungs-UI, Aufgaben-Verwaltung.
MCP bleibt als optionale Schnittstelle für Flexibilität.

### Deferred Experimental (Code im Repo, Feature-Flags OFF)

Die folgenden Schichten sind gebaut aber im aktuellen Build versteckt
(Env-Vars `MYCELIUM_FEATURE_PAIRING|POPULATION|FEDERATION|TEACHER`,
default `0`). Reaktivierung wenn der Neurochemie-Kern stabil ist.

- **Population/Genome-Stammbaum** — Lineage-Tabelle, Fitness-Trends,
  Lifecycle-Aktionen (`/genomes`, `/fitness-history`, `/genome-lifecycle`,
  `list_agents`, `snapshot_fitness`, `genome_inheritance`, `collect_current_knowledge`).
- **Pairing/Tinder** — Mutual-Consent-Swiping zwischen Bots zweier User,
  Wright's-F-Inbreeding-Check, Breed-Modal (`/tinder/*`, `/breed`,
  `breed_agents`, `tinder_*`).
- **Federation/mTLS** — Tailscale-verteilte Instanzen, signed-lineage
  Bundles, Trust-Roots, Revocations, Peer-Directory (`/federation/*` auf
  `:8788`, `federation_*`, `trust_*`, `peer_*`, `revocation_*`,
  `genome_keygen|sign|verify|refresh_merkle`).
- **Teacher** — File-basierte Plans/Escalations für openClaw-Plugin
  (`/teacher/*`, `~/.openclaw/teacher-{plans,escalations}/`).

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
