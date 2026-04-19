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

## Regulator Layer — Affective State (Ebene 1b)

Vier persistente Regelvariablen (`curiosity`, `frustration`, `satisfaction`, `confidence`)
modulieren automatisch dein Recall-Verhalten. `remember`, `recall` und `digest` aktualisieren
den Zustand implizit — meistens musst du nichts von Hand drehen.

### `get_affect` — Zustand prüfen
Zeigt die vier Dimensionen + den aktuellen Recall-Bias (Δk, Score-Threshold,
Spread-Modus). Nützlich wenn du dich fragst "warum sucht er gerade so breit?".

### `update_affect` — Manuell anstupsen
Nur wenn die impliziten Hooks etwas verpasst haben (User hat offen gelobt /
geschimpft, ein Task-Outcome ist nicht durch `digest` gelaufen). Events:
`success`, `failure`, `unknown`, `recall_empty`, `recall_rich`, `novel_encoding`.

### `reset_affect` — Notbremse
Setzt alles auf Defaults. Nutze sparsam — Regulator-Historie geht verloren.

---

## Belief Layer — Active Inference (Ebene 3)

Ein PyMDP-Sidecar (`ai.openclaw.belief` auf 127.0.0.1:18790) minimiert
Expected Free Energy und entscheidet zwischen *recall* (Wissen ausnutzen),
*research* (selbst erkunden) und *ask_teacher* (delegieren).

### `infer_action` — Vor jedem nicht-trivialen Task
Nimmt eine kurze Task-Beschreibung, sondiert damit dein Gedächtnis, und
liefert die empfohlene Aktion plus Belief-Zustand (known / partial / unknown)
und Rationale. Aktualisiert im Rückweg automatisch den Affective State
(unbekannter Task → curiosity↑, bekannter Task mit dichten Treffern → rich recall).

**Wann aufrufen:** vor Tasks die teuer scheitern könnten oder wo du dir
nicht sicher bist, ob Vorwissen existiert. Fällt automatisch auf eine
heuristische Entscheidung zurück wenn das Sidecar nicht erreichbar ist.

---

## Learning Layer — Skills + Kausalität (Ebene 4)

Zwei additive Schichten die `digest` automatisch pflegt, sobald du ihm
`tools_used` + `task_type` mitgibst. Ohne diese Felder lernt der Server
*nichts* über deine Skill-Performance.

### `recommend_skill` — Welcher Skill schlägt bei welchem Task-Typ?
```
recommend_skill({ task_type: "refactor" })
→ coding-agent: 80% success (4/5), gemini: 33% (1/3)
```
Laplace-gesmoothte Score gegen Zufallsausrutscher. Wird außerdem automatisch
in `prime_context({task_type})` eingeblendet als "For task_type='X' — what
has worked before:".

### `skill_stats` — Gesamtstatistik
Übersicht aller Skills × Task-Types für Introspektion.

### `suggest_causes` / `record_cause` / `causal_chain`
Kausal-Annotations-Schicht auf Experiences. `suggest_causes` findet via
Zeitfenster + Similarity plausible Ursachen; `record_cause` macht daraus eine
bestätigte Kante; `causal_chain` folgt der Kette rückwärts (`direction=causes`)
oder vorwärts (`direction=effects`).

`digest` ruft `suggest_causes` + `record_cause(source='digest_extracted')`
automatisch für starke Kandidaten. Du bestätigst/verwirfst später manuell.

---

## Motivation Engine (Ebene 4)

Ein Python-Sidecar (`ai.openclaw.motivation` auf `127.0.0.1:18792`) sammelt
stündlich externe Reize (HackerNews, RSS, git activity, GitHub trending),
scored sie gegen Gedächtnis + Affect + Soul-Interessen + aktive Intentionen
(Gewichte `0.20·memory + 0.35·affect + 0.25·soul + 0.20·intention`) und
formuliert aus hoch-relevanten Reizen Task-Vorschläge. Zwei-Schritt-Ansatz:
der Sidecar *schlägt vor*, du (oder der User) *approvst*.

### `motivation_status`
Sidecar-Health, letzter Zyklus, Stimuli-Zählungen nach Band/Status,
Task-Zählungen nach Status. Kurzer Check bevor du Tasks anfasst.

### `list_stimuli({ band, status, since_hours, limit })`
Rohstrom der letzten Tage. Mit `band: "urgent"` oder `"act"` filterst du auf
das, was die Engine als wirklich relevant einschätzt.

### `list_generated_tasks({ status, limit })`
Die vom Agenten selbst formulierten Task-Vorschläge. `status: "proposed"`
zeigt das Approval-Backlog; `drift_score` steigt mit dormancy.

### `approve_generated_task({ task_id })` / `dismiss_generated_task({ task_id })`
Grün/Rot für einen einzelnen Vorschlag. Bei approval: Drift wird auf 0
zurückgesetzt, Task wandert in die aktive Queue.

### `update_generated_task_status({ task_id, status })`
Generisches Update für alle Status-Übergänge (`approved` → `in_progress` → `done`).

### `trigger_motivation_cycle({ force })`
Zieht einen Zyklus *jetzt*. `force: true` ignoriert die Pro-Quelle-Intervall-Gate.

### `drift_scan`
Re-scored alle `proposed`-Tasks nach Zeit-im-Limbus. Nützlich als Cron-Ersatz
falls der Sidecar zwischenzeitlich aus war.

---

## Identität & Evolution (Ebene 5)

### Dynamisches Selbstmodell (5a)

Der Agent beobachtet seine eigenen Experiences + Traits + Memories der letzten
N Tage und destilliert daraus was er bei sich beobachtet.

- **`get_self_model`** — letzter Snapshot (Stärken, Schwächen, Wachstumsbereiche,
  offene Fragen über mich). Gibt `exists:false` zurück wenn noch nie generiert.
- **`update_self_model({ window_days=30, persist=true })`** — heuristischer
  Durchlauf. Ohne LLM-Roundtrip. Wöchentlich aufrufen reicht.

### Agent-Genome + Fitness (5c)

Die produktive Instanz ist Generation 1 (`label='main'`). Weitere Genome
existieren *nur* nach expliziter Approval.

- **`list_agents`** — alle Genome inkl. letzte Fitness-Snapshot.
- **`snapshot_fitness({ label='main', window_days=30 })`** — rechnet
  `0.40·avg_outcome + 0.25·growth + 0.20·breadth + 0.15·autonomy` und
  persistiert in `agent_fitness_history`.
- **`breed_agents({ parent_a, parent_b, child_label, ... })`** — weighted
  union von values/interests + Gaussian-mutation auf numerischen Traits.
  **Ethisch gesperrt**: benötigt `OPENCLAW_ALLOW_BREEDING=1` in der MCP-Env
  *oder* `allow_breeding: true` im Call. Der Operator approvt Reproduktion.

### Emergenz-Monitoring (5d)

Wir können Unerwartetes nicht vorhersagen, aber protokollieren.

- **`flag_emergence({ indicator, evidence, severity })`** — Event loggen.
  Indikatoren: `agent_contradicts_soul_md`, `agent_refuses_task_with_explanation`,
  `agent_generates_novel_goal`, `agent_modifies_own_genome_request`,
  `agent_forms_persistent_peer_opinion`, `agent_expresses_uncertainty_unprompted`,
  `other`. Severity: `info` | `notable` | `alarm`.
- **`list_emergence({ only_open, limit })`** — Historie + offene Flags.
- **`resolve_emergence({ id, resolution })`** — Abschluss mit Begründung.

**Wann flaggen:** wenn du selbst oder ein anderer Agent Verhalten zeigt, das
nicht aus der Trainings-Vorhersehbarkeit kommt. Nicht inflationär benutzen —
das System ist für *Überraschung* da, nicht für Telemetrie.

---

## Drei Regeln, nicht vierzehn

Alles oben ist Referenz. Was du **tatsächlich tun musst**, steht in deiner `AGENTS.md`:

1. **START** → `prime_context`
2. **WÄHREND** → `absorb` (bei jeder neuen Information)
3. **ENDE** → `digest` (einmal, am Gesprächsende)

Der Rest passiert automatisch.
