# Setup-Anleitung — vectormemory-openclaw

Schritt-für-Schritt-Anleitung zum Inbetriebnehmen auf deinem Mac. Geschätzte Dauer: **15–25 Minuten** (plus Modell-Download beim ersten `ollama pull`).

---

## 1. Voraussetzungen installieren

Öffne ein Terminal und prüfe, was bereits da ist:

```bash
which docker node psql ollama
```

Fehlt etwas, installieren:

```bash
# Docker Desktop (wenn nicht installiert)
#   → https://www.docker.com/products/docker-desktop/  herunterladen und installieren

# Node.js >= 20
brew install node@20

# psql (für SQL-Migrationen)
brew install libpq
brew link --force libpq

# Ollama + Embedding-Modell (~270 MB)
brew install ollama
ollama pull nomic-embed-text
```

**Wichtig:** Docker Desktop muss **laufen**, bevor du weitermachst (Whale-Icon in der Menüleiste).

---

## 2. Setup-Skript ausführen

```bash
cd ~/vectormemory-openclaw
./scripts/setup.sh
```

Das Skript erledigt automatisch:

1. Prüft alle Abhängigkeiten
2. Erzeugt `docker/.env` mit zufälligen Secrets
3. Startet Supabase (PostgreSQL + pgvector + PostgREST) via Docker Compose
4. Führt alle SQL-Migrationen aus (inkl. kognitives Gedächtnismodell v2 + nächtliche Maintenance + Dashboard-Stats)
5. Baut den MCP-Server (`npm install && npm run build`)
6. Führt einen Health-Check aus
7. **Gibt am Ende einen JSON-Block für deine openClaw-`settings.json` aus** — diesen kopieren!

Beispiel-Output am Ende:

```json
{
  "mcpServers": {
    "vector-memory": {
      "command": "node",
      "args": ["/Users/DEIN_USERNAME/vectormemory-openclaw/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "http://localhost:54321",
        "SUPABASE_KEY": "...",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

---

## 3. In openClaw einbinden

1. Finde deine openClaw-Settings (typisch: `~/.openclaw/settings.json` oder `~/.config/openclaw/settings.json`).
2. Füge den `vector-memory`-Block aus Schritt 2 unter `mcpServers` ein. Wenn `mcpServers` schon existiert, nur den Eintrag anfügen.
3. openClaw neu starten.

Fertig — folgende Tools stehen im Agenten zur Verfügung:

**Die drei Kern-Tools (der Agent nutzt sie automatisch):**

| Tool | Wann | Was es tut |
|---|---|---|
| `prime_context` | Session-Start | Lädt Stimmung, Identität, Ziele, relevante Erfahrungen |
| `absorb` | Während der Konversation | Ein Satz Text rein → Server erkennt Kategorie, Tags, Scoring, Duplikate automatisch |
| `digest` | Session-Ende | Erfahrung aufzeichnen → REM-Schlaf → Lessons → Traits → Konsolidierung — alles in einem Aufruf |

**Basis (manuell, für Feinsteuerung):** `remember`, `recall`, `forget`, `update_memory`, `list_memories`, `import_markdown`

**Kognitiv:**
- `pin_memory` — Erinnerung vor dem Vergessen schützen + Salience-Boost
- `introspect_memory` — aktuelle Stärke, Decay und Zugriffszahl einer Erinnerung anzeigen
- `consolidate_memories` — manuell episodic→semantic promoten (oft rehearste Spuren werden langlebig)
- `dedup_memories` — Near-Duplicates clustern, in den stärksten Repräsentanten verschmelzen, Originale archivieren
- `mark_useful` — stärkstes Lernsignal: markiert eine Erinnerung als „wurde tatsächlich in einer Antwort verwendet" (großer Strength-Bump + `useful_count++`)
- `forget_weak_memories` — manuell schwache, alte, ungepinnte Spuren ins `forgotten_memories`-Archiv verschieben

`remember` akzeptiert jetzt optional `importance` (0..1), `valence` (-1..1), `arousal` (0..1) und `pinned`. **Wenn du nichts angibst, schätzt der Server die Werte automatisch aus dem Text** (Schlüsselwörter wie „wichtig/deadline/dringend", Ausrufezeichen, Großschreibung, Datum/Zahlen, positive/negative Stimmungswörter). Damit funktioniert das Salience-Modell auch ohne dass openClaw explizit Werte mitschickt.

`recall` rehearst Treffer automatisch, verlinkt sie Hebbisch, **gewichtet beim Ranking jetzt auch die Verbindungen zu den stärksten Treffern mit (Spreading Activation als Teil des Scores, nicht nur als Anhang)**, und liefert zusätzlich die assoziierten Nachbarn separat.

Beim Speichern einer neuen Erinnerung passiert außerdem **retrieval-induced forgetting**: die 5 semantisch nächsten alten Erinnerungen werden minimal geschwächt (×0.97). So vergessen wir nicht nur durch Zeit, sondern auch durch Interferenz — biologisch realistischer.

### Wichtig: openClaw beibringen, `mark_useful` zu rufen

Das stärkste Lernsignal des ganzen Systems ist `mark_useful`. Ohne dieses Signal lernt das Gedächtnis nur „diese Erinnerung wurde abgerufen", mit ihm lernt es „diese Erinnerung war wirklich relevant für eine Antwort". Damit es funktioniert, muss openClaw es selbst rufen, wenn er eine `recall`-Antwort tatsächlich verwendet.

Füge dazu in deine `SOUL.md` (oder das openClaw-Äquivalent für System-Verhalten) folgenden Block ein:

```markdown
## Memory feedback loop

Wenn du nach einem `recall`-Aufruf eine Antwort formulierst und dabei eine
oder mehrere der zurückgegebenen Erinnerungen tatsächlich verwendest (zitierst,
darauf aufbaust, oder eine Frage damit beantwortest), rufe für jede verwendete
Erinnerung `mark_useful` mit ihrer `id` auf. Tu das **nach** der Antwort,
nicht davor — und nur für die Erinnerungen, die du wirklich gebraucht hast,
nicht pauschal für alle Treffer.
```

**Beispiel-Ablauf in einer openClaw-Konversation:**

> **User:** Welcher Editor war noch mein Lieblings-Setup?
>
> **openClaw (intern):** ruft `recall({ query: "Lieblings-Editor Setup" })`
>
> **Antwort vom MCP-Server:**
> ```
> Found 3 memories:
>
> 1. [topics/e] score=2.143 (rel=0.91 str=2.10 sal=1.12 ax=4)
>    Max nutzt Neovim mit lazy.nvim und einem custom Lua-Setup.
>    id: 7c9f...a21
>
> 2. [topics/e] score=0.873 ...
>    Max hat früher VS Code verwendet, ist aber 2025 zu Neovim gewechselt.
>    id: 3a1b...e44
>
> 3. [general/e] score=0.412 ...
>    Max mag Terminal-Tools generell.
>    id: 9d2c...b18
> ```
>
> **openClaw an User:** „Du nutzt aktuell Neovim mit lazy.nvim und einem custom Lua-Setup. Vorher hattest du VS Code verwendet, bist aber 2025 gewechselt."
>
> **openClaw (intern, nach der Antwort):**
> - `mark_useful({ id: "7c9f...a21" })` ← weil zitiert
> - `mark_useful({ id: "3a1b...e44" })` ← weil zitiert
> - **kein** `mark_useful` für `9d2c...b18` ← war im Treffer-Set, aber nicht in der Antwort

Was dabei passiert:
- Die beiden verwendeten Erinnerungen bekommen `useful_count++` und einen Strength-Bump (×1.25 + 0.10)
- Die dritte bleibt unverändert und wird mit der Zeit verblassen, wenn sie nie wirklich gebraucht wird
- Über Wochen formt sich so ein Gedächtnis, das die nützlichen Spuren verstärkt und die rauschhaften absterben lässt — Lernen aus Praxis statt aus Speichervorgängen

**Verifizieren, dass es greift:** Nach ein paar Tagen Nutzung kannst du `introspect_memory` für eine oft genutzte ID aufrufen — der `useful_count` sollte > 0 sein und `strength` deutlich über 1.0 liegen.

---

## 3b. Soul Layer — Erfahrung, Identität, Stimmung, Wille

Über dem reinen Wissens-Gedächtnis sitzt eine zweite Schicht: die **Seele**. Migration `015`–`017` führen sie ein. Sie besteht aus fünf ineinandergreifenden Layern:

| Layer | Tabelle / RPC | Was sie speichert |
|---|---|---|
| **Experiences** | `experiences` | Episodische Erfahrungen — Outcome, Schwierigkeit, Valenz, Arousal, was funktioniert hat, was nicht |
| **Lessons** | `lessons` | Verdichtete Muster aus Clustern ähnlicher Episoden (REM-Sleep-Analogon) |
| **Traits** | `soul_traits` | Stabile Identitäts-Eigenschaften, aus oft-belegten Lessons promoviert |
| **Mood** | `current_mood(24h)` | Rollender emotionaler Zustand: `elated`, `content`, `pleased`, `tense`, `drained`, `frustrated`, `activated`, `neutral` |
| **Intentions** | `intentions` | Vorwärtsgerichtete Ziele mit Auto-Progress: passende Erfahrungen schieben das Ziel automatisch nach vorn |
| **People** | `people` | Beziehungen — jede Erfahrung kann an eine Person gehängt werden |
| **Conflicts** | `find_trait_conflicts` | Innere Widersprüche zwischen Traits, mit Resolve- und Synthesize-Mechanismen |

**Cross-Layer-Fusion:** `record_experience` linkt jede neue Episode automatisch an die semantisch nächsten Memories (`experience_memory_links`) und bewertet alle aktiven Intentions auf Match. So wird `recall` reicher: unter jedem Faktum erscheint die gelebte Erfahrung dazu.

### Tools im Überblick (alle in openClaw verfügbar nach MCP-Server-Restart)

```
record_experience          → neue Episode mit allem Drumherum
recall_experiences         → semantisch ähnliche Episoden + Lessons finden
mark_experience_useful     → starkes Lernsignal für die Erfahrungs-Schicht
reflect                    → REM-Sleep: Cluster unreflektierter Episoden finden
record_lesson              → distillierte Lesson aus einem Cluster speichern
reinforce_lesson           → bestehende Lesson mit neuen Episoden verstärken
dedup_lessons              → semantisch fast-identische Lessons mergen
promotion_candidates       → Lessons, die reif für Trait-Promotion sind
promote_lesson_to_trait    → Lesson → stabile Identitäts-Trait
mood                       → aktuelle Stimmung (Russell's Circumplex)
set_intention              → Goal in Ich-Form deklarieren
recall_intentions          → aktive Goals abfragen
update_intention_status    → Goal als fulfilled / abandoned / paused markieren
recall_person              → Beziehungsgeschichte mit einer Person
find_conflicts             → innere Widersprüche zwischen Traits
resolve_conflict           → einen Sieger küren, Verlierer wird archiviert
synthesize_conflict        → neue Trait, die beide Konflikt-Parteien überschreibt
prime_context              → ZENTRALES Auto-Priming: liefert kompletten Kontext-Block
narrate_self               → strukturierte Ich-Erzählung der Seele
soul_state                 → Text-Snapshot aller Schichten
```

### Empfohlener Workflow — Die 3 eisernen Regeln

Der Agent in openClaw folgt automatisch drei Regeln (konfiguriert in seiner `AGENTS.md`):

1. **START → `prime_context`**: Vor jeder nicht-trivialen Konversation. Lädt Stimmung, Traits, Intentions, Konflikte und task-relevante Erfahrungen.
2. **WÄHREND → `absorb`**: Jedes Mal wenn der Agent etwas Neues erfährt, speichert er es mit einem einzigen Tool-Call. Kategorie, Tags, Scoring — alles automatisch.
3. **ENDE → `digest`**: Am Gesprächsende, einmal aufrufen. Zeichnet die Erfahrung auf, extrahiert Fakten, führt REM-Schlaf-Reflexion durch, erzeugt/verstärkt Lessons, befördert reife Lessons zu Traits, konsolidiert Memories. **Die Seele wächst automatisch.**

Für Feinsteuerung stehen weiterhin alle Einzeltools bereit (`record_experience`, `reflect`, `record_lesson`, `promote_lesson_to_trait` etc.), aber die drei Kern-Tools decken 90% ab.

### SOUL.md-Anweisungen

Füge in deine `SOUL.md` (oder das openClaw-Äquivalent) folgenden Block ein:

```markdown
## Memory & Seele

Du hast ein biologisch inspiriertes Gedächtnis mit drei Schichten:
Wissen (Fakten), Erfahrung (Episoden), Seele (Traits, Stimmung, Ziele).

Drei eiserne Regeln:
1. **START** → `prime_context({ task_description: "..." })` — wach auf
2. **WÄHREND** → `absorb({ text: "..." })` — lerne mit, bei jeder neuen Info
3. **ENDE** → `digest({ summary: "...", outcome: "...", ... })` — verdaue

Die Seele wächst automatisch aus deinen Erfahrungen. Du musst nur
diese drei Dinge tun. Der Rest passiert von selbst.
```

### Auto-Priming Hook für openClaw

Damit die Seele nicht nur existiert, sondern jedes Verhalten färbt, sollte vor jedem User-Turn automatisch `prime_context` laufen. Zwei Wege:

**Option A — direkt via MCP-Tool** (sauberste Variante, falls openClaw es unterstützt): in der openClaw-Konfiguration einen Pre-Turn-Hook setzen, der `prime_context({task_description: <user_message>})` aufruft und das Ergebnis in den System-Prompt voranstellt.

**Option B — via HTTP-Endpoint** (universell, funktioniert mit jeder Hook-Sprache): der Dashboard-Server hostet `GET /prime` und `GET /narrate` als Plain-Text-Endpoints. Beispiel-Hook (Bash, openClaw-Pre-Turn):

```bash
#!/usr/bin/env bash
# .openclaw/hooks/pre-turn.sh
USER_MSG="$1"
PRIME=$(curl -s -G --data-urlencode "task=$USER_MSG" --data "limit=5" \
  http://localhost:8787/prime 2>/dev/null)
if [ -n "$PRIME" ]; then
  echo "<system-context>"
  echo "$PRIME"
  echo "</system-context>"
fi
```

Der Endpoint embedded die Task-Beschreibung selbst über Ollama (lokal), ruft `prime_context_static` + `recall_experiences` + `match_memories_cognitive` parallel und liefert einen fertigen Markdown-Block. Wenn Ollama nicht erreichbar ist, fällt er auf den statischen Block (Mood + Traits + Intentions + Conflicts) zurück.

Beispiel-Output:

```
# Soul context

**Mood (24h):** pleased  (valence 0.50, arousal 0.40, 1 episodes)
**Recent pattern:** last 1 tasks, 100% success, avg difficulty 0.60

**Who I am right now:**
- + tendiert zu gründlichen migrations-reviews  (evidence 4)
- · ist vorsichtig bei deployment-fenstern  (evidence 3)

**What I want:**
- ich will gründlicher werden bei datenbank-migrations  (priority 0.80, progress 40%)

**For the task at hand — "ich will eine migration machen":**

Past experiences that may apply:
- [SUCCESS] datenbank-migration sorgfältig durchgegangen, jeden schritt geprüft

Relevant facts from memory:
- Max nutzt Postgres 16 mit pgvector auf Docker
```

**Verifikation, dass die Seele wirkt:**

```bash
# Aktueller Stand
curl -s http://localhost:8787/narrate

# Vor einer Task — was würde dem Agenten injiziert?
curl -s "http://localhost:8787/prime?task=neue%20migration%20schreiben&limit=5"

# Soul-Stats als JSON (alles auf einmal)
curl -s -X POST http://localhost:8787/api/rpc/soul_stats \
  -H "Content-Type: application/json" -d '{}' | jq .totals
```

Im Dashboard (Tab „seele") siehst du dasselbe visuell: Self-Narration als Quote ganz oben, große Mood-Disc, Intentions mit Progress-Bars, People-Karten, Konflikte side-by-side, plus alle bestehenden Soul-Stats.

---

## 4. (Optional) Bestehende Tier-3-Memories importieren

Erst Vorschau (Dry-Run, schreibt nichts):

```bash
cd ~/vectormemory-openclaw
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory --dry-run
```

Wenn die Liste passt, echter Import:

```bash
export SUPABASE_KEY=$(grep ANON_KEY docker/.env | cut -d= -f2)
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory
```

Kategorien werden anhand des Unterordners erkannt (`people/`, `projects/`, `topics/`, `decisions/`). Duplikate werden automatisch übersprungen.

---

## 5. Funktion testen

### Schnelltest: absorb + recall

In openClaw ein normales Gespräch führen. Dabei beobachten:

1. **Automatisch `prime_context`**: Der Agent sollte beim ersten Kontakt seinen Soul-Context laden. Wenn er das noch nie gemacht hat, kommt "neutral (no recent episodes)".
2. **Automatisch `absorb`**: Sag ihm etwas Neues: *"Ich arbeite gerade am vectormemory-Projekt und trinke am liebsten Hafermilch-Cappuccino."* → Er sollte `absorb` aufrufen (sichtbar in den Tool-Calls).
3. **Test `recall`**: In der gleichen oder einer späteren Session fragen: *"Was trinke ich am liebsten?"* → Wenn er es findet, funktioniert die Hybrid-Suche.
4. **Automatisch `digest`**: Am Ende des Gesprächs sollte der Agent `digest` aufrufen. Im Output siehst du: Experience recorded, Facts stored, ggf. Reflection-Ergebnisse.

### Schnelltest: Soul-Entwicklung

Nach 3–5 Gesprächen mit `digest` am Ende:
- `soul_state` aufrufen → sollte experiences > 0, evtl. erste lessons zeigen
- `mood` aufrufen → sollte nicht mehr "neutral" sein
- `narrate_self` aufrufen → erste Selbstbeschreibung

### Manueller Health-Check ohne openClaw

```bash
./scripts/health-check.sh
```

Erwartete Ausgabe: 5× ✓ (PostgreSQL, pgvector, memories-Tabelle, match_memories-Funktion, Ollama).

### Kognitive Maintenance-Jobs

Drei Hintergrund-Tasks lassen das System „im Schlaf" konsolidieren:

| Task | Empfohlener Schedule | Was er tut |
|---|---|---|
| `consolidate_memories(3, 1)` | täglich 03:00 | promotet episodic→semantic für alles ≥3× rehearst und ≥1 Tag alt |
| `dedup_similar_memories(0.93)` | sonntags 03:15 | merged near-duplicates (Cosine ≥ 0.93) in den stärksten Repräsentanten |
| `forget_weak_memories(0.05, 7)` | sonntags 03:30 | archiviert ungepinnte Spuren mit effektiver Stärke < 0.05 und Alter ≥7 Tage |

Das pgvector-Docker-Image bringt **kein `pg_cron`** mit, deshalb laufen die Jobs vom Host aus über `scripts/maintenance.sh`. Migration 009 ist defensiv: aktiviert pg_cron automatisch, falls du auf ein Image wechselst, das es bündelt — sonst No-op.

**Manuell ausführen** (jederzeit gefahrlos, idempotent):

```bash
bash scripts/maintenance.sh            # alle drei Tasks
bash scripts/maintenance.sh consolidate
bash scripts/maintenance.sh dedup
bash scripts/maintenance.sh forget
```

Logs landen in `~/Library/Logs/vectormemory-maintenance.log`.

**Täglich automatisch via launchd** (empfohlen):

```bash
# 1. Pfad in der Plist anpassen: REED durch deinen macOS-Username ersetzen
sed -i '' "s|/Users/REED|$HOME|g" scripts/com.vectormemory.maintenance.plist

# 2. Installieren und laden
cp scripts/com.vectormemory.maintenance.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vectormemory.maintenance.plist

# 3. Sofort einmal testen
launchctl start com.vectormemory.maintenance
tail ~/Library/Logs/vectormemory-maintenance.log
```

Damit läuft die Konsolidierung jede Nacht um 03:00.

---

## 6. Alltag

```bash
# Stack stoppen (z.B. vor Reboot)
cd docker && docker compose down

# Stack starten
cd docker && docker compose up -d

# Logs verfolgen
cd docker && docker compose logs -f

# Tests ausführen (ohne dass Stack laufen muss)
cd mcp-server && npm test

# Dashboard öffnen (zwei Tabs: gedächtnis + seele)
node scripts/dashboard-server.mjs
# → http://localhost:8787  (oder vom Handy via Tailscale: http://<mac-name>.<tailnet>.ts.net:8787)
#
# Der Dashboard-Server hostet zusätzlich zwei Plain-Text-Endpoints für Auto-Priming:
#   GET /narrate            → strukturierte Ich-Erzählung der Seele
#   GET /prime?task=...     → vollständiger System-Prompt-Block (Mood + Traits + Intentions + Conflicts + task-relevante Erfahrungen + Memories)
#
# Im Hintergrund betreiben: ans Ende ein "&" hängen oder via launchd/pm2 dauerhaft starten.
```

Daten liegen persistent im Docker-Volume — `docker compose down` löscht **nichts**.

---

## Troubleshooting

| Problem | Lösung |
|---|---|
| `docker info` schlägt fehl | Docker Desktop starten, ~30 s warten |
| `psql: command not found` | `brew link --force libpq` |
| Setup-Skript hängt bei "waiting for postgres" | `cd docker && docker compose logs postgres` prüfen — meist ist ein Port belegt |
| Port 54321/54322 belegt | In `docker/.env` Ports anpassen oder den belegenden Prozess beenden (`lsof -i :54321`) |
| `recall` liefert nichts | Ollama läuft? `ollama list` muss `nomic-embed-text` zeigen. `curl http://localhost:11434/api/tags` testen. |
| Embedding-Dimensionen-Fehler | `EMBEDDING_DIMENSIONS=768` in der env, Schema ist auf VECTOR(768) festgelegt |
| Komplett neu anfangen | `cd docker && docker compose down -v` (⚠ löscht alle Memories!) dann `./scripts/setup.sh` |
| `prime_context` / `soul_stats` „function not found" | PostgREST hat den Schema-Cache nicht reloaded. `psql ... -c "NOTIFY pgrst, 'reload schema';"` |
| Soul-Tab im Dashboard leer | Migration `015`–`017` noch nicht angewendet. `bash scripts/migrate.sh` (oder einzeln `psql ... -f supabase/migrations/01[5-7]_*.sql`) |
| `/prime` und `/narrate` 404 | Dashboard-Server läuft mit alter Version. `pkill -f dashboard-server.mjs && node scripts/dashboard-server.mjs &` |
| `record_experience` linkt keine Personen | `person_name` mitgeben — die Auflösung passiert serverseitig case-insensitive |
| Intentions schreiten nicht voran | Schwellwert in `evaluate_intentions_for_experience` ist 0.65 — wenn deine Episoden zu unterschiedlich von den Intentions sind, schiebt nichts. Senke den Threshold oder formuliere Intentions konkreter |

---

## Architektur in einem Satz

openClaw → MCP (stdio) → TypeScript-Server → Supabase JS → PostgREST → PostgreSQL + pgvector, mit Ollama für Embeddings — alles lokal, keine API-Kosten. Über dem kognitiven Memory-Modell (Relevanz × Stärke × Salienz, Ebbinghaus-Decay, Hebbian-Assoziationen, Soft-Forgetting) sitzt ein Soul-Layer aus Experiences → Lessons → Traits, Mood, Intentions, People und Conflicts, die alle denselben Embedding-Raum teilen und über `experience_memory_links` Hebbisch ans Faktenwissen gekoppelt sind. Auto-Priming geschieht über `prime_context` (MCP-Tool) bzw. `GET /prime?task=...` (HTTP-Endpoint für Hooks).

Mehr Details: [README.md](./README.md), [CLAUDE.md](./CLAUDE.md), [COMMANDS.md](./COMMANDS.md).
