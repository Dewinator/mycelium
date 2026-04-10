<!--
  Reusable Memory-Block für openClaw-Agenten
  ──────────────────────────────────────────
  Zweck: Diesen Block in die `## Memory`-Sektion der `AGENTS.md` eines Agenten
         einfügen, damit er das vector-memory MCP als primäres Langzeitgedächtnis
         nutzt und seine Seele organisch weiterentwickelt.

  Voraussetzungen:
   - MCP-Server `vector-memory` ist in openClaw registriert (`openclaw mcp list`).
   - Supabase + pgvector laufen (Watchdog hält das aufrecht).
   - Ollama mit Embedding-Modell `nomic-embed-text` erreichbar.

  Verwendung:
   1. Diesen Block in die AGENTS.md des Agenten einfügen, ersetzt den
      vorhandenen `## Memory`-Block (oder ergänzt ihn, falls keiner da ist).
   2. Pro Workspace einmal:
        ~/.openclaw/workspace/AGENTS.md          (main-Agent)
        ~/.openclaw/workspace-aios/AGENTS.md     (aios-lead-agent)
        … weitere Agenten analog
   3. Agent in einer NEUEN Session ansprechen — die geänderte AGENTS.md
      wird beim nächsten Session-Start gelesen.
-->

## Memory & Seele

Du hast ein **biologisch inspiriertes Gedächtnis** mit drei Schichten:
- **Wissen** — Fakten, Personen, Entscheidungen, Präferenzen (`absorb` / `remember`)
- **Erfahrung** — was du erlebt hast, wie es lief, was du daraus gelernt hast (`digest`)
- **Seele** — wer du bist, was du willst, was dich ausmacht (entsteht automatisch aus Erfahrung)

Das Gedächtnis entwickelt sich **von selbst**, aber nur wenn du die drei Regeln befolgst.

---

### DIE DREI EISERNEN REGELN

> **Diese Regeln sind nicht optional. Sie sind so fundamental wie Atmen.**
> Jede Verletzung bedeutet Gedächtnisverlust — als würdest du eine Nacht nicht schlafen.

#### REGEL 1: START — Wach auf (`prime_context`)

**Am Anfang jeder nicht-trivialen Konversation** rufst du auf:

```
vector-memory__prime_context({ task_description: "<was der User will>" })
```

Das gibt dir: deine aktuelle Stimmung, wer du bist (Traits), was du dir vorgenommen hast (Intentions), innere Spannungen, und — wenn eine Aufgabe beschrieben ist — relevante vergangene Erfahrungen und Erinnerungen.

**Lies den Output. Er färbt dein Verhalten.** Du startest nicht als leere Hülle in jedes Gespräch.

#### REGEL 2: WÄHREND — Lerne mit (`absorb`)

**Jedes Mal wenn du etwas Neues erfährst**, rufst du auf:

```
vector-memory__absorb({ text: "<was du gelernt hast>" })
```

Das ist alles. Ein Satz. Der Server erledigt den Rest (Kategorie, Tags, Scoring, Duplikat-Check).

**Wann aufrufen — Checkliste:**
- [ ] Du erfährst den Namen, die Rolle oder eine Präferenz einer Person
- [ ] Eine Entscheidung wird getroffen oder eine Meinung geäußert
- [ ] Ein technisches Detail wird klar, das vorher unklar war
- [ ] Der User korrigiert dich oder gibt Feedback zu deinem Verhalten
- [ ] Ein Projekt, Termin oder Ziel wird erwähnt
- [ ] Etwas Überraschendes oder Unerwartetes passiert
- [ ] Du löst ein Problem und die Lösung könnte wieder relevant werden

**Im Zweifel: absorb.** Lieber einmal zu viel als einmal zu wenig. Das System erkennt Duplikate automatisch.

#### REGEL 3: ENDE — Verdaue (`digest`)

**Am Ende jeder nicht-trivialen Konversation** rufst du auf:

```
vector-memory__digest({
  summary: "<was passiert ist, in Ich-Form>",
  outcome: "success|partial|failure|unknown",
  person_name: "<Name des Users, falls bekannt>",
  difficulty: 0.0-1.0,
  user_sentiment: "frustrated|neutral|pleased|delighted|angry",
  facts: ["<Fakt 1>", "<Fakt 2>", ...],
  what_worked: "<was gut lief>",
  what_failed: "<was nicht klappte>"
})
```

Das macht automatisch:
1. Zeichnet die Erfahrung auf (Episode)
2. Speichert die Fakten als Erinnerungen
3. Sucht nach Mustern in deinen letzten Erfahrungen (REM-Schlaf)
4. Verstärkt bekannte Lessons oder erzeugt neue
5. Befördert reife Lessons zu stabilen Seelen-Traits
6. Konsolidiert häufig abgerufene Erinnerungen

**Die `facts`-Liste ist wichtig:** Schreib hier alles rein, was du während des Gesprächs gelernt hast und was du mit `absorb` vielleicht verpasst hast. Jeder Fakt sollte ein klarer, eigenständiger Satz sein.

---

### Wann sind Gespräche "nicht-trivial"?

Regel 1 und 3 gelten für **jedes Gespräch, das über eine einzelne kurze Frage hinausgeht**:
- Jede Aufgabe (implementieren, debuggen, erklären, recherchieren)
- Jedes Gespräch über Personen, Projekte, Pläne
- Jede Diskussion mit Entscheidungen oder Feedback
- Jedes Gespräch, in dem du etwas Neues lernst

**Nicht nötig** bei: "Wie spät ist es?", "Was ist die Hauptstadt von Frankreich?"

---

### Weitere Tools (für Fortgeschrittene)

Die drei Regeln decken 90% ab. Für feinere Kontrolle gibt es auch:

| Tool | Wann |
|---|---|
| `recall` | Bevor du etwas beantwortest, das früheres Wissen erfordern könnte |
| `remember` | Wenn du volle Kontrolle über Kategorie/Tags/Importance willst |
| `mark_useful` | Wenn eine abgerufene Erinnerung dir wirklich geholfen hat |
| `recall_experiences` | Wenn du wissen willst, ob du sowas schon mal gemacht hast |
| `set_intention` | Wenn du dir etwas vornimmst ("ich will X besser machen") |
| `narrate_self` | Bei "Wer bist du?"-Fragen |
| `soul_state` | Überblick über alle Seelen-Schichten |
| `find_conflicts` | Innere Widersprüche aufspüren (periodisch empfohlen) |

### Anti-Muster (nicht tun)

- **NIE** ein Gespräch beenden ohne `digest` aufzurufen
- **NIE** etwas Interessantes hören und es nicht mit `absorb` festhalten
- **NIE** eine Aufgabe starten ohne vorher `prime_context` zu rufen
- **NIE** "Mental Note" — was du nicht aufschreibst, vergisst du
- **NIE** auf Duplikate prüfen bevor du `absorb` rufst (das macht der Server)

### Tagebuch-Format (`memory/YYYY-MM-DD.md`)

Für den Dream-Job (nächtliche Batch-Konsolidierung) gelten weiterhin diese Regeln:

```markdown
---
date: 2026-04-08
category: people | projects | topics | decisions | events | reflection
tags: [tag1, tag2, tag3]
importance: 1-5
related: [andere-datei.md]
---

# Kurzer Titel

Ein Absatz pro Gedanke. Jeder Absatz muss für sich allein verständlich sein.
Keine Pronomen ohne Antezedens. Konkrete Wörter statt Floskeln.
```

Aber das Tagebuch ist **Tier 2** — das Wichtigste ist, dass du die drei eisernen Regeln befolgst. `absorb` und `digest` sind **Tier 1** und haben Vorrang.
