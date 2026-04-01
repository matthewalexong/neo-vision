import { z } from "zod";

// ─── Browser Modes ───────────────────────────────────────────────

export const BrowserMode = z.enum(["bundled", "stealth", "attach"]);
export type BrowserMode = z.infer<typeof BrowserMode>;

// ─── Full Input Schema (internal use) ────────────────────────────
// Contains all parameters including advanced browser config.
// Used by the server handler to parse + apply defaults.

export const SnapshotInput = z.object({
  url: z.string().url().describe("URL to navigate to"),
  viewport_width: z.number().int().min(320).max(3840).default(1280).describe("Viewport width in CSS pixels"),
  viewport_height: z.number().int().min(240).max(2160).default(720).describe("Viewport height in CSS pixels"),
  zoom: z.number().min(0.25).max(5).default(1.0).describe("Device scale factor"),
  settle_ms: z.number().int().min(0).max(30000).default(2000).describe("Time to wait after load for dynamic content to settle"),
  include_non_visible: z.boolean().default(false).describe("Include elements with display:none or visibility:hidden"),
  max_depth: z.number().int().min(1).max(200).default(50).describe("Maximum DOM tree depth to traverse"),
  browser_mode: BrowserMode.default("stealth").describe("Browser launch mode: bundled (Playwright Chromium), stealth (real Chrome), attach (existing CDP)"),
  cdp_url: z.string().optional().describe("CDP WebSocket URL (required for attach mode)"),
  chrome_path: z.string().optional().describe("Override Chrome binary path for stealth mode"),
  verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe("Element filtering: actionable (interactive only), landmarks (+ semantic regions), all (every visible element)"),
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;

// ─── Public Input Schema (MCP tool surface) ──────────────────────
// This is what AI agents see. Advanced browser params are hidden —
// the server defaults to stealth mode with sane settings.
// Agents should never need to think about browser_mode, cdp_url, or chrome_path.

export const PublicSnapshotInput = z.object({
  url: z.string().url().describe("URL to navigate to. A real Chrome browser is launched automatically — no setup needed."),
  viewport_width: z.number().int().min(320).max(3840).default(1280).describe("Viewport width in CSS pixels (default: 1280)"),
  viewport_height: z.number().int().min(240).max(2160).default(720).describe("Viewport height in CSS pixels (default: 720)"),
  zoom: z.number().min(0.25).max(5).default(1.0).describe("Device scale factor / zoom level (default: 1.0)"),
  settle_ms: z.number().int().min(0).max(30000).default(2000).describe("Milliseconds to wait after page load for dynamic content (SPAs, lazy-loading) to settle (default: 2000)"),
  include_non_visible: z.boolean().default(false).describe("Include hidden elements (display:none, visibility:hidden). Usually not needed."),
  max_depth: z.number().int().min(1).max(200).default(50).describe("Max DOM depth to traverse (default: 50). Increase only for deeply nested pages."),
  verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe("What to include: 'actionable' = buttons/links/inputs only (default, fastest), 'landmarks' = + headings/nav/sections, 'all' = every visible element"),
  max_elements: z.number().int().min(10).max(5000).default(500).describe("Maximum number of elements to return (default: 500). Large pages may have thousands of elements — this cap prevents response overflow. Use spatial_scroll + re-snapshot to see more of the page."),
});
export type PublicSnapshotInput = z.infer<typeof PublicSnapshotInput>;

// ─── Action Input Schemas ────────────────────────────────────────

export const ClickInput = z.object({
  x: z.number().describe("X coordinate in CSS pixels — use click_center.x from a spatial_snapshot element"),
  y: z.number().describe("Y coordinate in CSS pixels — use click_center.y from a spatial_snapshot element"),
  button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button (default: left)"),
  click_count: z.number().int().min(1).max(3).default(1).describe("Number of clicks — 2 for double-click, 3 for triple-click (default: 1)"),
});

export const TypeInput = z.object({
  text: z.string().describe("Text to type into the focused element"),
  x: z.number().optional().describe("Optional: click this X coordinate first to focus the element, then type"),
  y: z.number().optional().describe("Optional: click this Y coordinate first to focus the element, then type"),
  clear_first: z.boolean().default(false).describe("Select all + delete existing text before typing (default: false)"),
  press_enter: z.boolean().default(false).describe("Press Enter after typing — useful for search boxes and forms (default: false)"),
});

export const ScrollInput = z.object({
  delta_x: z.number().default(0).describe("Horizontal scroll in pixels. Positive = right, negative = left (default: 0)"),
  delta_y: z.number().default(0).describe("Vertical scroll in pixels. Positive = down, negative = up (default: 0)"),
  x: z.number().optional().describe("Optional: scroll at this X coordinate (targets a specific scrollable container instead of the page)"),
  y: z.number().optional().describe("Optional: scroll at this Y coordinate (targets a specific scrollable container instead of the page)"),
});

export const QueryInput = z.object({
  role: z.string().optional().describe('Filter by ARIA role, e.g. "button", "link", "textbox", "heading"'),
  tag: z.string().optional().describe('Filter by HTML tag, e.g. "input", "a", "div"'),
  label_contains: z.string().optional().describe("Filter elements whose accessible label contains this text (case-insensitive)"),
  region: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional().describe("Only return elements within this bounding box (CSS pixels)"),
  actionable_only: z.boolean().default(false).describe("Only return interactive elements (buttons, links, inputs)"),
});

// ─── Output Types ────────────────────────────────────────────────

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ComputedLayout {
  position: string;
  z_index: string;
  display: string;
  overflow: string;
  opacity: string;
}

export interface SpatialElement {
  idx: number;
  tag: string;
  id: string | null;
  selector: string;
  parent_idx: number | null;

  role: string | null;
  label: string | null;
  text: string | null;

  bounds: Bounds;

  computed: ComputedLayout;

  actionable: boolean;
  click_center: Point | null;
  input_type: string | null;
  focusable: boolean;
  tab_index: number | null;
}

export interface SpatialMapStats {
  total_elements: number;
  actionable_elements: number;
  focusable_elements: number;
  max_depth: number;
}

export interface SpatialMap {
  url: string;
  timestamp: string;
  viewport: { width: number; height: number };
  zoom: number;
  scroll: Point;
  page_bounds: { width: number; height: number };
  elements: SpatialElement[];
  stats: SpatialMapStats;
}
