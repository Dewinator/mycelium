# mycelium Dashboard — Design Spec

Visuelle Sprache angelehnt an *Vision UI Dashboard PRO* (Creative Tim / Simmmple).
Ziel: futuristisches "Deep-Space"-Glassmorphism-Look, das die kognitive
Architektur (Affekt, Neurochemie, Sleep-Cycles, Hub-Aktivierung) lesbar macht
und Reed-Roadmap-Phase 3 erfüllt — *lesbar, vollständig, Anfänger-tauglich*.

## 1. Designprinzipien

1. **Deep-space dark first.** Kein Light-Theme im MVP. Hintergrund schwarz mit
   navy-Verlauf, alle Karten als Glassmorphism-Layer darüber.
2. **Glow als Bedeutung, nicht Deko.** Cyan-/Blau-Glows markieren aktive
   neuronale Aktivität (Hubs, Spreading Activation). Keine Glows ohne Daten.
3. **Eine Akzentachse.** Blau→Cyan-Gradient für alles Positive/Aktive,
   Magenta/Pink nur für Anomalien & High-Arousal-Spikes.
4. **Karten atmen.** 24 px Innenabstand, runde 20–24 px Ecken, weicher
   Drop-Shadow + 1 px Inner-Highlight oben.
5. **Daten-Dichte gestaffelt.** KPI-Tile → Chart-Card → Detail-Tabelle.
   Nie zwei Detail-Tabellen nebeneinander.

## 2. Farbpalette

### Hintergrund & Flächen

| Token | Hex | Verwendung |
|---|---|---|
| `--bg-base` | `#030418` | App-Hintergrund (oben) |
| `--bg-deep` | `#060B28` | App-Hintergrund (unten, Gradient-Ende) |
| `--surface-card` | linear-gradient `#0F1535` → `#060B28` | Standard-Karte |
| `--surface-elevated` | `#1A1F37` | Hover / Modal / Sidebar-Item aktiv |
| `--surface-glass` | `rgba(255,255,255,0.04)` + 12 px backdrop-blur | Header-Bar, schwebende Pills |
| `--border-soft` | `rgba(255,255,255,0.08)` | Karten-Umrandung |
| `--border-strong` | `rgba(255,255,255,0.16)` | Inputs, Divider |

### Akzent — Brand & Daten

| Token | Hex | Verwendung |
|---|---|---|
| `--accent-blue` | `#0075FF` | Primär-Buttons, aktive Nav, Linien-Charts |
| `--accent-cyan` | `#21D4FD` | Sekundär-Linie, Hub-Glow, Spark |
| `--accent-gradient` | `linear-gradient(135deg, #0075FF 0%, #21D4FD 100%)` | CTA, aktive Icon-Tiles |
| `--accent-violet` | `#7551FF` | Tertiär (Curiosity / Exploration) |
| `--accent-pink` | `#FF0080` | Anomalie, High-Arousal |

### Status

| Token | Hex | Verwendung |
|---|---|---|
| `--status-success` | `#01B574` | „+5% more", positive Delta, Health OK |
| `--status-warning` | `#FFB547` | Drift, niedriger Schlaf-Druck |
| `--status-danger` | `#E31A1A` | Federation-Fehler, Sicherheits-Alarm |
| `--status-info` | `#21D4FD` | Hinweise, Neutral-Events |

### Text

| Token | Hex | Verwendung |
|---|---|---|
| `--text-primary` | `#FFFFFF` | Headlines, KPI-Zahlen |
| `--text-secondary` | `#A0AEC0` | Body, Sublabels |
| `--text-muted` | `#718096` | Achsenbeschriftung, Footer |
| `--text-on-accent` | `#FFFFFF` | Text auf blauem Button |

## 3. Typografie

- **Font-Familie:** `"Plus Jakarta Display", "Plus Jakarta Sans", system-ui, sans-serif`
- **Mono (Logs, IDs):** `"JetBrains Mono", "SF Mono", monospace`

| Rolle | Größe / Weight / Tracking | Beispiel |
|---|---|---|
| Display KPI | 34 / 700 / -0.02 em | `32,984` |
| H1 Page | 24 / 700 / -0.01 em | „Default" |
| H2 Card | 18 / 600 / 0 | „Sales Overview" |
| Body | 14 / 400 / 0 | Tabellen, Beschreibungen |
| Caption | 12 / 500 / 0.02 em | Achsen, Sublabels |
| Tag / Eyebrow | 10 / 700 / 0.12 em UPPERCASE | „PAGES" Sidebar-Gruppe |

Zeilenhöhe durchgängig 1.4 für Body, 1.15 für Display-Zahlen.

## 4. Spacing & Layout

- **Grid:** 12 Spalten, 24 px Gutter, 24 px Außenabstand auf Desktop ≥1440 px.
- **Sidebar-Breite:** 264 px (collapsed: 80 px).
- **Header-Höhe:** 70 px, schwebend mit 16 px vertikalem Spacing zur Page.
- **Karten-Padding:** 24 px innen; 20 px zwischen Karten.
- **Border-Radius-Skala:** `8 / 12 / 16 / 20 / 24` — Karten 20, Buttons 12,
  Inputs 16, Pills 999.

## 5. Effekte

### Glassmorphism-Karte (Default)

```css
background: linear-gradient(127deg, rgba(15,21,53,0.9) 0%, rgba(6,11,40,0.95) 100%);
border: 1px solid rgba(255,255,255,0.08);
box-shadow:
  0 20px 27px 0 rgba(0,0,0,0.05),
  inset 0 1px 0 0 rgba(255,255,255,0.06);
border-radius: 20px;
backdrop-filter: blur(20px);
```

### Glow (Hub aktiv / KPI-Highlight)

```css
box-shadow:
  0 0 0 1px rgba(33,212,253,0.4),
  0 0 32px 0 rgba(33,212,253,0.25),
  0 8px 24px rgba(0,117,255,0.18);
```

### Gradient-Border (CTA, aktive Nav)

```css
background: linear-gradient(#0F1535,#0F1535) padding-box,
            linear-gradient(135deg,#0075FF,#21D4FD) border-box;
border: 1px solid transparent;
```

## 6. Komponenten-Inventar

### 6.1 Sidebar
- Logo-Block oben (40 px Höhe), Mark + Wortmarke.
- Section-Label (Eyebrow-Style) `DASHBOARDS`, `PAGES`, `BRAIN`, `MEMORY`,
  `SETTINGS`.
- Item: 44 px hoch, 12 px Icon-Tile (gradient-fill bei aktiv, sonst dunkel),
  Label rechts, ▾ bei Submenu.
- Active-State: Item-Bg `--surface-elevated`, Icon-Tile mit `--accent-gradient`.
- Floating Help-Card unten (Stern-Icon, Verlauf-Hintergrund, „Documentation"-CTA).

### 6.2 Header-Bar (Floating Pill)
- Glassmorphism, Breadcrumb links (`Brain / Affect`), Page-Title fett darunter.
- Rechts: Search (240 px), Sign-in-Avatar, Settings-Cog, Bell mit Badge.
- Sticky mit 12 px Top-Offset, schwebt über Content.

### 6.3 KPI-Tile
- 1×1 Grid-Cell, Glass-Card.
- Layout: Icon-Tile (40 × 40, gradient) links oben, Label „Active Users"
  Caption-Style, Display-KPI darunter, Delta-Pill (`+23 ↑` grün) rechts.
- Optional Sparkline 32 px hoch unter dem KPI.

### 6.4 Chart-Card
- Header: Title (H2) + Subtitle (Body-secondary mit Delta in
  `--status-success`).
- Body: Chart füllt Restfläche; min-height 240 px.
- Footer optional: Legend-Pills.

### 6.5 Tabelle (Sales by Country-Pattern)
- Keine vertikalen Linien. Horizontale Trennung `--border-soft`.
- Erste Spalte: Flag/Avatar 24 px + Sub-Label.
- Zahlen tabellarisch ausrichten (`font-variant-numeric: tabular-nums`).
- Hover: Zeile bekommt `--surface-elevated`.

### 6.6 Buttons

| Variante | Hintergrund | Text | Border |
|---|---|---|---|
| Primary | `--accent-gradient` | weiß | — |
| Secondary | `--surface-elevated` | weiß | `--border-strong` |
| Ghost | transparent | `--text-secondary` | `--border-soft` |
| Danger | `--status-danger` 90% | weiß | — |

Alle 12 px Radius, 40 px hoch, 16 px horizontaler Padding.

### 6.7 Pill / Badge
- 999 px Radius, 24 px hoch, 12 px h-Padding.
- Delta-Pill: `+5%` grün auf `rgba(1,181,116,0.16)`.

## 7. Charts (ApexCharts / Recharts)

- **Hintergrund:** transparent, Karte trägt die Fläche.
- **Linien-Chart:** zwei Datenreihen — Primär `--accent-cyan`, Sekundär
  `--accent-blue`. Stroke-Width 3, Linecap rund, Area-Fill mit
  `linear-gradient` der Akzentfarbe (90% → 0% Alpha von oben nach unten).
- **Bar-Chart:** Bars 8 px breit, oben gerundet (4 px), Farbe weiß bei
  „Active Users", sonst `--accent-gradient`. Endpunkt mit kleinem Cap-Dot.
- **Radar/Polar:** Grid `rgba(255,255,255,0.08)`, Fill-Area
  `rgba(0,117,255,0.35)`, Stroke `--accent-cyan`.
- **Tooltip:** Glassmorphism-Karte, weißer Text, kein Pfeil.
- **Achsen:** `--text-muted`, 11 px, keine Tick-Linien.
- **Gridlines:** dashed 4-4, `rgba(255,255,255,0.06)`.

## 8. mycelium-spezifische Module

Die folgenden Karten ersetzen / erweitern die generischen Vision-UI-Widgets,
abgebildet auf die Architektur in `CLAUDE.md`.

### 8.1 Affect-Quadrant (Valence × Arousal)
- Quadratische Card, Heatmap mit aktuellem Punkt, Trail der letzten 24 h.
- Achsen-Labels: `Pleasant ↔ Unpleasant`, `Calm ↔ Aroused`.
- Aktueller Zustand als glühender Punkt mit `--accent-cyan`-Halo.

### 8.2 Neurochemie-Triple (3-System)
- Drei vertikale Säulen-Indikatoren in einer Card:
  Dopamine (Wanting) `--accent-blue`, Serotonin (Mood) `--status-success`,
  Norepinephrine (Arousal) `--accent-pink`.
- Pegel 0–100, mit Trend-Sparkline rechts daneben.

### 8.3 Sleep-Cycle-Ring
- Kreisförmige Progress-Ring (240 px).
- Segmente: SWS (tief-blau), REM (cyan), Wake (transparent).
- Center: nächster Sleep-Trigger („in 2 h 14 m") + Druck-Wert.

### 8.4 Hub-Aktivierungs-Graph
- Force-Directed Graph, Hubs als Knoten mit `--accent-gradient`-Glow.
- Aktive Spreading-Activation als animierte Cyan-Pulse entlang der Kanten.
- Inaktive Knoten 40% Alpha.

### 8.5 Memory-Retention-Curve
- Linien-Chart Strength × Time, x-Achse log-skaliert.
- Vergessenskurve gepunktet, gepinnte Memories als helle Punkte oberhalb.

### 8.6 Motivation-Stack
- Stacked-Bar (horizontal), Segmente nach Drive (Curiosity, Mastery,
  Connection, Coherence). Aktiver Drive bekommt Glow.

## 9. Iconografie

- **Set:** Phosphor Icons (Bold-Variante) oder Heroicons-Solid.
- **Größen:** 16 / 20 / 24 px. Sidebar-Tile 20 px Icon in 40 px Tile.
- Bei aktiver Sidebar-Item: weiß auf `--accent-gradient` Tile.
- Bei inaktiv: Icon weiß 70%, Tile-Bg `rgba(255,255,255,0.04)`.

## 10. Motion

- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` Standard.
- **Duration:** 150 ms (Hover), 250 ms (State-Change), 400 ms (Layout).
- **Hub-Pulse:** 2 s Loop, Opacity 0.6 → 1 → 0.6, kein Scale.
- **Page-Transition:** 200 ms Fade + 8 px Y-Slide.
- **Reduced-Motion:** alle Pulse / Slides deaktivieren — nur Opacity-Fade
  übrig lassen.

## 11. Accessibility

- Kontrast Body-Text auf Card ≥ 7:1 (`#A0AEC0` auf `#0F1535` ✔).
- Akzent-Blau auf Karte ≥ 4.5:1 — bei Buttons immer weißer Text.
- Focus-Ring: 2 px `--accent-cyan` mit 2 px Offset, nie unterdrücken.
- Charts haben tabellarisches Fallback (`<details>` mit `<table>`).
- Glow ≠ Information; jeder Glow hat ein Text- oder Icon-Label.

## 12. Responsive Breakpoints

| Breakpoint | Sidebar | Grid |
|---|---|---|
| ≥1440 px | 264 px | 12 Spalten |
| 1024–1439 px | 264 px | 12 Spalten, KPI-Tiles 4-up → 2-up |
| 768–1023 px | 80 px (collapsed) | 8 Spalten |
| <768 px | Off-canvas Drawer | 4 Spalten, Karten full-width |

## 13. Naming-Konvention (CSS-Tokens)

```
--bg-*          Hintergrund-Flächen
--surface-*     Karten/Modals
--border-*      Linien
--text-*        Schrift
--accent-*      Brand & Daten-Akzente
--status-*      Semantisch (success/warn/danger/info)
--shadow-*      Schatten/Glow-Presets
--radius-*      Eckenradien (sm/md/lg/xl)
--space-*       Spacing-Skala (4-Punkt-Grundraster)
```

Konkrete Werte: `--space-1 = 4 px`, `--space-2 = 8`, `--space-3 = 12`,
`--space-4 = 16`, `--space-5 = 20`, `--space-6 = 24`, `--space-8 = 32`,
`--space-10 = 40`, `--space-12 = 48`.

## 14. Don'ts

- Kein reines Schwarz `#000` für Karten — immer der Navy-Verlauf.
- Kein Light-Mode parallel — eine Stimmung, ein Look.
- Keine harten 1 px-Linien zwischen Karten — Spacing trennt, nicht Border.
- Keine Magenta/Pink-Akzente außerhalb von Anomalien & Arousal.
- Keine Drop-Shadows auf Text.
- Keine Schriftarten außerhalb der Plus-Jakarta-/JetBrains-Mono-Achse.

## 15. Referenzen

- Vision UI Dashboard PRO (Creative Tim) — Glassmorphism-Cards, Globe-BG,
  Sidebar-Pattern.
- Mapping auf mycelium-Architektur: siehe `CLAUDE.md` §„Roadmap" und
  `docs/affect-observables.md` für Datenquellen der Affekt-Visualisierung.
