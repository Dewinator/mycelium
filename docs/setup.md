# Setup — mycelium in deinen KI-Agenten einbinden

> Du hast mycelium installiert? Hier erfährst du, wie dein Agent es als
> Werkzeug nutzt.
>
> Eine interaktive Variante mit Copy-Buttons findest du nach dem Start im
> lokalen Dashboard unter [`http://127.0.0.1:8787/setup`](http://127.0.0.1:8787/setup).

## Was ist MCP?

**MCP** (Model Context Protocol) ist ein offener Standard, mit dem KI-Agenten
externe Werkzeuge und Wissensquellen ansprechen können.

mycelium ist ein solches MCP-Werkzeug — ein lokales Langzeitgedächtnis für
deinen Agenten. Einmal verbunden, beginnt nicht jeder Chat von vorn.

In jedem unterstützten Client gibst du eine kleine JSON- oder TOML-Datei an,
die mycelium als Server eintragen lässt. Der Agent startet ihn dann
automatisch und kann seine Werkzeuge (`remember`, `recall`, `prime_context`,
…) nutzen.

> **Platzhalter:** Ersetze `$MYCELIUM_PATH` in den folgenden Snippets durch
> den absoluten Pfad zu deinem mycelium-Checkout — also den Ordner, in dem
> `mcp-server/dist/index.js` liegt (z.B. `/Users/reed/mycelium`).

---

## Claude Code

**Datei**

| OS      | Pfad                                                  |
|---------|-------------------------------------------------------|
| macOS   | `~/.claude.json` (oder pro Projekt `.mcp.json`)       |
| Linux   | `~/.claude.json` (oder pro Projekt `.mcp.json`)       |
| Windows | `%USERPROFILE%\.claude.json` (oder pro Projekt `.mcp.json`) |

**Snippet**

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
    }
  }
}
```

**Verifikation:** Frag deinen Agenten *„Was weißt du über mein letztes Projekt?"* — wenn mycelium eingebunden ist, taucht ein `recall`-Tool im Trace auf.

[Offizielle Doku →](https://docs.claude.com/en/docs/claude-code/mcp)

---

## Claude Desktop

**Datei**

| OS      | Pfad                                                                  |
|---------|------------------------------------------------------------------------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json`       |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                          |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                          |

**Snippet**

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
    }
  }
}
```

**Verifikation:** Claude Desktop neu starten. Im Chat oben rechts erscheint ein Tools-Symbol mit den mycelium-Werkzeugen (`remember`, `recall`, …).

[Offizielle Doku →](https://modelcontextprotocol.io/quickstart/user)

---

## Codex CLI

**Datei**

| OS      | Pfad                              |
|---------|-----------------------------------|
| macOS   | `~/.codex/config.toml`            |
| Linux   | `~/.codex/config.toml`            |
| Windows | `%USERPROFILE%\.codex\config.toml`|

**Snippet (TOML)**

```toml
[mcp_servers.mycelium]
command = "node"
args = ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
```

**Verifikation:** `/mcp` listet aktive Server. mycelium muss dabei sein. Test-Prompt: *„recall meine letzten Erkenntnisse"*.

[Offizielle Doku →](https://github.com/openai/codex)

---

## Cursor

**Datei**

| OS      | Pfad                                                         |
|---------|--------------------------------------------------------------|
| macOS   | `~/.cursor/mcp.json` (global) oder `.cursor/mcp.json` (Projekt) |
| Linux   | `~/.cursor/mcp.json` (global) oder `.cursor/mcp.json` (Projekt) |
| Windows | `%USERPROFILE%\.cursor\mcp.json` (global) oder `.cursor\mcp.json` (Projekt) |

**Snippet**

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
    }
  }
}
```

**Verifikation:** *Cursor → Settings → MCP*: mycelium muss als grüner Eintrag erscheinen. Im Composer „recall" tippen — mycelium-Tool sollte vorgeschlagen werden.

[Offizielle Doku →](https://docs.cursor.com/context/model-context-protocol)

---

## Cline (VS Code Extension)

**Datei**

| OS      | Pfad                                                                                          |
|---------|-----------------------------------------------------------------------------------------------|
| macOS   | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Linux   | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`    |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`  |

**Snippet**

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
    }
  }
}
```

**Verifikation:** Cline-Panel öffnen, MCP-Tab anklicken — mycelium muss mit Tool-Liste erscheinen.

[Offizielle Doku →](https://github.com/cline/cline/blob/main/docs/mcp/README.md)

---

## Continue (VS Code / JetBrains)

**Datei**

| OS      | Pfad                            |
|---------|---------------------------------|
| macOS   | `~/.continue/config.json`       |
| Linux   | `~/.continue/config.json`       |
| Windows | `%USERPROFILE%\.continue\config.json` |

**Snippet**

```json
{
  "experimental": {
    "modelContextProtocolServer": {
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
      }
    }
  }
}
```

**Verifikation:** Continue-Panel → Tools/MCP-Sektion zeigt mycelium-Tools. Wenn nicht: Continue-Logs prüfen.

[Offizielle Doku →](https://docs.continue.dev/customize/deep-dives/mcp)

---

## Zed

**Datei**

| OS      | Pfad                          |
|---------|-------------------------------|
| macOS   | `~/.config/zed/settings.json` |
| Linux   | `~/.config/zed/settings.json` |
| Windows | `%APPDATA%\Zed\settings.json` |

**Snippet**

```json
{
  "context_servers": {
    "mycelium": {
      "command": {
        "path": "node",
        "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
      }
    }
  }
}
```

**Verifikation:** Zed → Assistant-Panel → Context-Server-Status: mycelium muss dort verbunden sein.

[Offizielle Doku →](https://zed.dev/docs/assistant/model-context-protocol)

---

## openClaw

**Datei**

| OS      | Pfad                                              |
|---------|---------------------------------------------------|
| macOS   | `~/.openclaw/openclaw.json` (`mcp_servers`-Block) |
| Linux   | `~/.openclaw/openclaw.json` (`mcp_servers`-Block) |
| Windows | n/a (openClaw ist heute Mac/Linux-fokussiert)     |

**Snippet**

```json
{
  "mcp_servers": {
    "mycelium": {
      "command": "node",
      "args": ["$MYCELIUM_PATH/mcp-server/dist/index.js"]
    }
  }
}
```

**Verifikation:** Im openClaw-Gateway `tools/list` aufrufen — mycelium-Tools (`remember`, `recall`, `prime_context`, …) müssen erscheinen.

---

## Codex (Web)

Codex Web hat keine Datei-basierte Konfiguration. Trag mycelium in der UI ein:

*Settings → Tools → MCP → Add Server*

```
Name:    mycelium
Command: node $MYCELIUM_PATH/mcp-server/dist/index.js
```

**Wichtig:** Codex Web kann nur lokale MCP-Server erreichen, wenn dein Codex-Runner lokal läuft.

**Verifikation:** Test-Prompt *„Liste deine MCP-Tools"* — mycelium-Tools sollten dabei sein.

---

## Neuen Client ergänzen

Ein neuer Client = ein PR, ein Eintrag.

1. Eintrag in `dashboard/clients.json` ergänzen (Felder: `id`, `name`, `docsUrl`, `configFormat`, `configPath`, `snippet`, `verifyPrompt`).
2. Diese Datei (`docs/setup.md`) um den entsprechenden Abschnitt erweitern.

Dashboard-UI rendert clients.json zur Laufzeit — für die Web-Variante reicht
also Schritt 1.
