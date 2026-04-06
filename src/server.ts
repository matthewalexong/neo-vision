#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager, type SessionConfig } from "./session.js";
import { takeSnapshot, navigateWithFallback, type SnapshotOptions } from "./snapshot.js";
import { click, type as typeAction, scroll } from "./actions.js";
import { z } from "zod";
import { SnapshotInput, PublicSnapshotInput, ClickInput, TypeInput, ScrollInput, QueryInput, ImportCookiesInput, ExportCookiesInput, ConnectCDPInput, DisconnectCDPInput } from "./schema.js";
import type { SpatialMap } from "./schema.js";
import { queryMap } from "./query.js";
import { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller } from "./injectable.js";
import { PacingEngine, getCaptchaDetector, type PacingInstruction } from "./pacing.js";
import { ChromeBridge } from "./bridge.js";

const session = new SessionManager();
let lastSnapshot: SpatialMap | null = null;
let lastSnapshotOptions: SnapshotOptions | null = null;
let lastSessionConfig: SessionConfig | null = null;
let lastMaxElements: number = 2000;
let lastCompact: boolean = true;
let lastOutputFormat: "compact" | "agent" = "compact";

// ─── Helper: compact + truncate snapshot to fit context windows ──

// Pattern: long JS snippets that leaked from element textContent
const JS_CODE_RE = /^(window\.|var |const |let |function |typeof |if \(|== new |document\.|console\.)/i;
// Pattern: pure whitespace or punctuation-only text (no informational value)
const NOISE_TEXT_RE = /^[\s\p{P}]*$/u;

type TextMode = "compact" | "agent" | "full";

function sanitizeText(t: string | null, mode: TextMode = "full"): string | null {
  if (!t || typeof t !== "string") return null;
  // Strip JS code that leaked via innerText of containers adjacent to <script>
  if (JS_CODE_RE.test(t)) return null;
  // Collapse whitespace and trim
  t = t.replace(/\s+/g, " ").trim();
  // Strip pure whitespace or punctuation-only text — no informational value
  if (NOISE_TEXT_RE.test(t)) return null;
  // Mode-aware truncation limits to minimize token waste
  const limits: Record<TextMode, number> = { compact: 80, agent: 120, full: 100 };
  const limit = limits[mode];
  if (t.length > limit) t = t.slice(0, limit) + "\u2026";
  return t || null;
}

/**
 * Compact element serializer: strips CSS layout fields unless verbosity="all".
 * Compact mode never includes computed CSS. Full mode with verbosity="all" keeps it.
 */
function compactElement(el: any, verbosity: "actionable" | "landmarks" | "all" = "actionable") {
  const base = {
    idx: el.idx,
    tag: el.tag,
    role: el.role,
    label: sanitizeText(el.label, "compact"),
    text: sanitizeText(el.text, "compact"),
    bounds: el.bounds,
    click_center: el.click_center,
    actionable: el.actionable,
  };
  // Only include CSS computed layout when verbosity="all" and not compact output
  if (verbosity === "all") {
    return { ...base, computed: el.computed };
  }
  return base;
}

/**
 * Agent mode element serializer: viewport-scoped, stripped down.
 * Uses agent truncation limit (120). CSS layout never included in agent output.
 */
function agentElement(el: any) {
  return {
    idx: el.idx,
    tag: el.tag,
    role: el.role,
    label: sanitizeText(el.label, "agent"),
    text: sanitizeText(el.text, "agent"),
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

function formatSnapshot(
  snapshot: SpatialMap,
  maxElements: number,
  compact: boolean,
  outputFormat: "compact" | "agent" = "compact",
  verbosity: "actionable" | "landmarks" | "all" = "actionable"
): string {
  if (outputFormat === "agent") {
    return formatAgentSnapshot(snapshot, maxElements);
  }

  const totalElements = snapshot.elements.length;
  const truncated = totalElements > maxElements;
  const elements = truncated ? snapshot.elements.slice(0, maxElements) : snapshot.elements;
  const outputElements = compact
    ? elements.map((el) => compactElement(el, verbosity))
    : elements;

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
  version: "0.3.0",
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

      const json = formatSnapshot(
        lastSnapshot,
        input.max_elements,
        input.compact,
        input.output_format,
        input.verbosity
      );

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
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat, lastSnapshotOptions?.verbosity ?? "actionable") }],
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
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat, lastSnapshotOptions?.verbosity ?? "actionable") }],
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
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot, lastMaxElements, lastCompact, lastOutputFormat, lastSnapshotOptions?.verbosity ?? "actionable") }],
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

// ─── spatial_import_cookies ─────────────────────────────────────

server.tool(
  "spatial_import_cookies",
  `Import cookies into NeoVision's browser session. Use this to warm up the session with cookies from the user's real browser, allowing NeoVision to bypass anti-bot systems (DataDome, Cloudflare, PerimeterX) that block fresh browser profiles.

Workflow: extract cookies from the user's real Chrome (via Claude in Chrome MCP's javascript_tool or CDP), then pass them here before navigating to the target site.

Requires an active session — call spatial_snapshot first to open a page (any page, even about:blank).`,
  ImportCookiesInput.shape,
  async (params) => {
    try {
      const input = ImportCookiesInput.parse(params);
      const count = await session.importCookies(input.cookies);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "ok",
            imported: count,
            domains: [...new Set(input.cookies.map(c => c.domain))],
            message: `Imported ${count} cookies. Navigate to the target site now — the session will include these cookies.`,
          }, null, 2),
        }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error importing cookies: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_export_cookies ─────────────────────────────────────

server.tool(
  "spatial_export_cookies",
  `Export cookies from NeoVision's current browser session. Useful for saving session state or debugging cookie issues. Optionally filter by domain.

Requires an active session — call spatial_snapshot first.`,
  ExportCookiesInput.shape,
  async (params) => {
    try {
      const input = ExportCookiesInput.parse(params);
      const cookies = await session.exportCookies(input.domains);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "ok",
            count: cookies.length,
            cookies,
          }, null, 2),
        }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error exporting cookies: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_connect_cdp ───────────────────────────────────────

server.tool(
  "spatial_connect_cdp",
  `Connect NeoVision to the user's real Chrome browser via Chrome DevTools Protocol (CDP).

This is the most powerful anti-bot bypass: NeoVision drives the user's real Chrome — same cookies, same DataDome/Cloudflare trust scores, same localStorage, same everything.

**Zero setup required.** If Chrome isn't already running with CDP enabled, NeoVision automatically:
  1. Gracefully quits Chrome
  2. Relaunches it with --remote-debugging-port=9222
  3. Chrome restores all tabs automatically
  4. Connects via CDP

The whole process takes ~3 seconds. After connecting, all spatial_snapshot / spatial_click / spatial_type / spatial_scroll calls operate on the user's real Chrome.

Call spatial_disconnect_cdp when done to release the connection (the user's Chrome stays open).`,
  ConnectCDPInput.shape,
  async (params) => {
    try {
      const input = ConnectCDPInput.parse(params);
      const result = await session.connectCDP(input.cdp_url);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "connected",
            cdp_url: input.cdp_url,
            chrome_restarted: result.restarted,
            contexts: result.contexts,
            pages: result.pages,
            active_url: result.url,
            message: (result.restarted
              ? "Chrome was restarted with CDP enabled (all tabs restored). "
              : "Chrome already had CDP enabled — connected directly. ") +
              `Found ${result.pages} open tab(s). ` +
              (result.url ? `Active tab: ${result.url}. ` : "") +
              "All spatial_* tools now operate on the user's real Chrome. " +
              "Call spatial_snapshot with a URL to navigate, or use the current page.",
          }, null, 2),
        }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error connecting to CDP: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_disconnect_cdp ────────────────────────────────────

server.tool(
  "spatial_disconnect_cdp",
  `Disconnect NeoVision from the user's Chrome. The browser stays open — this just releases Playwright's CDP handle. After disconnecting, spatial_snapshot will launch its own stealth Chrome again.`,
  DisconnectCDPInput.shape,
  async () => {
    try {
      const wasCDP = session.isCDPConnected();
      await session.close();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: wasCDP ? "disconnected" : "no_connection",
            message: wasCDP
              ? "Disconnected from Chrome CDP. The user's browser is still running. Next spatial_snapshot will launch NeoVision's own stealth Chrome."
              : "No active CDP connection to disconnect.",
          }, null, 2),
        }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error disconnecting: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_get_injectable ──────────────────────────────────────

server.tool(
  "spatial_get_injectable",
  `Get the NeoVision spatial snapshot as injectable JavaScript — for running in ANY browser context without Playwright.

**Primary use case: Claude in Chrome hybrid mode.**
Inject this script via Claude in Chrome's javascript_tool to get NeoVision's spatial DOM map from the user's real browser session. This combines NeoVision's structured spatial awareness (no screenshots needed, faster navigation) with the user's real Chrome (cookies, DataDome trust, logged-in state).

**Three modes:**
- "script" (default): Returns a single JS expression that defines neoVisionSnapshot() AND immediately invokes it. Paste directly into javascript_tool — returns the SpatialMap JSON.
- "installer": Returns JS that installs neoVisionSnapshot() on window for repeated calls. Inject once, then call neoVisionSnapshot() as many times as needed.
- "source": Returns the raw function source. You define when/how to invoke it.

**Example workflow with Claude in Chrome:**
1. Call spatial_get_injectable (mode: "script", verbosity: "actionable")
2. Send the returned JS to Claude in Chrome's javascript_tool
3. Parse the returned JSON — it's a SpatialMap with elements[], click_center coordinates, roles, labels
4. Use Claude in Chrome's click/type tools with the coordinates from the SpatialMap
5. Re-inject to get an updated map after each action

**Works in:** Claude in Chrome javascript_tool, Chrome extensions, Playwright page.evaluate(), DevTools console, bookmarklets.`,
  {
    mode: z.enum(["script", "installer", "source"]).default("script").describe('What to return: "script" (default) = self-invoking JS that returns the SpatialMap, "installer" = JS that installs neoVisionSnapshot() on window for repeated use, "source" = raw function source only'),
    verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe('Element filter baked into the script: "actionable" (default) = buttons/links/inputs, "landmarks" = + headings/nav/sections, "all" = every visible element'),
    max_depth: z.number().int().min(1).max(200).default(50).describe("Max DOM depth to traverse (default: 50)"),
    include_non_visible: z.boolean().default(false).describe("Include hidden elements (default: false)"),
  },
  async (args) => {
    const mode = args.mode || "script";
    const opts = {
      maxDepth: args.max_depth || 50,
      includeNonVisible: args.include_non_visible || false,
      verbosity: (args.verbosity as "actionable" | "landmarks" | "all") || "actionable",
    };

    let js: string;
    let description: string;

    if (mode === "installer") {
      js = getInjectableInstaller();
      description = "Installer script — inject once, then call neoVisionSnapshot() repeatedly. After injecting, use: neoVisionSnapshot() or neoVisionSnapshot({ verbosity: 'all' })";
    } else if (mode === "source") {
      js = INJECTABLE_SOURCE;
      description = "Raw function source. Define neoVisionSnapshot yourself, then call it with options.";
    } else {
      js = getInjectableScript(opts);
      description = `Self-invoking script with options: ${JSON.stringify(opts)}. Paste directly into javascript_tool — returns the SpatialMap JSON.`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            mode,
            description,
            script_length: js.length,
            usage_hint: mode === "script"
              ? "Send this entire script to Claude in Chrome's javascript_tool. The return value is the SpatialMap JSON with elements[].click_center coordinates."
              : mode === "installer"
              ? "Send this script to javascript_tool once. Then call neoVisionSnapshot() in subsequent javascript_tool calls."
              : "Include this source in your own wrapper. Call neoVisionSnapshot(opts) after defining it.",
          }, null, 2),
        },
        {
          type: "text" as const,
          text: js,
        },
      ],
    };
  }
);

// ─── spatial_pace ───────────────────────────────────────────────

let activePacer: PacingEngine | null = null;

server.tool(
  "spatial_pace",
  `Manage human-like pacing for multi-page scraping sessions.

Anti-bot systems like DataDome don't just look at speed — they look at PATTERNS. A human doesn't visit pages in a perfectly timed loop. This tool adds natural variance: randomized delays, periodic breaks, reading pauses, and automatic slowdown when CAPTCHAs are detected.

**Workflow:**
1. Call with action "start" before beginning a scraping session. Configure batch size, delay range, etc.
2. Call with action "next" before EACH page navigation. It returns how long to wait (use Claude in Chrome's wait tool) and whether to take a break.
3. After extracting data from a page, call with action "record_success".
4. If you hit a CAPTCHA, call with action "record_captcha". The pacer slows down automatically. If the user solves it manually, call "record_captcha_solved".
5. Call with action "status" anytime to check session stats.
6. Call with action "estimate" to see how long remaining pages will take.
7. Call with action "end" when done.

**Example hybrid scraping loop:**
\`\`\`
spatial_pace(action: "start", batch_size: 10, min_delay: 3000, max_delay: 12000)
for each URL:
  instruction = spatial_pace(action: "next")
  wait(instruction.delay)  // via Claude in Chrome wait tool
  if instruction.action == "break": wait(instruction.breakDuration)
  navigate to URL
  inject CAPTCHA detector → if CAPTCHA: spatial_pace(action: "record_captcha"), alert user
  inject spatial snapshot / extract LD+JSON
  spatial_pace(action: "record_success")
spatial_pace(action: "end")
\`\`\`

The pacer also provides a CAPTCHA detection script (action: "get_captcha_detector") — inject it after each navigation to check if the page is a CAPTCHA/block page instead of real content.`,
  {
    action: z.enum(["start", "next", "record_success", "record_captcha", "record_captcha_solved", "status", "estimate", "get_captcha_detector", "end"])
      .describe('Action: "start" = begin session, "next" = get delay for next page, "record_success" = mark page as scraped, "record_captcha" = hit a CAPTCHA, "record_captcha_solved" = user solved CAPTCHA, "status" = session stats, "estimate" = estimate time remaining, "get_captcha_detector" = get CAPTCHA detection JS, "end" = finish session'),
    batch_size: z.number().int().min(1).max(100).optional()
      .describe("Pages per batch before a longer break (default: 10). Only used with action: start"),
    min_delay: z.number().int().min(500).max(60000).optional()
      .describe("Minimum delay between pages in ms (default: 3000). Only used with action: start"),
    max_delay: z.number().int().min(1000).max(120000).optional()
      .describe("Maximum delay between pages in ms (default: 12000). Only used with action: start"),
    min_break: z.number().int().min(10000).max(600000).optional()
      .describe("Minimum break between batches in ms (default: 60000 = 1 min). Only used with action: start"),
    max_break: z.number().int().min(30000).max(1200000).optional()
      .describe("Maximum break between batches in ms (default: 180000 = 3 min). Only used with action: start"),
    remaining_pages: z.number().int().min(0).optional()
      .describe("Number of pages left to scrape. Only used with action: estimate"),
  },
  async (args) => {
    const { action } = args;

    if (action === "start") {
      activePacer = new PacingEngine({
        batchSize: args.batch_size,
        minDelay: args.min_delay,
        maxDelay: args.max_delay,
        minBreak: args.min_break,
        maxBreak: args.max_break,
      });
      const estimate = activePacer.estimateTime(args.remaining_pages || 0);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "session_started",
            config: {
              batch_size: args.batch_size || 10,
              min_delay: `${(args.min_delay || 3000) / 1000}s`,
              max_delay: `${(args.max_delay || 12000) / 1000}s`,
              min_break: `${(args.min_break || 60000) / 1000}s`,
              max_break: `${(args.max_break || 180000) / 1000}s`,
            },
            estimate: args.remaining_pages ? {
              remaining_pages: args.remaining_pages,
              estimated_time: estimate.totalHuman,
              batches: estimate.batches,
              breaks: estimate.breaks,
            } : undefined,
            next_step: 'Call spatial_pace(action: "next") before each page navigation.',
          }, null, 2),
        }],
      };
    }

    if (!activePacer) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "no_active_session",
            message: 'No pacing session active. Call spatial_pace(action: "start") first.',
          }, null, 2),
        }],
        isError: true,
      };
    }

    if (action === "next") {
      const instruction = activePacer.next();
      const delaySeconds = Math.round(instruction.delay / 1000);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: instruction.action,
            wait_seconds: delaySeconds,
            wait_human: instruction.delayHuman,
            ...(instruction.action === "break" ? {
              break_seconds: Math.round(instruction.breakDuration! / 1000),
              break_human: instruction.breakHuman,
              total_wait_human: `${instruction.breakHuman} break + ${instruction.delayHuman} delay`,
            } : {}),
            ...(instruction.action === "stop" ? {
              stop_reason: instruction.reason,
            } : {}),
            page: instruction.pageNumber,
            batch: `${instruction.batchPage}/${instruction.batchNumber > 1 ? instruction.batchNumber + " (batch " + instruction.batchNumber + ")" : instruction.pagesUntilBreak + instruction.batchPage + " in batch"}`,
            pages_until_break: instruction.pagesUntilBreak,
            has_reading_pause: instruction.hasReadingPause,
            reason: instruction.reason,
            instruction: instruction.action === "stop"
              ? "STOP — too many CAPTCHAs. Wait 10+ minutes or solve manually."
              : instruction.action === "break"
              ? `Wait ${instruction.breakHuman} (batch break), then ${instruction.delayHuman} before navigating.`
              : `Wait ${instruction.delayHuman} before navigating.`,
          }, null, 2),
        }],
      };
    }

    if (action === "record_success") {
      activePacer.recordSuccess();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "recorded",
            stats: activePacer.getStats(),
          }, null, 2),
        }],
      };
    }

    if (action === "record_captcha") {
      activePacer.recordCaptcha();
      const stats = activePacer.getStats();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "captcha_recorded",
            warning: stats.consecutiveCaptchas >= 2
              ? "CRITICAL: Multiple consecutive CAPTCHAs. The site is actively blocking. Stop and wait, or ask the user to solve the CAPTCHA."
              : "CAPTCHA detected. Pacing slowed down automatically. If the user solves it, call record_captcha_solved.",
            slowdown_factor: stats.currentSlowdownFactor,
            consecutive_captchas: stats.consecutiveCaptchas,
            stats,
          }, null, 2),
        }],
      };
    }

    if (action === "record_captcha_solved") {
      activePacer.recordCaptchaSolved();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "captcha_solved",
            message: "CAPTCHA counter reset. Pacing still elevated but will gradually normalize.",
            stats: activePacer.getStats(),
          }, null, 2),
        }],
      };
    }

    if (action === "status") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "active",
            stats: activePacer.getStats(),
            last_instruction: activePacer.getLastInstruction(),
          }, null, 2),
        }],
      };
    }

    if (action === "estimate") {
      const remaining = args.remaining_pages || 0;
      const estimate = activePacer.estimateTime(remaining);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            remaining_pages: remaining,
            estimated_time: estimate.totalHuman,
            estimated_ms: estimate.totalMs,
            batches_remaining: estimate.batches,
            breaks_remaining: estimate.breaks,
            stats: activePacer.getStats(),
          }, null, 2),
        }],
      };
    }

    if (action === "get_captcha_detector") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            description: "Inject this JS after each navigation to check if the page is a CAPTCHA/block page. Returns JSON with is_captcha boolean and signal details.",
            usage: "Send to Claude in Chrome's javascript_tool. Parse the returned JSON. If is_captcha is true, call spatial_pace(action: 'record_captcha').",
          }, null, 2),
        }, {
          type: "text" as const,
          text: getCaptchaDetector(),
        }],
      };
    }

    if (action === "end") {
      const stats = activePacer.getStats();
      activePacer = null;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "session_ended",
            summary: stats,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
      isError: true,
    };
  }
);

// ─── Chrome Bridge (Extension-based browser control) ─────────────

const bridge = new ChromeBridge({ port: 7665 });

server.tool(
  "bridge_status",
  `Check if the NeoVision Chrome extension is connected.

Returns connection status. If not connected, the user needs to:
1. Load the NeoVision Bridge extension in Chrome (chrome://extensions → Load unpacked → select the extension/ folder)
2. Click the extension icon and hit "Connect"
3. The extension connects to this MCP server's WebSocket on port 7665`,
  {},
  async () => {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          connected: bridge.ready,
          port: 7665,
          message: bridge.ready
            ? "Chrome extension is connected. You can use bridge_navigate, bridge_execute_js, bridge_inject_spatial, bridge_click, bridge_type, bridge_screenshot."
            : "Chrome extension is NOT connected. Install the NeoVision Bridge extension and click Connect.",
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "bridge_navigate",
  `Navigate the real Chrome browser to a URL via the NeoVision extension.

This navigates the user's actual Chrome — with real cookies, real sessions, no CAPTCHAs.
Waits for page load before returning.`,
  {
    url: z.string().describe("URL to navigate to"),
  },
  async (args) => {
    try {
      const result = await bridge.navigate(args.url);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_execute_js",
  `Execute JavaScript in the page context of the real Chrome browser via the NeoVision extension.

Runs arbitrary JS in the MAIN world — full access to page DOM, variables, and APIs.
Returns the result of the expression.

Use this for:
- Extracting data (LD+JSON, meta tags, page content)
- CAPTCHA detection
- Any DOM queries or manipulations`,
  {
    code: z.string().describe("JavaScript code to execute. The last expression's value is returned."),
    tab_id: z.number().optional().describe("Target tab ID (optional — defaults to the managed tab)"),
  },
  async (args) => {
    try {
      const result = await bridge.executeJs(args.code, args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_inject_spatial",
  `Inject the NeoVision spatial snapshot into the real Chrome browser via the extension.

This is the hybrid mode killer feature — get NeoVision's structured spatial DOM map from the user's real Chrome session. Returns a SpatialMap with elements, coordinates, roles, labels, and actionability flags.

After getting the map, use bridge_click with the click_center coordinates from elements to interact.`,
  {
    verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe('Element filter: "actionable" = buttons/links/inputs, "landmarks" = + headings, "all" = everything'),
    max_depth: z.number().int().min(1).max(200).default(50).describe("Max DOM depth"),
    include_non_visible: z.boolean().default(false).describe("Include hidden elements"),
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.injectSpatial({
        verbosity: args.verbosity,
        maxDepth: args.max_depth,
        includeNonVisible: args.include_non_visible,
      }, args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_click",
  `Click at pixel coordinates in the real Chrome browser via the NeoVision extension.

Use click_center coordinates from bridge_inject_spatial results to click elements.`,
  {
    x: z.number().describe("X coordinate (pixels from left)"),
    y: z.number().describe("Y coordinate (pixels from top)"),
    button: z.enum(["left", "right"]).default("left").describe("Mouse button"),
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.click(args.x, args.y, args.button, args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_type",
  `Type text into an element at pixel coordinates in the real Chrome browser.

Clicks the element to focus it first, then types the text.`,
  {
    x: z.number().describe("X coordinate of the input element"),
    y: z.number().describe("Y coordinate of the input element"),
    text: z.string().describe("Text to type"),
    clear_first: z.boolean().default(false).describe("Clear the field before typing"),
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.type(args.x, args.y, args.text, args.clear_first, args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_scroll",
  `Scroll the page in the real Chrome browser.`,
  {
    delta_y: z.number().describe("Vertical scroll amount in pixels (positive = down, negative = up)"),
    delta_x: z.number().default(0).describe("Horizontal scroll amount"),
    x: z.number().default(640).describe("X coordinate to scroll at"),
    y: z.number().default(360).describe("Y coordinate to scroll at"),
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.scroll(args.delta_x, args.delta_y, args.x, args.y, args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_wait",
  `Wait for a specified duration. Use for pacing between page navigations.`,
  {
    seconds: z.number().min(0.1).max(300).describe("Seconds to wait"),
  },
  async (args) => {
    try {
      const result = await bridge.wait(args.seconds);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_screenshot",
  `Take a screenshot of the current page in the real Chrome browser.
Returns a base64-encoded PNG data URL.`,
  {
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.screenshot(args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: result.success,
            format: result.format,
            encoding: result.encoding,
            data_length: result.screenshot?.length || 0,
          }, null, 2),
        },
        // Include the actual screenshot data
        ...(result.screenshot ? [{
          type: "image" as const,
          data: result.screenshot.replace(/^data:image\/png;base64,/, ""),
          mimeType: "image/png" as const,
        }] : []),
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_get_page_info",
  `Get info about the current page in the real Chrome browser (URL, title, tab ID).`,
  {
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.getPageInfo(args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "bridge_get_page_text",
  `Extract the text content from the current page in the real Chrome browser.
Prioritizes article/main content. Returns up to 50KB of text.`,
  {
    tab_id: z.number().optional().describe("Target tab ID (optional)"),
  },
  async (args) => {
    try {
      const result = await bridge.getPageText(args.tab_id);
      return {
        content: [{
          type: "text" as const,
          text: result.text || "(empty page)",
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Bridge error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────

async function main() {
  // --setup: run the interactive setup script
  if (process.argv.includes("--setup")) {
    const { execSync } = await import("child_process");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const setupScript = join(__dirname, "..", "setup.sh");
    try {
      execSync(`bash "${setupScript}"`, { stdio: "inherit" });
    } catch {
      console.error("Setup script not found. Run from the neo-vision package directory or download it from:");
      console.error("  https://github.com/matthewalexong/neo-vision/blob/main/setup.sh");
    }
    process.exit(0);
  }

  // Check if --bridge flag is set (or NEOVISION_BRIDGE env var)
  const enableBridge = process.argv.includes("--bridge") || process.env.NEOVISION_BRIDGE === "1";

  if (enableBridge) {
    try {
      await bridge.start();
      console.error("NeoVision Bridge WebSocket server started on port 7665");
    } catch (err) {
      console.error("Warning: Could not start bridge server:", err);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NeoVision MCP server running on stdio" + (enableBridge ? " (bridge mode enabled)" : ""));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await bridge.stop();
  await session.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.stop();
  await session.close();
  process.exit(0);
});
