#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager, type SessionConfig } from "./session.js";
import { takeSnapshot, navigateWithFallback, type SnapshotOptions } from "./snapshot.js";
import { click, type as typeAction, scroll } from "./actions.js";
import { SnapshotInput, PublicSnapshotInput, ClickInput, TypeInput, ScrollInput, QueryInput } from "./schema.js";
import type { SpatialMap } from "./schema.js";
import { queryMap } from "./query.js";

const session = new SessionManager();
let lastSnapshot: SpatialMap | null = null;
let lastSnapshotOptions: SnapshotOptions | null = null;
let lastSessionConfig: SessionConfig | null = null;
let lastMaxElements: number = 2000;
let lastCompact: boolean = true;
let lastOutputFormat: "compact" | "agent" = "compact";

// ─── Helper: compact + truncate snapshot to fit context windows ──

// Pattern: long JS snippets that leaked from element textContent
const JS_CODE_RE = /^(window\.|var |const |let |function |typeof |if \(|= new |document\.|console\.)/i;

function sanitizeText(t: string | null): string | null {
  if (!t || typeof t !== "string") return null;
  // Strip JS code that leaked via innerText of containers adjacent to <script>
  if (JS_CODE_RE.test(t)) return null;
  // Collapse whitespace and trim
  t = t.replace(/\s+/g, " ").trim();
  // Hard cap at 100 chars to prevent text-dense pages from blowing up
  if (t.length > 100) t = t.slice(0, 100) + "\u2026";
  return t || null;
}

function compactElement(el: any) {
  return {
    idx: el.idx,
    tag: el.tag,
    role: el.role,
    label: sanitizeText(el.label),
    text: sanitizeText(el.text),
    bounds: el.bounds,
    click_center: el.click_center,
    actionable: el.actionable,
  };
}

function agentElement(el: any) {
  return {
    idx: el.idx,
    tag: el.tag,
    role: el.role,
    label: sanitizeText(el.label),
    text: sanitizeText(el.text),
    bounds: el.bounds,
    click_center: el.click_center,
    actionable: el.actionable,
  };
}

/**
 * Agent output mode: page text + interactive element coordinates only.
 * Two optimizations together solve the context problem:
 *   1. Field stripping — only return text content and interactive elements.
 *   2. Viewport scoping — only return elements visible in the current viewport.
 *
 * The full snapshot is cached server-side. The agent scrolls to reveal more.
 */
function formatAgentSnapshot(snapshot: SpatialMap, maxElements: number): string {
  const { width: vw, height: vh } = snapshot.viewport;
  const { x: sx, y: sy } = snapshot.scroll;
  const pageH = snapshot.page_bounds.height;

  // Viewport bounds (account for current scroll).
  // Clamp the far edge to the actual page dimensions so that elements rendered
  // beyond the page bounds (e.g. in hidden overflow containers) are excluded.
  // We take the smaller of page extent and viewport extent.
  const pageW = snapshot.page_bounds.width; // used for clamping X axis
  const effectiveVw = Math.min(vw, pageW);
  const effectiveVh = Math.min(vh, pageH);
  const vX1 = sx, vY1 = sy;
  const vX2 = sx + effectiveVw, vY2 = sy + effectiveVh;
  // How much of page has been scrolled past
  const scrollBottom = sy + vh;
  const pctSeen = pageH > 0 ? Math.min(100, Math.round((scrollBottom / pageH) * 100)) : 0;
  const pctRemaining = 100 - pctSeen;

  // Helper: element is truly inside viewport.
  // Requires the element's click_center to fall within viewport bounds.
  // This prevents wide elements whose left edge barely peeks into view from leaking in.
  function inViewport(el: any): boolean {
    // If we have a click center, require it to be in viewport
    if (el.click_center) {
      const cx = el.click_center.x, cy = el.click_center.y;
      return cx >= vX1 && cx < vX2 && cy >= vY1 && cy < vY2;
    }
    // Fallback: check bounds center for non-clickable elements
    const cX = el.bounds.x + el.bounds.width / 2;
    const cY = el.bounds.y + el.bounds.height / 2;
    return cX >= vX1 && cX < vX2 && cY >= vY1 && cY < vY2;
  }

  // 1. Extract page text from elements inside viewport.
  //    Deduplicate overlapping DOM subtrees: elements from nested DOM that render the same
  //    text get the same top-left position. Group by (x,y) on a 10px grid, keep longest.
  const viewportTextCandidates = snapshot.elements.filter(
    (el): el is typeof el & { text: string } =>
      inViewport(el) && el.text != null && el.text.trim().length > 0
  );

  // Normalize + collect candidate texts
  const candidates: { key: string; text: string }[] = [];
  for (const el of viewportTextCandidates) {
    const t = el.text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    // Grid by top-left corner (more stable across DOM depth than center)
    const gx = Math.round(el.bounds.x / 10) * 10;
    const gy = Math.round(el.bounds.y / 10) * 10;
    candidates.push({ key: `${gx},${gy}`, text: t.length > 120 ? t.slice(0, 120) + "\u2026" : t });
  }

  // First pass: keep longest per grid cell
  const byGrid = new Map<string, string>();
  const orderedTexts: string[] = [];
  for (const c of candidates) {
    const cur = byGrid.get(c.key);
    // Prefer longer; if equal length, prefer non-ellipsised
    const isEllipsed = (s: string) => s.endsWith("\u2026");
    if (!cur || c.text.length > cur.length || (c.text.length === cur.length && !isEllipsed(c.text) && isEllipsed(cur))) {
      byGrid.set(c.key, c.text);
    }
  }

  // Second pass: remove substring duplicates (parent text often contains child text verbatim)
  // Sort by length descending so longer (parent) texts are checked first
  const sorted = [...byGrid.values()].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const t of sorted) {
    let isDuplicate = false;
    for (const k of kept) {
      // If this text is >=70% contained in an already-kept text, it's a duplicate
      const needle = t.endsWith("\u2026") ? t.slice(0, -1) : t;
      const haystack = k.endsWith("\u2026") ? k.slice(0, -1) : k;
      if (needle.length > 3 && haystack.includes(needle)) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) kept.push(t);
  }

  // Restore reading order by matching back to original grid positions
  const gridToText = new Map<string, string>();
  for (const [key, text] of byGrid) {
    // Only include if this text survived dedup
    if (kept.includes(text)) {
      gridToText.set(key, text);
    }
  }
  const textGroups: { cy: number; cx: number; text: string }[] = [];
  for (const [key, text] of gridToText) {
    const [cx, cy] = key.split(",").map(Number);
    textGroups.push({ cx, cy, text });
  }
  textGroups.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const textElements = textGroups.map((g) => g.text);

  // 2. Get only actionable elements with coordinates, scoped to viewport
  const actionable = snapshot.elements.filter(
    (el) => el.actionable && el.click_center && inViewport(el)
  );
  const totalActionable = actionable.length;
  const truncated = totalActionable > maxElements;
  const shown = truncated ? actionable.slice(0, maxElements) : actionable;

  const output: any = {
    url: snapshot.url,
    timestamp: snapshot.timestamp,
    page_text: textElements.join("\n\n") || "(no visible text)",
    interactive_elements: shown.map(agentElement),
    viewport_info: {
      scroll_x: sx,
      scroll_y: sy,
      viewport_width: vw,
      viewport_height: vh,
      scroll_bottom: scrollBottom,
      page_height: pageH,
      percent_seen: pctSeen,
      percent_remaining: pctRemaining,
    },
    stats: {
      total_elements: snapshot.stats.total_elements,
      actionable_elements: snapshot.stats.actionable_elements,
      focusable_elements: snapshot.stats.focusable_elements,
      text_paragraphs: textElements.length,
      interactive_shown: shown.length,
      interactive_total: totalActionable,
    },
  };

  if (truncated) {
    output._truncated = {
      showing: maxElements,
      total: totalActionable,
      message: `Showing ${maxElements} of ${totalActionable} interactive elements in this viewport.`,
    };
  }

  // Navigation hint
  if (pctRemaining > 5) {
    output._navigation = {
      hint: `Page extends ${pageH}px tall. You've seen ${pctSeen}% — ${pctRemaining}% below. Call spatial_scroll(delta_y=${vh - 50}) to scroll down and re-request agent output.`,
    };
  }

  return JSON.stringify(output, null, 2);
}

function formatSnapshot(snapshot: SpatialMap, maxElements: number, compact: boolean, outputFormat: "compact" | "agent" = "compact"): string {
  if (outputFormat === "agent") {
    return formatAgentSnapshot(snapshot, maxElements);
  }

  const totalElements = snapshot.elements.length;
  const truncated = totalElements > maxElements;
  const elements = truncated ? snapshot.elements.slice(0, maxElements) : snapshot.elements;
  const outputElements = compact ? elements.map(compactElement) : elements;

  const output: any = {
    url: snapshot.url,
    timestamp: snapshot.timestamp,
    viewport: snapshot.viewport,
    scroll: snapshot.scroll,
    page_bounds: snapshot.page_bounds,
    stats: {
      ...snapshot.stats,
      total_elements: totalElements,
    },
    elements: outputElements,
  };

  if (truncated) {
    output._truncated = {
      showing: maxElements,
      total: totalElements,
      message: `Showing ${maxElements} of ${totalElements} elements. Scroll down and re-snapshot to see more, or use spatial_query to filter the full cached map.`,
    };
  }

  return JSON.stringify(output, null, 2);
}

const NEO_VISION_DESCRIPTION = [
  "See the web the way Neo sees the Matrix.",
  "Launches a real Chrome browser automatically — no setup, no CDP, no manual browser management.",
  "",
  "BROWSER SETUP: Uses real Chrome in stealth mode by default — persistent profile at ~/.neo-vision/chrome-profile that retains cookies/history across sessions,",
  "realistic user agent, --disable-automation flag, and 10+ anti-detection patches (navigator.webdriver, WebGL fingerprint, plugins, permissions).",
  "Human-like behavioral simulation: bezier mouse curves, variable typing speed, click jitter, incremental scrolling.",
  "",
  "WORKFLOW: spatial_snapshot (open URL) → spatial_click / spatial_type / spatial_scroll (interact) → spatial_query (filter cached map).",
  "Every action tool returns an updated spatial map automatically. Use element.click_center coordinates to target elements.",
  "",
  "OUTPUT FORMATS: Two modes controlled by the output_format parameter:",
  "  - 'compact' (default): Full element list with coordinates, roles, labels, text, and actionability flags.",
  "    Includes viewport, scroll, stats, and optional _navigation hints for long pages.",
  "  - 'agent': Optimized for AI agent context windows. Returns deduplicated readable page text",
  "    (overlapping DOM elements collapsed by bounding box) + only interactive/viewport-scoped elements",
  "    with their click coordinates. Includes viewport_info with scroll position, page height, and",
  "    percent_remaining so the agent knows how much more content is below. Use spatial_scroll to",
    'advance the viewport, then re-call spatial_snapshot with output_format="agent" for text-dense pages.',
    '',
    "FILTERING: Decorative SVG paths, 1x1 tracking pixels, and off-screen elements (x < -100 or y < -100)",
    "are automatically filtered out before any verbosity or output_format processing.",
    "AGENT MODE VIEWPORT SCOPING: In output_format='agent', elements are strictly confined to the current",
    "viewport. An element is considered 'in viewport' only if its click_center falls within the viewport",
    "bounds (not just its bounding box intersecting the edge). The viewport is also clamped to page",
    "dimensions so elements beyond the actual page width/height are excluded. This prevents wide layout",
    "leakage (e.g. Amazon's 3-column product rows rendered beyond 1280px).",
    "TEXT DEDUPLICATION: In agent mode, overlapping DOM subtrees are deduplicated using a two-pass approach:",
    "first, grid-based grouping by top-left bounding box coordinates (10px tolerance), keeping the longest",
    "non-truncated version per cell. Second, cross-cell substring elimination removes shorter texts that",
    "are fully contained within a longer text fragment. Final output is sorted by reading order (y, then x).",
    "Text is sanitized: JavaScript code snippets are stripped, whitespace collapsed, long text truncated at 120 chars.",
    "",
    "Do NOT launch Chrome yourself or use any other browser automation — this server handles everything.",
].join(" ");

const server = new McpServer({
  name: "neo-vision",
  version: "0.2.0",
  description: NEO_VISION_DESCRIPTION,
});

// ─── Helper: get the current page (reuses last session config) ──

async function getActivePage(): Promise<import("playwright").Page> {
  const page = session.getCurrentPage();
  if (!page) {
    throw new Error("No active session. Call spatial_snapshot first to open a page.");
  }
  return page;
}

// ─── spatial_snapshot ────────────────────────────────────────────

server.tool(
  "spatial_snapshot",
  `Navigate to a URL and return a spatial map of the page. Launches a real Chrome browser automatically — no setup required.

**Output modes** (controlled by output_format parameter):
  - 'compact' (default): Returns every visible element with pixel coordinates, ARIA roles, accessible labels, and actionability flags. Use the click_center coordinates from each element to target it with spatial_click or spatial_type.
  - 'agent': Optimized for AI agent context windows on text-dense pages (Wikipedia, Amazon, long articles). Returns:
    * 'page_text': deduplicated readable text from the current viewport (overlapping DOM nodes collapsed by position via 2-pass dedup: 10px grid + substring elimination, JS code stripped, text limited to 120 chars)
    * 'interactive_elements': only actionable elements within the viewport, with their click_center coordinates. Elements are strictly confined to viewport bounds — wide-layout pages (multi-column) won't leak off-screen elements.
    * 'viewport_info': scroll position, page height, percent_seen, percent_remaining — tells you how much more content is below
    * '_navigation': a hint with the exact spatial_scroll delta to use to advance to the next viewport

**When to use agent mode**: On any page that returns 1000+ elements in compact mode, or when you need the readable text content for research/summarization tasks. After calling spatial_scroll(delta_y=...), re-call spatial_snapshot with output_format='agent' to get the next viewport's content.

**Note**: The full DOM map is always cached server-side. You do NOT need to re-snapshot after clicks, typing, or scrolling — every action returns an updated map automatically. Re-snapshot with the same URL only when you want to reload or switch URLs.

The browser session persists across calls. Calling this again with a different URL navigates to that URL. Calling with the same URL reloads it.`,
  PublicSnapshotInput.shape,
  async (params) => {
    try {
      const input = PublicSnapshotInput.parse(params);

      // Apply internal defaults — agents never need to set these
      const config: SessionConfig = {
        browserMode: "stealth",
        viewportWidth: input.viewport_width,
        viewportHeight: input.viewport_height,
        zoom: input.zoom,
      };

      const page = await session.getPage(config);
      lastSessionConfig = config;

      // Navigate with smart fallback
      await navigateWithFallback(page, input.url);

      const snapshotOptions: SnapshotOptions = {
        settleMs: input.settle_ms,
        includeNonVisible: input.include_non_visible,
        maxDepth: input.max_depth,
        verbosity: input.verbosity,
      };

      lastSnapshot = await takeSnapshot(page, snapshotOptions);
      lastSnapshotOptions = snapshotOptions;
      lastMaxElements = input.max_elements;
      lastCompact = input.compact;
      lastOutputFormat = input.output_format;

      const json = formatSnapshot(lastSnapshot, input.max_elements, input.compact, input.output_format);

      return {
        content: [
          {
            type: "text" as const,
            text: json,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error taking snapshot: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_click ───────────────────────────────────────────────

server.tool(
  "spatial_click",
  `Click an element on the page at exact pixel coordinates. Use the click_center.x and click_center.y values from a spatial_snapshot element.

Returns an updated spatial map reflecting the page state after the click (including any navigation, modals, or DOM changes triggered by the click). You do NOT need to call spatial_snapshot again after clicking.

Requires an active session — call spatial_snapshot first to open a page.`,
  ClickInput.shape,
  async (params) => {
    try {
      const input = ClickInput.parse(params);
      const page = await getActivePage();

      if (!lastSnapshotOptions) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      lastSnapshot = await click(page, input.x, input.y, input.button, input.click_count, lastSnapshotOptions);

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error clicking: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_type ────────────────────────────────────────────────

server.tool(
  "spatial_type",
  `Type text into an element. If x/y coordinates are provided, clicks that position first to focus the element, then types. Otherwise types into whatever element currently has focus.

Set clear_first=true to replace existing text (selects all + deletes before typing). Set press_enter=true to submit after typing (useful for search boxes).

Returns an updated spatial map. Requires an active session — call spatial_snapshot first.`,
  TypeInput.shape,
  async (params) => {
    try {
      const input = TypeInput.parse(params);
      const page = await getActivePage();

      if (!lastSnapshotOptions) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      lastSnapshot = await typeAction(
        page,
        input.text,
        {
          x: input.x,
          y: input.y,
          clearFirst: input.clear_first,
          pressEnter: input.press_enter,
        },
        lastSnapshotOptions
      );

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error typing: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_scroll ──────────────────────────────────────────────

server.tool(
  "spatial_scroll",
  `Scroll the page or a specific scrollable container. Use delta_y with positive values to scroll down, negative to scroll up. Optionally target a specific scrollable element by passing its x/y coordinates.

Returns an updated spatial map reflecting the new scroll position and any newly visible elements. Requires an active session — call spatial_snapshot first.`,
  ScrollInput.shape,
  async (params) => {
    try {
      const input = ScrollInput.parse(params);
      const page = await getActivePage();

      if (!lastSnapshotOptions) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      lastSnapshot = await scroll(page, input.delta_x, input.delta_y, input.x, input.y, lastSnapshotOptions);

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error scrolling: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_query ───────────────────────────────────────────────

server.tool(
  "spatial_query",
  `Filter the current spatial map without re-loading the page. Search for elements by ARIA role, HTML tag, label text, bounding box region, or actionability. Much faster than taking a new snapshot — use this when the page hasn't changed and you need to find specific elements.

Requires a prior spatial_snapshot call (uses the cached map).`,
  QueryInput.shape,
  async (params) => {
    try {
      const input = QueryInput.parse(params);

      if (!lastSnapshot) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      const filtered = queryMap(lastSnapshot, {
        role: input.role,
        tag: input.tag,
        labelContains: input.label_contains,
        region: input.region,
        actionableOnly: input.actionable_only,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error querying: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NeoVision MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await session.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await session.close();
  process.exit(0);
});
