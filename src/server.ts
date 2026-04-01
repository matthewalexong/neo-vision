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
let lastMaxElements: number = 500;

// ─── Helper: truncate snapshot to fit context windows ────────────

function truncateSnapshot(snapshot: SpatialMap, maxElements: number): { json: string; truncated: boolean; totalElements: number } {
  const totalElements = snapshot.elements.length;
  const truncated = totalElements > maxElements;

  if (truncated) {
    const truncatedSnapshot = {
      ...snapshot,
      elements: snapshot.elements.slice(0, maxElements),
      stats: {
        ...snapshot.stats,
        total_elements: totalElements,
      },
      _truncated: {
        showing: maxElements,
        total: totalElements,
        message: `Showing ${maxElements} of ${totalElements} elements. Scroll down and re-snapshot to see more, or use spatial_query to filter the full cached map.`,
      },
    };
    return { json: JSON.stringify(truncatedSnapshot, null, 2), truncated, totalElements };
  }

  return { json: JSON.stringify(snapshot, null, 2), truncated, totalElements };
}

const NEO_VISION_DESCRIPTION = [
  "See the web the way Neo sees the Matrix.",
  "Launches a real Chrome browser automatically — no setup, no CDP, no manual browser management.",
  "",
  "WORKFLOW: spatial_snapshot (open URL) → spatial_click / spatial_type / spatial_scroll (interact) → spatial_query (filter cached map).",
  "Every action tool returns an updated spatial map automatically. Use element.click_center coordinates to target elements.",
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

Returns a JSON object with every visible element's pixel coordinates, ARIA roles, accessible labels, and actionability flags. Use the click_center coordinates from the response to target elements with spatial_click or spatial_type.

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

      const { json } = truncateSnapshot(lastSnapshot, input.max_elements);

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

      const { json } = truncateSnapshot(lastSnapshot, lastMaxElements);
      return {
        content: [{ type: "text" as const, text: json }],
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

      const { json } = truncateSnapshot(lastSnapshot, lastMaxElements);
      return {
        content: [{ type: "text" as const, text: json }],
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

      const { json } = truncateSnapshot(lastSnapshot, lastMaxElements);
      return {
        content: [{ type: "text" as const, text: json }],
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
