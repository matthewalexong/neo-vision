# NeoVision

**See the web the way Neo sees the Matrix.**

Give your AI agent a pixel-precise JSON map of every element on a page — coordinates, ARIA roles, accessible labels, and actionability flags — without screenshots, without brittle CSS selectors, without getting blocked by anti-bot systems.

**Version 0.6.0** · MIT License · [GitHub](https://github.com/matthewalexong/neo-vision)

## The Problem

AI agents navigating the web today are stuck between two bad options:

1. **CSS selectors / XPath** — break the moment a developer renames a class or ships a redesign
2. **Vision models on screenshots** — hallucinate coordinates, struggle with dense UIs, cost a fortune in tokens

Meanwhile, anti-bot systems block headless browsers on sight. So even if you solve the navigation problem, you can't get past the front door of sites like Yelp, LinkedIn, or Zillow.

## The Solution

NeoVision asks the browser's own layout engine where everything is — because it already knows. Like Neo seeing through the green code to perceive the real world, NeoVision reads the raw DOM but gives your agent a spatial map with ground-truth pixel coordinates, straight from the rendering engine.

```json
{
  "tag": "button",
  "role": "button",
  "label": "Sign in",
  "bounds": { "x": 305, "y": 510, "width": 74, "height": 36 },
  "click_center": { "x": 342, "y": 528 },
  "actionable": true
}
```

No guessing. No hallucination. No selector that breaks tomorrow.

NeoVision drives the user's **real Chrome** via a Chrome extension — with real cookies, real fingerprint, real browsing history. Anti-bot systems see a real user because it _is_ a real browser.

We tested this against the five most notoriously anti-bot sites on the web — **Ticketmaster**, **Nike**, **LinkedIn**, **Instagram**, and **Amazon** — plus **Discord** (Cloudflare). All six returned full page content with zero CAPTCHAs, zero bot walls, and zero detection signals. [Full test report →](STEALTH_TEST_REPORT.md)

## Quick Start

### 1. Install the NeoVision Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder from this repo
4. The NeoVision Bridge icon will appear in your toolbar

### 2. Add to Your MCP Config

```json
{
  "mcpServers": {
    "neo-vision": {
      "command": "npx",
      "args": ["neo-vision"]
    }
  }
}
```

The MCP server starts automatically. The Chrome extension connects to it via WebSocket. Once connected, all 15 spatial tools are available.

## MCP Tools

NeoVision exposes **15 tools** through the MCP server, organized by function:

### Core Navigation

| Tool | Description |
|------|-------------|
| `spatial_snapshot` | Navigate to a URL and return a spatial DOM map with element coordinates, ARIA roles, and actionability flags. Supports `compact` and `agent` output formats. |
| `spatial_click` | Click at specified pixel coordinates. Returns updated spatial map reflecting page state after the click. |
| `spatial_type` | Type text into an element. Supports `clear_first` to replace existing text and `press_enter` to submit. |
| `spatial_scroll` | Scroll the page or a specific scrollable container. Returns updated spatial map. |
| `spatial_query` | Filter the cached spatial map by ARIA role, HTML tag, label text, bounding box region, or actionability — without reloading the page. |

### Page Interaction

| Tool | Description |
|------|-------------|
| `spatial_screenshot` | Capture a PNG screenshot of the current page as base64-encoded data. |
| `spatial_navigate` | Load a URL without capturing a snapshot — lighter-weight than `spatial_snapshot` when you just need to navigate. |
| `spatial_wait` | Pause execution for a specified duration. Use for pacing between page navigations. |
| `spatial_execute_js` | Run arbitrary JavaScript in the page context and return the result. Full access to DOM, window, and page variables. |

### Advanced

| Tool | Description |
|------|-------------|
| `spatial_get_injectable` | Get the NeoVision snapshot logic as injectable JavaScript for external browser contexts. Returns a self-invoking script, an installer, or raw source. |
| `spatial_pace` | Human-like pacing manager for multi-page scraping sessions. Manages randomized delays, periodic breaks, CAPTCHA detection, and automatic slowdown. Prevents anti-bot pattern detection across long scraping runs. |

### Session Management

| Tool | Description |
|------|-------------|
| `spatial_connect_cdp` | Connect to the user's real Chrome browser via Chrome DevTools Protocol. NeoVision automatically relaunches Chrome with CDP enabled if needed. All spatial tools then operate on the real browser session. |
| `spatial_disconnect_cdp` | Release the CDP connection. The user's Chrome stays open. |
| `spatial_import_cookies` | Import cookies into the browser session. Use to warm up sessions with cookies from the user's real browser for anti-bot bypass. |
| `spatial_export_cookies` | Export cookies from the current browser session. Optionally filter by domain. |

## Architecture

NeoVision uses an **extension-only architecture**:

```
AI Agent ←→ MCP Server ←→ WebSocket Bridge ←→ Chrome Extension ←→ Real Chrome
```

1. The MCP server runs as a local daemon (or via `npx neo-vision`)
2. The Chrome extension connects to the MCP server over WebSocket on port 7665
3. MCP tools send commands to the extension (navigate, snapshot, click, type, scroll)
4. The extension executes them in real Chrome tabs and returns results

**Why this matters:** Anti-bot systems like DataDome and Cloudflare don't just check browser fingerprints — they build trust scores over time based on browsing history, cookie age, and behavioral patterns. A freshly launched headless browser starts with zero trust. NeoVision inherits the user's full trust score because it drives their actual Chrome session.

### Auto-reconnect

If the extension disconnects (e.g. Chrome restarts), the bridge automatically waits 10 seconds and attempts to relaunch Chrome with the extension. This retries up to 3 times before giving up, so brief disruptions are handled transparently.

### Running as a Background Daemon

For always-on usage, install the launchd plist to run the daemon at login:

```bash
mkdir -p ~/.neo-vision/logs
cp ai.neovision.daemon.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/ai.neovision.daemon.plist
```

This starts `dist/daemon.js` at login, keeps it alive, and logs to `~/.neo-vision/logs/`.

## Output Formats

`spatial_snapshot` supports two output formats:

### Compact (default)

Returns every visible element with pixel coordinates, ARIA roles, accessible labels, and actionability flags. Use for general browsing, UI interaction, and element targeting.

### Agent

Optimized for AI agent context windows on text-dense pages (Wikipedia, Amazon, long articles). Returns:

- **page_text** — deduplicated readable text from the current viewport (overlapping DOM nodes collapsed by position, JS code stripped)
- **interactive_elements** — only actionable elements within the viewport, with click_center coordinates
- **viewport_info** — scroll position, page height, percent_seen, percent_remaining
- **_navigation** — hint with the exact `spatial_scroll` delta to advance to the next viewport

Use agent mode on any page that returns 1000+ elements in compact mode, or when you need readable text content for research and summarization.

## API Reference

### `SpatialElement`

Each element in the map includes:

```typescript
{
  idx: number;                    // index in the flat array
  tag: string;                    // HTML tag
  role: string | null;            // ARIA role (explicit or implicit)
  label: string | null;           // accessible name
  text: string | null;            // visible text content
  bounds: { x, y, width, height }; // absolute pixel coordinates
  click_center: { x, y } | null; // where to click (center of bounds)
  actionable: boolean;            // can this element be interacted with?
  input_type: string | null;      // for <input>: text, email, password, etc.
  focusable: boolean;             // can this element receive focus?
  selector: string;               // CSS selector hint
  parent_idx: number | null;      // parent element index
  computed: {                     // CSS layout info
    position, z_index, display, overflow, opacity
  }
}
```

## How Determinism Works

Given the same HTML + CSS + viewport size + zoom level, browsers produce identical pixel coordinates for every element. This is guaranteed by the W3C CSS specification — it's how browsers paint the screen.

NeoVision locks the viewport, device scale factor, locale, timezone, and scroll position before taking a snapshot. Two independent snapshots of the same page produce byte-identical JSON (excluding the timestamp field).

## Use Cases

- **AI agent navigation** — give your agent a coordinate system instead of asking it to guess
- **Anti-bot-resistant data extraction** — extract structured data from sites that block headless browsers
- **Real-browser automation** — drive the user's real Chrome with full session context
- **Multi-page scraping** — use `spatial_pace` for human-like session management across hundreds of pages
- **Accessibility auditing** — map every interactive element with its ARIA role and label
- **Visual regression** — compare spatial maps across deploys to catch layout changes
- **Test automation** — click by what an element _is_, not what class it has

## Framework Integration

Works with any agent framework that supports MCP:

```
Claude Code / Cowork / Cursor / Windsurf / OpenClaw / AntiGravity
→ Use the MCP server — it just works
```

For custom integrations, use the injectable script directly:

```typescript
import { getInjectableScript } from 'neo-vision/injectable';

const script = getInjectableScript({ verbosity: 'actionable' });
// Inject into any browser context via CDP, extension, or DevTools console
```

## License

MIT
