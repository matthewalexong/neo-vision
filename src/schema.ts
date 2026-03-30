import { z } from "zod";

// ─── Input Schemas ───────────────────────────────────────────────

export const BrowserMode = z.enum(["bundled", "stealth", "attach"]);
export type BrowserMode = z.infer<typeof BrowserMode>;

export const SnapshotInput = z.object({
  url: z.string().url().describe("URL to navigate to"),
  viewport_width: z.number().int().min(320).max(3840).default(1280).describe("Viewport width in CSS pixels"),
  viewport_height: z.number().int().min(240).max(2160).default(720).describe("Viewport height in CSS pixels"),
  zoom: z.number().min(0.25).max(5).default(1.0).describe("Device scale factor"),
  settle_ms: z.number().int().min(0).max(30000).default(2000).describe("Time to wait after load for dynamic content to settle"),
  include_non_visible: z.boolean().default(false).describe("Include elements with display:none or visibility:hidden"),
  max_depth: z.number().int().min(1).max(200).default(50).describe("Maximum DOM tree depth to traverse"),
  browser_mode: BrowserMode.default("bundled").describe("Browser launch mode: bundled (Playwright Chromium), stealth (real Chrome), attach (existing CDP)"),
  cdp_url: z.string().optional().describe("CDP WebSocket URL (required for attach mode)"),
  chrome_path: z.string().optional().describe("Override Chrome binary path for stealth mode"),
  verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe("Element filtering: actionable (interactive only), landmarks (+ semantic regions), all (every visible element)"),
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;

export const ClickInput = z.object({
  x: z.number().describe("X coordinate in CSS pixels"),
  y: z.number().describe("Y coordinate in CSS pixels"),
  button: z.enum(["left", "right", "middle"]).default("left"),
  click_count: z.number().int().min(1).max(3).default(1),
});

export const TypeInput = z.object({
  text: z.string().describe("Text to type"),
  x: z.number().optional().describe("Click this coordinate first, then type"),
  y: z.number().optional().describe("Click this coordinate first, then type"),
  clear_first: z.boolean().default(false).describe("Select all + delete before typing"),
  press_enter: z.boolean().default(false).describe("Press Enter after typing"),
});

export const ScrollInput = z.object({
  delta_x: z.number().default(0).describe("Horizontal scroll pixels (positive = right)"),
  delta_y: z.number().default(0).describe("Vertical scroll pixels (positive = down)"),
  x: z.number().optional().describe("Scroll at this coordinate (for scrollable containers)"),
  y: z.number().optional().describe("Scroll at this coordinate"),
});

export const QueryInput = z.object({
  role: z.string().optional().describe('Filter by ARIA role (e.g., "button", "link", "textbox")'),
  tag: z.string().optional().describe('Filter by HTML tag (e.g., "input", "a")'),
  label_contains: z.string().optional().describe("Filter by label text (case-insensitive substring)"),
  region: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional().describe("Only return elements within this bounding box"),
  actionable_only: z.boolean().default(false).describe("Only return elements where actionable: true"),
});

// ─── Output Schemas ──────────────────────────────────────────────

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
