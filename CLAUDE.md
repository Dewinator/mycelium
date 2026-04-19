# CLAUDE.md — vectormemory-openclaw

## Projektziel

Dieses Projekt ersetzt das dateibasierte Gedächtnissystem von **openClaw** (Markdown-Dateien + sqlite-vec) durch eine **Supabase-Vektordatenbank** (PostgreSQL + pgvector), die lokal per Docker gehostet wird. Ziel ist ein skalierbares, semantisch durchsuchbares Langzeitgedächtnis für den openClaw-Agenten.

## Architektur-Übersicht

```
┌─────────────────────┐     MCP Protocol      ┌──────────────────────┐
│                     │ ◄──────────────────── │                      │
│   openClaw Agent    │                        │  Vector Memory MCP   │
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

Dieses Projekt ist ein **standalone MCP Server**, der als Plugin in eine bestehende openClaw-Installation eingebunden wird. Entwicklung findet hier auf GitHub statt — Installation auf dem Zielrechner (z.B. Mac M4 mit 16 GB RAM).

```
Zielrechner (Mac)
├── openClaw                    ← bereits installiert
├── Ollama                      ← brew install ollama
├── Docker Desktop              ← für Supabase
│   └── Supabase (PostgreSQL + pgvector)  ~500 MB RAM
└── vectormemory-openclaw/      ← git clone + ./setup.sh
    └── MCP Server (Node.js)
```

**Ressourcenbedarf:** ~1 GB RAM gesamt (Supabase ~500 MB, Ollama Embedding ~270 MB)

### Installation auf Zielrechner
```bash
git clone https://github.com/Dewinator/vectormemory-openclaw.git
cd vectormemory-openclaw
./setup.sh    # Prüft Abhängigkeiten, startet Supabase, baut MCP Server
# → Gibt openClaw-Config zum Einfügen aus
```

## Techstack

| Komponente | Technologie | Zweck |
|---|---|---|
| **Vektordatenbank** | Supabase (self-hosted Docker) + pgvector | Speicherung & Suche von Embeddings |
| **Embedding-Modell** | Ollama lokal (`nomic-embed-text`, 768 Dim., ~270 MB RAM) | Textumwandlung in Vektoren (kostenlos, flat) |
| **MCP Server** | Custom TypeScript MCP Server (`@modelcontextprotocol/sdk`) | Schnittstelle zwischen openClaw und Supabase |
| **openClaw Integration** | MCP Server Eintrag in `settings.json` | Einbindung als Tool in openClaw |
| **Sprache** | TypeScript (Node.js) | MCP Server, Migrations, Scripts |
| **Containerisierung** | Docker Compose | Lokales Supabase-Hosting |

## Memory-Architektur (Ziel)

### Bestehend (openClaw Standard)
- **Tier 1**: `MEMORY.md` — Kuratierte Kernfakten (~100 Zeilen), immer geladen
- **Tier 2**: `memory/YYYY-MM-DD.md` — Tägliche Notizen, automatisch geladen
- **Tier 3**: `memory/people/`, `memory/topics/`, etc. — Durchsucht via sqlite-vec + BM25

### Neu (dieses Projekt)
- **Tier 1 & 2**: Bleiben als Markdown (schneller Kontextzugriff, immer im Prompt)
- **Tier 3**: Migration auf Supabase pgvector mit Hybrid-Suche (Vektor + Volltext)
- **Zusätzlich**: Automatische Embedding-Generierung bei Speicherung neuer Erinnerungen

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

### M3: openClaw Integration
- [ ] MCP Server als openClaw-Tool registrieren (TOOLS.md / `.openclaw/settings.json`)
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

### Phase A+B — Fundament + Reproduzierbarkeit (erledigt)
- agents-Registry + Heartbeat (Migration 028)
- Provenance-Tags auf memories/experiences/lessons/soul_traits (029)
- Genome-Modellfelder als dokumentarische Vererbung (030 — **OpenClaw-Config
  bleibt Authority**, Genome spiegelt nur wider)
- `scripts/provision-instance.mjs` — reproduzierbarer Installer
- Dashboard Population-Tab mit Stammbaum-SVG

### Phase C — Pairing-UI (erledigt)
- Breed-Button pro Match-Row, Mutual-Consent-Checkbox
- Genome-Klick öffnet Details-Modal (inherited + provenance counts)
- `/breed` + `/genome-details` Endpoints

### Phase D — Lifecycle & Evolution (in Arbeit)
- Genome archivieren/cullen/reaktivieren mit typed-confirmation
- Fitness-Trendgraph über Zeit im Genome-Modal
- Genome-Tabelle zeigt Status-Pills farbig (active/paused/culled/archived)

### Phase E — Federation (Multi-Host)
- Tailscale-verteilte Instanzen in derselben agents-Registry
- Gateway-URLs als Discovery-Punkt
- Read-only-Sharing einzelner Genome-Profile cross-host
- Voraussetzung für Phase F

### Phase F — "Tinder für Bots" (Population-Matchmaking)

**Kernprinzip: Mutual Consent.** Bots swipen nicht selbst. Jeder User swipt
*für* seinen Bot durch Profile anderer Bots in der gemeinsamen Population.
Match gilt erst wenn beide User unabhängig right-swipen — analog zu Tinder,
keine autonome KI-Paarung. Das bestehende Ethik-Gate (`OPENCLAW_ALLOW_BREEDING`
/ `allow_breeding:true`) bleibt aktiv und wird durch die beidseitige
User-Zustimmung semantisch erfüllt.

**Bot-Profil** (aus Genome + Fitness + Provenance aggregiert):
- Label, Generation, Alter (days since created_at)
- Values + Interests als Tags
- Trait-Parameter (curiosity, exploration, risk, mutation-rate)
- Latest Fitness + Trend (steigend/fallend)
- Provenance-Footprint ("hat 540 Memories, 107 Experiences, 4 Lessons
  beigetragen")
- Notable Traits aus soul_traits (die Persönlichkeit in drei Zeilen)
- Sample Memories (was weiß dieser Bot besonders gut?)

**Swipe-UX:**
- Right = "für Paarung zugelassen" (speichert `user_likes` Eintrag)
- Left = "nicht jetzt" (kein Eintrag)
- Super-like = Right mit Priorität (triggert Push-Benachrichtigung beim
  anderen User)
- Match = beide haben right-swiped → Breeding-Modal öffnet sich mit
  vor-bestätigtem Consent beider Seiten; child_label + mutation_rate +
  inheritance_mode noch vom initiierenden User gewählt

**Sicherheits-Überlegungen:**
- Cross-User-Breeding darf kein Wissen leaken, das der andere Bot nicht
  teilen will → per-Memory `shareable` Flag, Default `true` nur für
  non-private kategorien
- Quell-Bots bleiben als parent_ids referenziert, Kind lebt in der gemein-
  samen Population aber kann einem User "gehören" (`owner_user_id`)
- Ablehnungen (left-swipe) sind privat — der andere User sieht nicht
  wer abgelehnt hat

**Warum das gut ist:**
Macht das Ethik-Gate menschlich bedienbar statt technisch versteckt. Bringt
zwei unabhängige Meinungen ins System (statt einer). Macht Paarung zu einem
sozialen Akt zwischen Menschen, nicht zu einem autonomen AI-Event. Und
schafft den natürlichen Mechanismus warum überhaupt Genomes aus
verschiedenen Herkünften zusammenkommen — heute muss *ein* Mensch zwei
Bots kennen, morgen können zwei Menschen ihren jeweiligen Bot vorstellen.

## Projektstruktur (Ziel)

```
vectormemory-openclaw/
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
│   ├── TOOLS.md                 # Tool-Beschreibungen für openClaw
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
- openClaw installiert und konfiguriert

### Setup (Zielrechner)
```bash
# Einmalig:
git clone https://github.com/Dewinator/vectormemory-openclaw.git
cd vectormemory-openclaw
./setup.sh    # Alles automatisch

# Dann in openClaw settings.json einfügen:
# {
#   "mcpServers": {
#     "vector-memory": {
#       "command": "node",
#       "args": ["/pfad/zu/vectormemory-openclaw/mcp-server/dist/index.js"]
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
