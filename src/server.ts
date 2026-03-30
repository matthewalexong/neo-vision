#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager, type SessionConfig } from "./session.js";
import { takeSnapshot, navigateWithFallback, type SnapshotOptions } from "./snapshot.js";
import { click, type as typeAction, scroll } from "./actions.js";
import { queryMap } from "./query.js";
import { SnapshotInput, ClickInput, TypeInput, ScrollInput, QueryInput } from "./schema.js";
import type { SpatialMap } from "./schema.js";

const session = new SessionManager();
let lastSnapshot: SpatialMap | null = null;
let lastSnapshotOptions: SnapshotOptions | null = null;
let lastSessionConfig: SessionConfig | null = null;

const server = new McpServer({
  name: "neo-vision",
  version: "0.1.0",
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
  "Take a deterministic spatial snapshot of a web page. Returns a JSON map of all visible elements with pixel coordinates, ARIA roles, accessible labels, and actionability flags. Use this to understand what's on the page and where everything is.",
  SnapshotInput.shape,
  async (params) => {
    try {
      const input = SnapshotInput.parse(params);

      const config: SessionConfig = {
        browserMode: input.browser_mode,
        viewportWidth: input.viewport_width,
        viewportHeight: input.viewport_height,
        zoom: input.zoom,
        cdpUrl: input.cdp_url,
        chromePath: input.chrome_path,
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(lastSnapshot, null, 2),
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
  "Click an element at the given coordinates. Use click_center coordinates from a spatial_snapshot result. Returns an updated spatial map after the click settles.",
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
        content: [{ type: "text" as const, text: JSON.stringify(lastSnapshot, null, 2) }],
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
  "Type text into the focused element or at a given coordinate. Optionally clear existing text first and/or press Enter after. Returns an updated spatial map.",
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
        content: [{ type: "text" as const, text: JSON.stringify(lastSnapshot, null, 2) }],
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
  "Scroll the page or a scrollable container. Returns an updated spatial map reflecting the new scroll position.",
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
        content: [{ type: "text" as const, text: JSON.stringify(lastSnapshot, null, 2) }],
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
  "Filter the current spatial map without re-snapshotting. Find elements by ARIA role, HTML tag, label text, or bounding box region. Much faster than taking a new snapshot.",
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
