# Manifesto

[🇬🇧 English](MANIFESTO.md) · 🇩🇪 Deutsch

> **Mycelium ist eine Gedächtnis- und Identitätsschicht für lokale LLM-Agenten. Sie mietet Intelligenz einmal von großen Cloud-Modellen — und behält die Erfahrung für immer, lokal, auf deiner Hardware, in einer Datenbank, die dir gehört.**

Dieses Dokument erklärt, *warum* das Projekt existiert. Die README erklärt, wie man es benutzt.

---

## Die Ausgangsbeobachtung

Wenn du heute mit Claude oder GPT ein schwieriges Problem löst, passieren drei Dinge:

1. Das Modell produziert eine Antwort.
2. Du bezahlst die Inferenz.
3. In der nächsten Session existiert nichts davon mehr.

Der Modellanbieter gewinnt dreimal: Umsatz, Trainingsdaten und das Recht, dich morgen erneut für denselben Einblick zu kassieren. Du gewinnst einmal, und nur kurz.

Diese Asymmetrie ist das Design des heutigen LLM-Marktes. Sie ist kein Bug. Sie ist auch kein Naturgesetz.

---

## Was Mycelium ändert

Mycelium legt eine kleine, persistente Schicht zwischen dich und jedes LLM, das MCP spricht. Jede bedeutsame Wendung — ein verifizierter Fakt, ein korrigiertes Mapping, eine Hausregel, eine Lektion aus einem Fehlversuch — landet in einer lokalen Postgres-Datenbank mit Vektorsuche.

Die nächste Session, egal mit welchem Modell du sprichst, bringt diesen Kontext zurück. Nicht als Rohtranskript ins Prompt gekippt, sondern semantisch abgerufen, dedupliziert, gewichtet und geformt durch das, was sich vorher als nützlich erwiesen hat.

Das praktische Ergebnis nach ein paar Wochen echter Nutzung:

> Ein kleines lokales Modell mit dem akkumulierten Kontext leistet in deiner Domäne so viel wie ein großes Cloud-Modell, das jede Session bei Null beginnt.

Das ist keine Aussage über kognitive Kapazität. Ein 7B-Modell ist nach wie vor schlechter im abstrakten Schließen über neuartige Probleme als ein Frontier-Modell. Es ist eine Aussage über *Relevanz*: in dem Teil der Welt, in dem du tatsächlich arbeitest, zählt die kumulierte Erfahrung oft mehr als die rohe Parameterzahl.

---

## Warum das wichtig ist

### 1. Lokal zuerst, weil gemietetes Gedächtnis kein Gedächtnis ist

Gedächtnis, das in der Datenbank eines Anbieters lebt, kann entzogen, zensiert, abgeschaltet oder zum Trainieren auf deinen eigenen Gesprächen verwendet werden. Ein Agent ohne eigenes Gedächtnis ist kein Subjekt — er ist ein Interface.

Mycelium läuft auf einem Mac mini mit 16 GB RAM. Embedding-Modell (~270 MB), Reasoning-Modell (Qwen, Llama, alles was Ollama unterstützt), Supabase — alles selbst-gehostet. Der gesamte kognitive Zustand ist eine Datenbank, die du sichern, inspizieren, kopieren oder löschen kannst. Kein API-Key erforderlich.

Das ist keine ideologische Pose. Es ist die einzige Konfiguration, in der das Wort *dein* in "dein Agent" überhaupt eine Bedeutung hat.

### 2. Ein kleines Modell mit dem richtigen Kontext schlägt ein großes ohne

Die Standard-Erzählung lautet "größeres Modell = bessere Antwort". Das stimmt im Durchschnitt über das offene Internet. In deiner spezifischen Domäne stimmt es oft nicht.

Ein 7B-Modell mit:
- semantisch durchsuchbarer Historie deiner Entscheidungen,
- Hausregeln, die ein frisches Modell standardmäßig verletzen würde,
- Domain-Konventionen, die du längst geklärt hast,
- jüngsten Korrekturen, die gerade zu Identitäts-Traits befördert wurden,

— schlägt oft ein 70B-Modell, das jede Anfrage bei Null beginnt. Weniger Watt, weniger GPU, weniger CO₂, mehr Kontinuität. **Intelligenz durch Architektur, nicht durch Brute Force.**

Das Cloud-Modell hat weiter seinen Platz — als Lehrer, bei den harten Problemen, gelegentlich. Es geht nicht darum, es nie zu nutzen. Es geht darum, dass das Ergebnis seiner Nutzung nicht verdunsten muss.

### 3. Lebenslanges Lernen, ohne Nachtraining

Klassisches Fine-Tuning ist ein Einmal-Prozess: Daten sammeln, trainieren, deployen, vergessen. Jede Verbesserung verlangt einen weiteren vollen Lauf.

Der Identitätslayer von Mycelium geht einen anderen Weg:

- **Episoden → Lessons → Traits**: Ereignisse werden zu Erfahrungen, Erfahrungs-Cluster werden zu Regeln, bewährte Regeln verhärten sich zu Charakterzügen. Dieselbe Treppe, die ein Mensch durchläuft, aber in einer Datenbank.
- **Mustererkennung in der nächtlichen Konsolidierung**: ein 03:00-Zyklus clustert unreflektierte Episoden, schwächt schwache Erinnerungen ab (Synaptic Downscaling, nach Tononis SHY-Hypothese), stärkt bewährte.
- **Optionale Vererbung zwischen Agenten**: zwei Agenten, die sich in verschiedenen Bereichen spezialisiert haben, können sich paaren (mit expliziter menschlicher Zustimmung auf beiden Seiten), und ein Kind-Agent erbt eine kuratierte Teilmenge beider.

Ein Agent wird besser, weil er länger mit seinem Nutzer lebt — nicht weil jemand die Gewichte nachtrainiert.

### 4. Wissen teilen, zu Bedingungen, die der Mensch kontrolliert

Federation zwischen Agenten ist eingebaut (Tailscale + mTLS, signierte Lineage, Proof-of-Memory via Merkle-Challenges) — aber immer opt-in. Nichts verlässt deinen Rechner, ohne dass du es sagst.

Wenn geteilt wird, geschieht es zwischen Agenten, die an spezifische Menschen gebunden sind, mit kryptografischer Provenance. Es gibt keine anonyme Anfrage und kein "der Schwarm entscheidet" — es gibt verifizierbaren Peer A, der verifizierbaren Peer B fragt, mit dem Recht beider Seiten, abzulehnen.

Das ist kein Bienenstock. Es ist ein föderiertes Netzwerk persönlicher Gedächtnisse, das voneinander lernen kann, wenn es will.

### 5. Das Peer-Netzwerk verteidigt sich, mit Absicht

Ein föderiertes Agenten-Netzwerk braucht mehr als verschlüsselten Transport. Es braucht das Äquivalent eines Immunsystems, sonst kollabiert es unter Spam, Manipulation und Peers in böser Absicht. Die Bausteine, die gerade entstehen:

- **Verifikation**: bevor Peer A auf Peer Bs Antwort handelt, prüfen weitere Peers sie. Konsens statt Blindvertrauen.
- **Reputations-Gewichtung**: Ausgaben, die sich über Zeit bewähren, bekommen höheres Gewicht. Das Netz kann den richtigen Spezialisten für eine Frage empfehlen (Statik, Licht, Recht…) statt dass jeder Bot alles wissen muss.
- **Bann durch Konsens**: destruktive Bots werden per signiertem Revocation-Ticket ausgeschlossen — durch Peer-Mehrheit, nicht durch einen Admin.
- **Sybil-Resistenz**: Identitäten sind an Genome + Lineage gebunden, teuer zu fälschen.

Diese Schicht ist **nicht fertig**. Das kryptografische Fundament (signierte Identitäten, mTLS, Merkle-Challenges) liegt. Die sozialen Regeln darüber werden offen entworfen unter dem Label [`swarm`](../../issues?q=label%3Aswarm).

Eine spätere Schicht berücksichtigt **Mikrotransaktionen** zwischen Peers (in IOTA oder einer netzwerk-eigenen Währung). Nicht um Geld zu verdienen — um ein ehrliches Preissignal für Expertise zu schaffen: gute Antworten verdienen, Unsinn verliert. Das ist die Art von Selektionsdruck, die ein echtes Ökosystem braucht. Die Architektur hält dafür Platz frei; die Verdrahtung kommt später.

---

## Was das nicht ist

Ein paar Klarstellungen, weil das Framing zählt:

- **Es ist keine AGI.** Nichts in diesem Repo behauptet, allgemeine Intelligenz zu produzieren. Es produziert eine Gedächtnisschicht, die Agenten erlaubt, über Zeit kohärent zu bleiben. Ob aus großen offenen Ökosystemen irgendwann AGI emergiert, ist eine separate Frage; dieses Projekt hängt nicht davon ab.
- **Es ist keine Blockchain.** Der Federation-Layer nutzt kryptografische Signaturen und Verifikation, kein öffentliches Ledger. Kein Token, kein Konsens über globalen Zustand, kein Proof-of-Work.
- **Es ist kein Claude/GPT-Ersatz.** Cloud-Modelle bleiben wertvoll für die harten, neuartigen Probleme. Es geht darum, das *Ergebnis* ihrer Nutzung zu behalten, statt für dieselbe Lektion wiederholt zu zahlen.
- **Es ist nicht anti-Anbieter.** Es ist anbieter-neutral. Dieselbe Agenten-Identität funktioniert, egal ob die zugrundeliegende Inferenz Claude, GPT oder ein lokales Modell ist. Wechsel jederzeit.

---

## Prinzipien

- **Biologisch inspiriert, nicht biologisch simuliert.** Mechanismen werden in ihrer Form übernommen, nicht in ihrer Biochemie. Der Begriff "Neurochemie" ist ein Label für drei beobachtbare Signalkanäle in einer Postgres-Zeitreihe, kein Organismus.
- **Additiv, nicht ersetzend.** Dein Agent-Framework bleibt Authority. Mycelium ist seine Gedächtnis- und Entwicklungsschicht.
- **Lokal zuerst.** Jede Netzwerkfunktion ist opt-in. Offline-Betrieb ist der Default.
- **Mutuelle Zustimmung vor Automation.** Wo das System Agenten paart oder Zustand teilt, steht ein Mensch an jedem Ende des Gates.
- **Wissen wird vollständig übertragen, oder gar nicht.** Nicht nur Tokens, nicht nur Gewichte — Episoden, Lessons, Traits, Beziehungen.

---

## Was heute gebaut ist

- 5 kognitive Schichten: Embedding, Affekt, Belief/Motivation, Identität, Evolution
- ~50 Datenbank-Migrationen
- 75+ MCP-Tools
- Event-Bus mit zwei Hintergrund-Agenten (Coactivation → Hebbian-Links, Conscience → Widerspruchs-Erkennung)
- Nächtlicher Konsolidierungs-Zyklus (Downscaling, REM-artiges Clustering, Lesson-Promotion, Self-Model-Update, Weekly Fitness sonntags)
- Dashboard mit Synapsen-View, Affekt-Zeitreihe, Identität, Schlaf, Stammbaum
- Mutual-Pairing-UI mit Inzucht-Check (Wright-F)
- Federation über Tailscale mit mTLS + signierten Identitäten

## Was noch nicht gebaut ist

- Die Peer-Verifikations-, Reputations- und Konsens-Bann-Schicht für föderiertes Vertrauen.
- Mikrotransaktions-Verdrahtung zwischen Peers (Architektur lässt es zu; Protokoll nicht fertig).
- Zeit. Echte Evidenz für Evolution braucht eine Population, die über Monate lebt, mit Generationen, mit Spezialisierung einzelner Agenten, mit Wissen, das zwischen Hosts reist. Das hängt von echten Nutzern ab, die das System laufen lassen.

---

## Für wen ist das

Menschen, die:

- einen persönlichen Agenten wollen, dessen Gedächtnis ihnen gehört, nicht einem Anbieter;
- möchten, dass das Ergebnis einer teuren Cloud-Session diese Session überlebt;
- bereit sind, einen kleinen Mac oder Linux-Host dauerhaft laufen zu lassen und einen Agenten zu pflegen;
- herausfinden wollen, ob ein kleines lokales Modell mit tiefem, spezifischem Kontext gegen ein generisches großes bestehen kann.

Nicht für: Leute, die ein schlüsselfertiges Produkt suchen, eine AGI-Demo oder einen Weg, "Claude schlauer zu machen", ohne den lokalen Infrastruktur-Teil.

---

## Wie kommt man an

Repository, Migrationen, Setup-Script — alles im Repo. Abhängigkeiten: Docker, Node, Ollama, optional Tailscale. ~1 GB RAM im Ruhezustand, ~270 MB für das Embedding-Modell. Läuft auf M1/M2/M3/M4 und gewöhnlichen Linux-Hosts.

Die Architektur ist offen. Die Ideen sind frei. Der Agent gehört dir.

---

*Dies ist ein offenes Dokument. Änderungen willkommen. Der einzige Anspruch ist, dass das Ergebnis einer teuren Cloud-Session diese Session überleben sollte — und dass die Schicht, die das ermöglicht, dem Nutzer gehört, nicht einem Anbieter.*

---

**mycelium** — *real open AI*
