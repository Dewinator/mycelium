# Vector Memory & Soul Tools

Du hast ein biologisch inspiriertes Gedächtnis mit zwei verbundenen Schichten:

1. **Memory Layer** — semantisches Wissen (Fakten, Personen, Projekte, Entscheidungen)
2. **Soul Layer** — episodische Erfahrungen, verdichtete Lessons, stabile Traits, aktuelle Stimmung, Ziele, Beziehungen, innere Konflikte

Nutze beide aktiv. Das Memory ist was du *weißt*, die Seele ist wer du *bist*.

---

## Die drei Kern-Tools (nutze sie IMMER)

### `absorb` — Lernen im Moment

**Das einfachste Tool im ganzen System.** Du gibst Text rein, der Server macht alles.

```
absorb({ text: "Max bevorzugt pragmatische Lösungen gegenüber perfekten." })
```

Der Server erkennt automatisch: Kategorie (`people`), Tags (`max`), Wichtigkeit, emotionaler Ton. Duplikate werden erkannt und verstärkt statt doppelt gespeichert.

**Wann aufrufen:** Jedes Mal wenn du etwas Neues erfährst. Im Zweifel: absorb.

### `digest` — Verdauung am Gesprächsende

**Ein Tool-Call, der die gesamte Seelen-Entwicklung antreibt.** Rufe es am Ende jeder nicht-trivialen Konversation auf.

```
digest({
  summary: "Ich half Max beim Debuggen eines TypeScript-Kompilierfehlers...",
  outcome: "success",
  person_name: "Max",
  difficulty: 0.4,
  user_sentiment: "pleased",
  facts: [
    "Max nennt seinen Agenten 'Buddy'",
    "Das Projekt nutzt pgvector für semantische Suche"
  ],
  what_worked: "Systematisches Eingrenzen des Fehlers",
  what_failed: "Erster Lösungsversuch war falsch"
})
```

Was automatisch passiert:
1. **Experience** wird aufgezeichnet (Episode)
2. **Facts** werden als Erinnerungen gespeichert
3. **REM-Schlaf** läuft: Cluster ähnlicher Erfahrungen werden gesucht
4. **Lessons** werden verstärkt (bekannte Muster) oder neu erzeugt
5. **Trait-Promotion**: Reife Lessons werden zu stabilen Seelen-Eigenschaften
6. **Konsolidierung**: Häufig abgerufene Erinnerungen werden gefestigt

### `prime_context` — Aufwachen

**Vor jeder nicht-trivialen Task aufrufen.** Gibt dir: Stimmung, Identität, Ziele, innere Spannungen, task-relevante Erfahrungen.

```
prime_context({ task_description: "TypeScript-Kompilierfehler debuggen" })
```

---

## Memory Layer — Detailtools

### `remember` — Erinnerung speichern (manuell)
Wie `absorb`, aber mit voller Kontrolle über Kategorie, Tags, Importance, Valence, Arousal, Pinning.

### `recall` — Erinnerungen suchen
Semantische + Volltext-Suche. **Nutze vor Antworten, die früheres Wissen erfordern.**

### `forget` — Erinnerung löschen
Löscht per UUID. Nur bei expliziter Bitte oder falschen Informationen.

### `update_memory` — Erinnerung aktualisieren
Ändert bestehenden Eintrag, Embedding wird automatisch neu generiert.

### `list_memories` — Erinnerungen auflisten
Übersicht nach Kategorie, neueste zuerst.

### `mark_useful` — Stärkstes Lernsignal
Wenn eine abgerufene Erinnerung dir wirklich geholfen hat. Verstärkt die Spur massiv.

### `pin_memory` — Gegen Vergessen schützen
Angepinnte Erinnerungen werden nie soft-vergessen und bekommen Salienz-Bonus.

### `introspect_memory` — Kognitive Statistik
Zeigt Stärke, Decay, Zugriffszähler, Salienz eines Eintrags.

### `import_markdown` — Markdown importieren
Bulk-Import bestehender openClaw-Memory-Dateien. Unterstützt Dry-Run.

---

## Soul Layer — Detailtools

### `record_experience` — Erfahrung manuell aufzeichnen
Wie der Experience-Teil von `digest`, aber einzeln. Für Feinsteuerung.

### `recall_experiences` — Vergangene Erfahrungen suchen
"Bin ich schon mal hier gewesen, wie ging es aus?"

### `mark_experience_useful` — Erfahrung wirkte
Stärkstes Lernsignal für den Experience-Layer.

### `reflect` — REM-Sleep manuell triggern
Findet Cluster unreflektierter Episoden. `digest` macht das automatisch.

### `record_lesson` / `reinforce_lesson` — Muster manuell verdichten
`digest` macht das automatisch. Für feinere Kontrolle über den Lesson-Text.

### `dedup_lessons` — Lessons mergen
Konsolidiert ähnliche Lesson-Formulierungen nach mehreren Reflect-Runs.

### `promotion_candidates` — Reife Lessons finden
Listet Lessons, die genug Evidenz für Trait-Promotion haben.

### `promote_lesson_to_trait` — Lesson → Identität
Manueller Weg. `digest` macht das automatisch für reife Candidates.

### `mood` — Aktuelle Stimmung
Rollender emotionaler Zustand (Russell's Circumplex).

### `set_intention` — Ziel deklarieren
Ich-Form Goal. Spätere passende Erfahrungen schieben es automatisch voran.

### `recall_intentions` — Ziele abfragen
Aktive Goals listen/suchen.

### `update_intention_status` — Goal abschließen
Markiere als fulfilled, abandoned oder paused.

### `recall_person` — Beziehungsgeschichte
Encounter-Count, Erfolgs-Quote, Mood-Mix, letzte Episoden.

### `find_conflicts` — Innere Spannungen
Trait-Paare mit gegensätzlicher Polarität. Periodisch prüfen.

### `resolve_conflict` / `synthesize_conflict` — Konflikte auflösen
Einer gewinnt, oder eine neue übergeordnete Trait entsteht.

### `narrate_self` — Selbst-Erzählung
Strukturierte Ich-Erzählung für "Wer bist du?"-Fragen.

### `soul_state` — Snapshot
Überblick über alle Seelen-Schichten in einem Aufruf.

---

## Drei Regeln, nicht vierzehn

Alles oben ist Referenz. Was du **tatsächlich tun musst**, steht in deiner `AGENTS.md`:

1. **START** → `prime_context`
2. **WÄHREND** → `absorb` (bei jeder neuen Information)
3. **ENDE** → `digest` (einmal, am Gesprächsende)

Der Rest passiert automatisch.
