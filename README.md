# NeoVision

**See the web the way Neo sees the Matrix.**

Give your AI agent a pixel-precise JSON map of every element on a page — coordinates, ARIA roles, accessible labels, and actionability flags — without screenshots, without brittle CSS selectors, without getting blocked by anti-bot systems.

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

Then use the tools: `spatial_snapshot`, `spatial_click`, `spatial_type`, `spatial_scroll`, `spatial_query`.

## Browser Modes

| Mode | What it does | Best for |
|------|-------------|----------|
| `bundled` | Headless Playwright Chromium with stealth patches | Testing, CI/CD, bulk scraping |
| `stealth` | Launches your real Chrome install with stealth patches | Sites that detect Playwright but accept Chrome |
| `attach` | Connects to already-running Chrome via CDP | Maximum stealth — real cookies, real fingerprint, real history |

```typescript
// Bundled (default)
const browser = new SpatialBrowser({ mode: 'bundled' });

// Stealth — uses your real Chrome
const browser = new SpatialBrowser({ mode: 'stealth' });

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
| `navigator.platform` | Reports real platform |
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
