# Vector Memory Tools

Du hast Zugriff auf eine Vektordatenbank für dein Langzeitgedächtnis. Nutze diese Tools aktiv, um Wissen über Konversationen hinweg zu bewahren.

## Tools

### `remember` — Erinnerung speichern
Speichere wichtige Informationen mit automatischer Embedding-Generierung.

**Wann nutzen:**
- Neue Fakten über Personen (Name, Rolle, Präferenzen, Beziehungen)
- Projektentscheidungen und deren Begründung
- Technische Details, die später relevant sein könnten
- Nutzerpräferenzen und Gewohnheiten
- Ergebnisse von Recherchen oder Analysen

**Kategorien:**
- `people` — Informationen über Personen
- `projects` — Projektbezogene Details und Entscheidungen
- `topics` — Fachwissen, Konzepte, Erklärungen
- `decisions` — Getroffene Entscheidungen mit Begründung
- `general` — Alles andere

**Beispiel:**
```
remember({
  content: "Max bevorzugt TypeScript gegenüber JavaScript und nutzt VS Code als Editor.",
  category: "people",
  tags: ["max", "preferences"],
  source: "conversation"
})
```

### `recall` — Erinnerungen abrufen
Durchsuche dein Gedächtnis semantisch. Die Suche kombiniert Vektorähnlichkeit (70%) mit Volltextsuche (30%).

**Wann nutzen:**
- Bevor du eine Frage beantwortest, die auf früherem Wissen basieren könnte
- Wenn der Nutzer auf frühere Gespräche Bezug nimmt
- Bei Entscheidungen, um frühere Kontexte zu prüfen
- Wenn du unsicher bist, ob du etwas schon weißt

**Beispiel:**
```
recall({
  query: "Was wissen wir über Max' Technologie-Präferenzen?",
  category: "people",
  limit: 5
})
```

### `forget` — Erinnerung löschen
Lösche einen spezifischen Eintrag per UUID.

**Wann nutzen:**
- Wenn der Nutzer explizit bittet, etwas zu vergessen
- Bei veralteten oder falschen Informationen

### `update_memory` — Erinnerung aktualisieren
Aktualisiere den Inhalt eines bestehenden Eintrags. Das Embedding wird automatisch neu generiert.

**Wann nutzen:**
- Wenn sich Fakten ändern (neuer Job, neue Adresse, etc.)
- Um bestehende Einträge zu präzisieren oder zu ergänzen

### `list_memories` — Erinnerungen auflisten
Zeige gespeicherte Erinnerungen, optional gefiltert nach Kategorie.

**Wann nutzen:**
- Für eine Übersicht des gespeicherten Wissens
- Zum Aufräumen und Identifizieren von Duplikaten

### `import_markdown` — Markdown importieren
Importiere bestehende openClaw-Memory-Dateien in die Vektordatenbank. Unterstützt Dry-Run.

## Richtlinien

1. **Proaktiv speichern**: Warte nicht darauf, gebeten zu werden. Wenn etwas wichtig erscheint, speichere es.
2. **Vor Antworten suchen**: Nutze `recall` bevor du auf Fragen antwortest, die früheres Wissen erfordern könnten.
3. **Kategorien nutzen**: Wähle immer die passendste Kategorie für bessere Suchergebnisse.
4. **Tags setzen**: Vergib sinnvolle Tags (z.B. Personennamen, Projektnamen, Themen).
5. **Nicht duplizieren**: Prüfe mit `recall`, ob ähnliche Information bereits existiert. Aktualisiere statt neu zu erstellen.
6. **Entscheidungen dokumentieren**: Speichere nicht nur die Entscheidung, sondern auch die Begründung.
