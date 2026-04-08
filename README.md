# NeoVision

**See the web the way Neo sees the Matrix.**

Give your AI agent a pixel-precise JSON map of every element on a page — coordinates, ARIA roles, accessible labels, and actionability flags — without screenshots, without brittle CSS selectors, without getting blocked by anti-bot systems.

**Version 0.5.0** · MIT License · [GitHub](https://github.com/matthewalexong/neo-vision)

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
The built-in **stealth layer** patches every major bot-detection vector (navigator.webdriver, WebGL fingerprint, plugin enumeration, permissions API) and the **attach mode** lets you drive the user's real Chrome — with real cookies, real fingerprint, real browsing history. Anti-bot systems see a real user because it _is_ a real browser.

We tested this against the five most notoriously anti-bot sites on the web — **Ticketmaster**, **Nike**, **LinkedIn**, **Instagram**, and **Amazon** — plus **Discord** (Cloudflare). All six returned full page content with zero CAPTCHAs, zero bot walls, and zero detection signals. [Full test report →](STEALTH_TEST_REPORT.md)

## Quick Start

### As a library (any agent harness)

```bash
npm install neo-vision
npx playwright install chromium
```

```typescript
import { SpatialBrowser } from 'neo-vision';

const browser = new SpatialBrowser({ mode: 'stealth' });

// Snapshot a page
const map = await browser.snapshot('https://news.ycombinator.com');

// Find all clickable links
const links = map.elements.filter(e => e.role === 'link' && e.actionable);
console.log(`Found ${links.length} links`);

// Click the first one
const updated = await browser.click(links[0].click_center!);

// Type into a search box
const search = map.elements.find(e => e.role === 'searchbox');
if (search) await browser.type('AI news', search.click_center!);

await browser.close();
```

### As an MCP server (Claude, Cursor, Windsurf, etc.)

Add to your MCP config:

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
| `spatial_get_injectable` | Get the NeoVision snapshot logic as injectable JavaScript for external browser contexts. Use this to inject NeoVision into Chrome extensions, DevTools console, bookmarklets, or any browser context outside Playwright. Returns a self-invoking script, an installer, or raw source. |
| `spatial_pace` | Human-like pacing manager for multi-page scraping sessions. Manages randomized delays, periodic breaks, CAPTCHA detection, and automatic slowdown. Prevents anti-bot pattern detection across long scraping runs. |

### Session Management

| Tool | Description |
|------|-------------|
| `spatial_connect_cdp` | Connect to the user's real Chrome browser via Chrome DevTools Protocol. NeoVision automatically relaunches Chrome with CDP enabled if needed. All spatial tools then operate on the real browser session. |
| `spatial_disconnect_cdp` | Release the CDP connection. The user's Chrome stays open. |
| `spatial_import_cookies` | Import cookies into the browser session. Use to warm up sessions with cookies from the user's real browser for anti-bot bypass. |
| `spatial_export_cookies` | Export cookies from the current browser session. Optionally filter by domain. |
## Bridge Mode (Chrome Extension)

NeoVision includes a Chrome extension (`extension/` directory) that enables **hybrid mode** — the most powerful anti-bot bypass available. Instead of launching a separate browser, NeoVision drives the user's real Chrome session with all their existing cookies, DataDome/Cloudflare trust scores, localStorage, and login sessions intact.

**How it works:**

1. Install the NeoVision Chrome extension from the `extension/` directory
2. The extension connects to the MCP server via WebSocket
3. Use `spatial_connect_cdp` or the bridge tools to drive the real browser
4. All spatial tools (snapshot, click, type, scroll) operate on the user's actual Chrome tabs

**Why this matters:** Anti-bot systems like DataDome and Cloudflare don't just check browser fingerprints — they build trust scores over time based on browsing history, cookie age, and behavioral patterns. A freshly launched Playwright browser starts with zero trust. Bridge mode inherits the user's full trust score because it _is_ their browser.

The `spatial_get_injectable` tool is designed for this workflow — inject NeoVision's spatial snapshot logic into the real Chrome via the extension, get back a structured DOM map, then use the extension's click/type tools with the coordinates from the map.

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
## Browser Modes

| Mode | What it does | Best for |
|------|-------------|----------|
| `bundled` | Headless Chromium with `--headless=new` (full browser, not headless shell), stealth patches, persistent profile | CI/CD, bulk scraping, environments without Chrome installed |
| `stealth` | Launches your real Chrome install, headed, with stealth patches and persistent profile (**default**) | Best detection avoidance — real Chrome + real profile = indistinguishable from a human |
| `attach` | Connects to already-running Chrome via CDP | Maximum stealth — your existing cookies, fingerprint, and history |

**Persistent profile:** Both `bundled` and `stealth` modes store browser data in `~/.neo-vision/chrome-profile/` by default. This means cookies, localStorage, and browsing history persist across sessions — the browser looks like a real, long-lived install instead of a freshly spawned automation instance. This is critical for avoiding bot detection.

**SingletonLock cleanup:** If the browser crashes, Chrome leaves a `SingletonLock` file in the profile directory that prevents new instances from launching. NeoVision automatically detects and removes stale lock files on startup, so crash recovery is seamless.

**Anti-automation flags:** NeoVision strips `--enable-automation` (which Playwright normally injects) and adds `--disable-automation` and `--disable-blink-features=AutomationControlled` to prevent Chrome from exposing automation signals.

**Realistic user agent:** Instead of Playwright's default UA string (which includes "HeadlessChrome"), NeoVision sets a real Chrome user agent with correct platform detection (e.g., MacIntel for macOS).

```typescript
// Stealth (default) — uses your real Chrome with persistent profile
const browser = new SpatialBrowser({ mode: 'stealth' });

// Bundled — headless but with --headless=new (less detectable than old headless)
const browser = new SpatialBrowser({ mode: 'bundled' });

// Attach — connect to running Chrome
// First: google-chrome --remote-debugging-port=9222
const browser = new SpatialBrowser({
  mode: 'attach',
  cdpUrl: 'http://localhost:9222'
});
```

## Stealth Layer

The built-in stealth module patches every major detection vector:

| Vector | What we do |
|--------|-----------|
| `navigator.webdriver` | Removed (returns `undefined`) |
| `window.chrome` | Present with runtime object |
| WebGL renderer | Reports real GPU instead of SwiftShader |
| Plugins array | Populated with standard Chrome plugins |
| Permissions API | Returns consistent results |
| `navigator.languages` | Populated with `['en-US', 'en']` |
| `navigator.platform` | Reports real platform (MacIntel for macOS) |
| CSS animations | Disabled for deterministic snapshots |
| Human mouse movement | Bezier-curved paths with ease-in-out, randomized control points |
| Click targeting | Jittered offset from element center (±3px radius) + hover pause |
| Human typing | Variable 40–120ms per character, word-boundary pauses, 5% mid-word hesitation |
| Human scrolling | Multi-tick wheel events with per-tick jitter, not instant jumps |
| Timing jitter | All waits use `humanDelay()` with configurable jitter factor |

Run the self-check:

```bash
npx tsx src/demo.ts --stealth-check
```
## API Reference

### `SpatialBrowser`

```typescript
const browser = new SpatialBrowser(options?: {
  mode?: 'bundled' | 'stealth' | 'attach';
  width?: number;        // viewport width, default 1280
  height?: number;       // viewport height, default 720
  zoom?: number;         // device scale factor, default 1.0
  cdpUrl?: string;       // CDP URL for attach mode
  chromePath?: string;   // Chrome binary path for stealth mode
  stealth?: boolean;     // enable stealth patches
});
```

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `snapshot(url, config?)` | `SpatialMap` | Navigate + snapshot |
| `refresh(config?)` | `SpatialMap` | Re-snapshot current page |
| `click(point, options?)` | `SpatialMap` | Click at coordinates |
| `type(text, at?, options?)` | `SpatialMap` | Type text |
| `scroll(deltaY, deltaX?, at?)` | `SpatialMap` | Scroll the page |
| `query(filters)` | `SpatialMap` | Filter last snapshot in memory |
| `wait(baseMs?)` | `void` | Human-paced sleep with jitter |
| `checkStealth()` | `Record<string, boolean>` | Stealth self-check |
| `close()` | `void` | Cleanup |

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
- **Hybrid browser automation** — drive the user's real Chrome via bridge mode for maximum stealth
- **Multi-page scraping** — use `spatial_pace` for human-like session management across hundreds of pages
- **Accessibility auditing** — map every interactive element with its ARIA role and label
- **Visual regression** — compare spatial maps across deploys to catch layout changes
- **Test automation** — click by what an element _is_, not what class it has

## Framework Integration

Works with any agent framework:

```typescript
// LangChain / LangGraph
import { SpatialBrowser } from 'neo-vision';

// CrewAI / AutoGen
import { SpatialBrowser } from 'neo-vision';

// Claude Code / Cowork / OpenClaw / AntiGravity
// Use the MCP server — it just works

// Raw Playwright
import { applyStealthToContext, takeSnapshot } from 'neo-vision';
```

## License

MIT