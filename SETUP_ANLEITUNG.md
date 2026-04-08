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
      "args": ["/Users/reed/vectormemory-openclaw/mcp-server/dist/index.js"],
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

**Basis:** `remember`, `recall`, `forget`, `update_memory`, `list_memories`, `import_markdown`

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
>    Reed nutzt Neovim mit lazy.nvim und einem custom Lua-Setup.
>    id: 7c9f...a21
>
> 2. [topics/e] score=0.873 ...
>    Reed hat früher VS Code verwendet, ist aber 2025 zu Neovim gewechselt.
>    id: 3a1b...e44
>
> 3. [general/e] score=0.412 ...
>    Reed mag Terminal-Tools generell.
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

In openClaw sagen:

> „Merke dir: Mein Lieblings-Editor ist Neovim."

Dann später:

> „Was weißt du über meine Editor-Vorlieben?"

Wenn der Agent es findet, läuft die Hybrid-Suche (Vektor + Volltext).

Manueller Health-Check ohne openClaw:

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

# Dashboard öffnen (Charts, KPIs, Health, Top-Memories)
node scripts/dashboard-server.mjs
# → http://localhost:8787  (oder vom Handy via Tailscale: http://<mac-name>.<tailnet>.ts.net:8787)
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

---

## Architektur in einem Satz

openClaw → MCP (stdio) → TypeScript-Server → Supabase JS → PostgREST → PostgreSQL + pgvector, mit Ollama für Embeddings — alles lokal, keine API-Kosten. Recall nutzt ein biologisch inspiriertes Score-Modell (Relevanz × Stärke × Salienz) mit Ebbinghaus-Decay, Rehearsal-Effekt, Hebbian-Assoziationen und Soft-Forgetting via nächtlicher Maintenance-Tasks (host-side launchd oder pg_cron).

Mehr Details: [README.md](./README.md), [CLAUDE.md](./CLAUDE.md), [COMMANDS.md](./COMMANDS.md).
