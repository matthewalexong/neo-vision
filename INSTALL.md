# NeoVision Bridge — Installation Guide

## Quick Setup (Recommended)

```bash
npm install -g neo-vision
npx neo-vision --setup
```

Or clone and run locally:

```bash
git clone https://github.com/matthewalexong/neo-vision
cd neo-vision
./setup.sh
```

The setup script installs dependencies, copies the Chrome extension to `~/NeoVision-Bridge-Extension/`, and detects your AI agent framework.

## Manual Setup

### 1. Install NeoVision

```bash
npm install -g neo-vision
```

### 2. Load the Chrome Extension

The extension is included at `extension/` in the package (or `~/NeoVision-Bridge-Extension/` after running setup).

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder

The extension badge shows **red OFF** until a bridge server connects.

### 3. Configure Your AI Agent

The MCP server needs the `--bridge` flag to start the WebSocket server that connects to the extension.

**Hermes** (`~/.hermes/config.yaml`):
```yaml
mcp_servers:
  neo-vision:
    command: neo-vision
    args:
    - --bridge
    timeout: 120
    connect_timeout: 30
```

**Claude Desktop** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "neo-vision": {
      "command": "neo-vision",
      "args": ["--bridge"]
    }
  }
}
```

**Any MCP-compatible agent:**
```bash
neo-vision --bridge
```

### 4. Verify Connection

Once the MCP server starts with `--bridge`, the extension badge should turn **green ON** within 5 seconds. If it doesn't:

- Check that the extension is loaded and enabled
- Check that no other process is using port 7665
- Click the extension icon and hit **Connect**

## Architecture

```
AI Agent ←→ MCP Server ←→ WebSocket (port 7665) ←→ Chrome Extension ←→ Real Browser
```

The bridge gives your AI agent access to a real Chrome session with real cookies, real fingerprints, and no CAPTCHA triggers — through standard MCP tools.

## Available Bridge Tools

| Tool | Description |
|------|-------------|
| `bridge_navigate` | Navigate to a URL |
| `bridge_inject_spatial` | Inject NeoVision spatial map |
| `bridge_click` | Click at x,y coordinates |
| `bridge_type` | Type text at x,y coordinates |
| `bridge_scroll` | Scroll the page |
| `bridge_execute_js` | Run JavaScript in page context |
| `bridge_screenshot` | Capture the visible tab |
| `bridge_get_page_info` | Get URL, title, tab status |
| `bridge_get_page_text` | Extract page text content |
| `bridge_wait` | Wait with human-like timing |
| `bridge_status` | Check extension connection status |

## Troubleshooting

**Extension shows ERR_CONNECTION_REFUSED:**
The MCP server isn't running with `--bridge`. Start it or restart your AI agent framework.

**Badge stays red after server starts:**
Click the extension icon → click **Connect**. If using a non-default port, enter the full `ws://` URL.

**Port 7665 already in use:**
Another instance of the bridge is running. Kill it with `lsof -ti:7665 | xargs kill` and try again.
