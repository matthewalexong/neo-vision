#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PublicSnapshotInput, ClickInput, TypeInput, ScrollInput, QueryInput } from "./schema.js";
import type { SpatialMap } from "./schema.js";
import { queryMap } from "./query.js";
import { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller } from "./injectable.js";
import { PacingEngine, getCaptchaDetector } from "./pacing.js";
import { ChromeBridge } from "./bridge.js";

// ─── State Management ────────────────────────────────────────────────

let lastSnapshot: SpatialMap | null = null;
let lastMaxElements: number = 2000;
let lastCompact: boolean = true;
let lastOutputFormat: "compact" | "agent" | "summary" = "compact";
let lastVerbosity: "actionable" | "landmarks" | "all" = "actionable";

// ─── Helper: compact + truncate snapshot to fit context windows ──

const JS_CODE_RE = /^(window\.|var |const |let |function |typeof |if \(|== new |document\.|console\.)/i;
const NOISE_TEXT_RE = /^[\s\p{P}]*$/u;

type TextMode = "compact" | "agent" | "full";

function sanitizeText(t: string | null, mode: TextMode = "full"): string | null {
  if (!t || typeof t !== "string") return null;
  if (JS_CODE_RE.test(t)) return null;
  t = t.replace(/\s+/g, " ").trim();
  if (NOISE_TEXT_RE.test(t)) return null;
  const limits: Record<TextMode, number> = { compact: 80, agent: 120, full: 100 };
  const limit = limits[mode];
  if (t.length > limit) t = t.slice(0, limit) + "\u2026";
  return t || null;
}

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
  if (verbosity === "all") {
    return { ...base, computed: el.computed };
  }
  return base;
}

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

function formatAgentSnapshot(snapshot: SpatialMap, maxElements: number): string {
  const { width: vw, height: vh } = snapshot.viewport;
  const { x: sx, y: sy } = snapshot.scroll;
  const pageH = snapshot.page_bounds.height;

  const pageW = snapshot.page_bounds.width;
  const effectiveVw = Math.min(vw, pageW);
  const effectiveVh = Math.min(vh, pageH);
  const vX1 = sx, vY1 = sy;
  const vX2 = sx + effectiveVw, vY2 = sy + effectiveVh;
  const scrollBottom = sy + vh;
  const pctSeen = pageH > 0 ? Math.min(100, Math.round((scrollBottom / pageH) * 100)) : 0;
  const pctRemaining = 100 - pctSeen;

  function inViewport(el: any): boolean {
    if (el.click_center) {
      const cx = el.click_center.x, cy = el.click_center.y;
      return cx >= vX1 && cx < vX2 && cy >= vY1 && cy < vY2;
    }
    const cX = el.bounds.x + el.bounds.width / 2;
    const cY = el.bounds.y + el.bounds.height / 2;
    return cX >= vX1 && cX < vX2 && cY >= vY1 && cY < vY2;
  }

  const viewportTextCandidates = snapshot.elements.filter(
    (el): el is typeof el & { text: string } =>
      inViewport(el) && el.text != null && el.text.trim().length > 0
  );

  const candidates: { key: string; text: string }[] = [];
  for (const el of viewportTextCandidates) {
    const t = el.text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const gx = Math.round(el.bounds.x / 10) * 10;
    const gy = Math.round(el.bounds.y / 10) * 10;
    candidates.push({ key: `${gx},${gy}`, text: t.length > 120 ? t.slice(0, 120) + "\u2026" : t });
  }

  const byGrid = new Map<string, string>();
  const orderedTexts: string[] = [];
  for (const c of candidates) {
    const cur = byGrid.get(c.key);
    const isEllipsed = (s: string) => s.endsWith("\u2026");
    if (!cur || c.text.length > cur.length || (c.text.length === cur.length && !isEllipsed(c.text) && isEllipsed(cur))) {
      byGrid.set(c.key, c.text);
    }
  }

  const sorted = [...byGrid.values()].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const t of sorted) {
    let isDuplicate = false;
    for (const k of kept) {
      const needle = t.endsWith("\u2026") ? t.slice(0, -1) : t;
      const haystack = k.endsWith("\u2026") ? k.slice(0, -1) : k;
      if (needle.length > 3 && haystack.includes(needle)) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) kept.push(t);
  }

  const gridToText = new Map<string, string>();
  for (const [key, text] of byGrid) {
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
  outputFormat: "compact" | "agent" | "summary" = "compact",
  verbosity: "actionable" | "landmarks" | "all" = "actionable"
): string {
  if (outputFormat === "agent") {
    return formatAgentSnapshot(snapshot, maxElements);
  }

  if (outputFormat === "summary") {
    const { width: vw, height: vh } = snapshot.viewport;
    const { x: sx, y: sy } = snapshot.scroll;
    const pageH = snapshot.page_bounds.height;

    const pageW = snapshot.page_bounds.width;
    const effectiveVw = Math.min(vw, pageW);
    const effectiveVh = Math.min(vh, pageH);
    const vX1 = sx, vY1 = sy;
    const vX2 = sx + effectiveVw, vY2 = sy + effectiveVh;

    function inViewport(el: any): boolean {
      if (el.click_center) {
        const cx = el.click_center.x, cy = el.click_center.y;
        return cx >= vX1 && cx < vX2 && cy >= vY1 && cy < vY2;
      }
      const cX = el.bounds.x + el.bounds.width / 2;
      const cY = el.bounds.y + el.bounds.height / 2;
      return cX >= vX1 && cX < vX2 && cY >= vY1 && cY < vY2;
    }

    // Extract title: prefer <title>, then h1, then URL
    let title = snapshot.url;
    for (const el of snapshot.elements) {
      if (el.tag === "title" && el.text) { title = el.text; break; }
    }
    if (title === snapshot.url) {
      for (const el of snapshot.elements) {
        if (el.role === "heading" && el.tag === "h1" && el.text) { title = el.text; break; }
      }
    }

    // Headings: first 15 elements with role containing "heading"
    const headings = snapshot.elements
      .filter((el) => el.role && el.role.toLowerCase().includes("heading"))
      .slice(0, 15)
      .map((el) => ({
        idx: el.idx,
        tag: el.tag,
        role: el.role,
        label: el.label,
        text: el.text,
        click_center: el.click_center,
      }));

    // Top interactive: first 15 actionable elements in viewport
    const topInteractive = snapshot.elements
      .filter((el) => el.actionable && el.click_center && inViewport(el))
      .slice(0, 15)
      .map((el) => ({
        idx: el.idx,
        tag: el.tag,
        role: el.role,
        label: el.label,
        text: el.text,
        click_center: el.click_center,
      }));

    return JSON.stringify({
      url: snapshot.url,
      title,
      timestamp: snapshot.timestamp,
      viewport: snapshot.viewport,
      scroll: snapshot.scroll,
      page_bounds: snapshot.page_bounds,
      stats: {
        total_elements: snapshot.stats.total_elements,
        actionable_elements: snapshot.stats.actionable_elements,
        focusable_elements: snapshot.stats.focusable_elements,
      },
      landmarks: headings,
      top_interactive: topInteractive,
      hint: "Full snapshot cached in server memory. Use spatial_query to search by role, tag, text, or region.",
    }, null, 2);
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
  "AI agent browser navigation through a Chrome extension bridge. Real Chrome browser, spatial DOM maps, pixel-precise coordinates.",
  "",
  "WORKFLOW: spatial_snapshot (open URL) → spatial_click / spatial_type / spatial_scroll (interact) → spatial_query (filter cached map).",
  "Every action tool returns an updated spatial map automatically. Use element.click_center coordinates to target elements.",
  "",
  "OUTPUT FORMATS: Two modes controlled by the output_format parameter:",
  "  - 'compact' (default): Full element list with coordinates, roles, labels, text, and actionability flags.",
  "  - 'agent': Optimized for AI agent context windows. Returns deduplicated readable page text + interactive elements.",
].join(" ");

const server = new McpServer({
  name: "neo-vision",
  version: "0.3.0",
  description: NEO_VISION_DESCRIPTION,
});

// ─── Bridge (Chrome Extension) ──────────────────────────────────────

const bridge = new ChromeBridge({ port: 7665 });

// ─── spatial_snapshot ────────────────────────────────────────────

server.tool(
  "spatial_snapshot",
  `Navigate to a URL and return a spatial map of the page via the Chrome extension bridge.

**Output modes** (controlled by output_format parameter):
  - 'compact' (default): Returns every visible element with pixel coordinates, ARIA roles, accessible labels, and actionability flags.
  - 'agent': Optimized for AI agent context windows. Returns deduplicated readable page text + only interactive/viewport-scoped elements.
  - 'summary': Stores full map in server memory, returns only a lightweight receipt with page title, stats, key landmarks (headings), and top 15 interactive elements. Best for context-window efficiency — use spatial_query to drill into the cached data by role, tag, text, or region.

The browser session persists across calls. Calling this again with a different URL navigates to that URL.
The full DOM map is always cached server-side regardless of output format. Use spatial_query to search the cached map without re-snapshotting.`,
  PublicSnapshotInput.shape,
  async (params) => {
    try {
      const input = PublicSnapshotInput.parse(params);

      if (input.url) {
        await bridge.navigate(input.url);
        await bridge.wait(input.settle_ms / 1000);
      }

      const result = await bridge.injectSpatial({
        verbosity: input.verbosity,
        maxDepth: input.max_depth,
        includeNonVisible: input.include_non_visible,
      });

      lastSnapshot = result as any;
      lastMaxElements = input.max_elements;
      lastCompact = input.compact;
      lastOutputFormat = input.output_format;
      lastVerbosity = input.verbosity;

      const json = formatSnapshot(
        lastSnapshot as SpatialMap,
        input.max_elements,
        input.compact,
        input.output_format,
        input.verbosity
      );

      return {
        content: [{ type: "text" as const, text: json }],
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

Returns an updated spatial map reflecting the page state after the click.`,
  ClickInput.shape,
  async (params) => {
    try {
      const input = ClickInput.parse(params);

      if (!lastSnapshot) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      await bridge.click(input.x, input.y, input.button, undefined);

      const result = await bridge.injectSpatial({
        verbosity: lastVerbosity,
        maxDepth: 50,
        includeNonVisible: false,
      });

      lastSnapshot = result as any;

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot as SpatialMap, lastMaxElements, lastCompact, lastOutputFormat, lastVerbosity) }],
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

Set clear_first=true to replace existing text. Set press_enter=true to submit after typing.

Returns an updated spatial map.`,
  TypeInput.shape,
  async (params) => {
    try {
      const input = TypeInput.parse(params);

      if (!lastSnapshot) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      const x = input.x ?? 0;
      const y = input.y ?? 0;
      await bridge.type(x, y, input.text, input.clear_first, undefined);

      if (input.press_enter) {
        await bridge.executeJs("document.activeElement?.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter'})); true;");
      }

      const result = await bridge.injectSpatial({
        verbosity: lastVerbosity,
        maxDepth: 50,
        includeNonVisible: false,
      });

      lastSnapshot = result as any;

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot as SpatialMap, lastMaxElements, lastCompact, lastOutputFormat, lastVerbosity) }],
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
  `Scroll the page or a specific scrollable container. Use delta_y with positive values to scroll down, negative to scroll up.

Returns an updated spatial map reflecting the new scroll position.`,
  ScrollInput.shape,
  async (params) => {
    try {
      const input = ScrollInput.parse(params);

      if (!lastSnapshot) {
        return {
          content: [{ type: "text" as const, text: "Error: No snapshot taken yet. Call spatial_snapshot first." }],
          isError: true,
        };
      }

      const x = input.x ?? 640;
      const y = input.y ?? 360;
      await bridge.scroll(input.delta_x, input.delta_y, x, y, undefined);

      const result = await bridge.injectSpatial({
        verbosity: lastVerbosity,
        maxDepth: 50,
        includeNonVisible: false,
      });

      lastSnapshot = result as any;

      return {
        content: [{ type: "text" as const, text: formatSnapshot(lastSnapshot as SpatialMap, lastMaxElements, lastCompact, lastOutputFormat, lastVerbosity) }],
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
  `Filter the current spatial map without re-loading the page. Search for elements by ARIA role, HTML tag, label text, bounding box region, or actionability.

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
        textContains: input.text_contains,
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

// ─── spatial_get_injectable ──────────────────────────────────────

server.tool(
  "spatial_get_injectable",
  `Get the NeoVision spatial snapshot as injectable JavaScript — for running in ANY browser context.

**Primary use case: Claude in Chrome hybrid mode.**
Inject this script via Claude in Chrome's javascript_tool to get NeoVision's spatial DOM map from the user's real browser session.`,
  {
    mode: z.enum(["script", "installer", "source"]).default("script").describe('What to return: "script" (default) = self-invoking JS, "installer" = installs neoVisionSnapshot() on window, "source" = raw function source'),
    verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe('Element filter: "actionable" (default), "landmarks", "all"'),
    max_depth: z.number().int().min(1).max(200).default(50).describe("Max DOM depth to traverse"),
    include_non_visible: z.boolean().default(false).describe("Include hidden elements"),
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
      description = "Installer script — inject once, then call neoVisionSnapshot() repeatedly.";
    } else if (mode === "source") {
      js = INJECTABLE_SOURCE;
      description = "Raw function source. Define neoVisionSnapshot yourself, then call it with options.";
    } else {
      js = getInjectableScript(opts);
      description = `Self-invoking script with options: ${JSON.stringify(opts)}.`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            mode,
            description,
            script_length: js.length,
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

Anti-bot systems like DataDome don't just look at speed — they look at PATTERNS. This tool adds natural variance: randomized delays, periodic breaks, and automatic slowdown when CAPTCHAs are detected.`,
  {
    action: z.enum(["start", "next", "record_success", "record_captcha", "record_captcha_solved", "status", "estimate", "get_captcha_detector", "end"])
      .describe('Action: "start", "next", "record_success", "record_captcha", "record_captcha_solved", "status", "estimate", "get_captcha_detector", "end"'),
    batch_size: z.number().int().min(1).max(100).optional().describe("Pages per batch before a break (default: 10)"),
    min_delay: z.number().int().min(500).max(60000).optional().describe("Minimum delay between pages in ms (default: 3000)"),
    max_delay: z.number().int().min(1000).max(120000).optional().describe("Maximum delay between pages in ms (default: 12000)"),
    min_break: z.number().int().min(10000).max(600000).optional().describe("Minimum break between batches in ms (default: 60000)"),
    max_break: z.number().int().min(30000).max(1200000).optional().describe("Maximum break between batches in ms (default: 180000)"),
    remaining_pages: z.number().int().min(0).optional().describe("Number of pages left to scrape"),
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
            estimate: args.remaining_pages ? { remaining_pages: args.remaining_pages, estimated_time: estimate.totalHuman } : undefined,
          }, null, 2),
        }],
      };
    }

    if (!activePacer) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "no_active_session", message: 'No pacing session active. Call spatial_pace(action: "start") first.' }, null, 2),
        }],
        isError: true,
      };
    }

    if (action === "next") {
      const instruction = activePacer.next();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            action: instruction.action,
            wait_seconds: Math.round(instruction.delay / 1000),
          }, null, 2),
        }],
      };
    }

    if (action === "record_success") {
      activePacer.recordSuccess();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "recorded" }, null, 2) }],
      };
    }

    if (action === "record_captcha") {
      activePacer.recordCaptcha();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "captcha_recorded" }, null, 2) }],
      };
    }

    if (action === "record_captcha_solved") {
      activePacer.recordCaptchaSolved();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "captcha_solved" }, null, 2) }],
      };
    }

    if (action === "status") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "active", stats: activePacer.getStats() }, null, 2) }],
      };
    }

    if (action === "estimate") {
      const remaining = args.remaining_pages || 0;
      const estimate = activePacer.estimateTime(remaining);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ estimated_time: estimate.totalHuman }, null, 2) }],
      };
    }

    if (action === "get_captcha_detector") {
      const detector = getCaptchaDetector();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            description: "CAPTCHA detector script for use with spatial_execute_js.",
            script_length: detector.length,
          }, null, 2),
        }, {
          type: "text" as const,
          text: detector,
        }],
      };
    }

    if (action === "end") {
      const stats = activePacer.getStats();
      activePacer = null;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "session_ended", summary: stats }, null, 2) }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
      isError: true,
    };
  }
);

// ─── spatial_screenshot ──────────────────────────────────────────

server.tool(
  "spatial_screenshot",
  `Take a screenshot of the current page in the real Chrome browser.

Returns a base64-encoded PNG data URL.`,
  {},
  async () => {
    try {
      const result = await bridge.screenshot();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error taking screenshot: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_navigate ────────────────────────────────────────────

server.tool(
  "spatial_navigate",
  `Navigate to a URL without taking a snapshot. Lighter weight than spatial_snapshot.`,
  {
    url: z.string().url().describe("URL to navigate to"),
  },
  async (params) => {
    try {
      const input = z.object({ url: z.string().url() }).parse(params);
      const result = await bridge.navigate(input.url);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error navigating: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_wait ────────────────────────────────────────────────

server.tool(
  "spatial_wait",
  `Wait for a specified duration.`,
  {
    seconds: z.number().min(0.1).max(300).describe("Seconds to wait"),
  },
  async (params) => {
    try {
      const input = z.object({ seconds: z.number() }).parse(params);
      await bridge.wait(input.seconds);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ waited: input.seconds }, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error waiting: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── spatial_execute_js ──────────────────────────────────────────

server.tool(
  "spatial_execute_js",
  `Execute JavaScript in the page context of the real Chrome browser via the extension.

Runs arbitrary JS in the MAIN world — full access to page DOM, variables, and APIs.
Returns the result of the expression.`,
  {
    code: z.string().describe("JavaScript code to execute. The last expression's value is returned."),
  },
  async (params) => {
    try {
      const input = z.object({ code: z.string() }).parse(params);
      const result = await bridge.executeJs(input.code);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ result }, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error executing JS: ${msg}` }],
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
      console.error("Setup script not found. Run from the neo-vision package directory.");
    }
    process.exit(0);
  }

  // Start bridge server
  try {
    await bridge.start();
    console.error("NeoVision Bridge WebSocket server started on port 7665");
  } catch (err) {
    console.error("Warning: Could not start bridge server:", err);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NeoVision MCP server running on stdio (bridge mode enabled)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.stop();
  process.exit(0);
});
