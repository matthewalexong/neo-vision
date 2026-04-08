import { z } from "zod";
// ─── Public Input Schema (MCP tool surface) ──────────────────────
export const PublicSnapshotInput = z.object({
    url: z.string().url().optional().describe("URL to navigate to. Optional — omit to snapshot the current page."),
    viewport_width: z.number().int().min(320).max(3840).default(1280).describe("Viewport width in CSS pixels (default: 1280)"),
    viewport_height: z.number().int().min(240).max(2160).default(720).describe("Viewport height in CSS pixels (default: 720)"),
    settle_ms: z.number().int().min(0).max(30000).default(2000).describe("Milliseconds to wait after page load for dynamic content (SPAs, lazy-loading) to settle (default: 2000)"),
    include_non_visible: z.boolean().default(false).describe("Include hidden elements (display:none, visibility:hidden). Usually not needed."),
    max_depth: z.number().int().min(1).max(200).default(50).describe("Max DOM depth to traverse (default: 50)"),
    verbosity: z.enum(["actionable", "landmarks", "all"]).default("actionable").describe("'actionable' = buttons/links/inputs only (default), 'landmarks' = + headings/nav/sections, 'all' = every element"),
    max_elements: z.number().int().min(10).max(10000).default(2000).describe("Maximum elements to return (default: 2000)"),
    compact: z.boolean().default(true).describe("Return compact elements (default: true). Set false for full element data."),
    output_format: z.enum(["compact", "agent"]).default("compact").describe("'compact' (default) = full element list, 'agent' = readable page text + interactive elements (optimized for AI context windows)"),
});
// ─── Action Input Schemas ────────────────────────────────────────
export const ClickInput = z.object({
    x: z.number().describe("X coordinate in CSS pixels — use click_center.x from a spatial_snapshot element"),
    y: z.number().describe("Y coordinate in CSS pixels — use click_center.y from a spatial_snapshot element"),
    button: z.enum(["left", "right"]).default("left").describe("Mouse button (default: left)"),
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
    delta_y: z.number().default(0).describe("Vertical scroll in pixels. Positive = down, negative = up (default: 0). After scrolling in agent mode, call spatial_snapshot again to get the next viewport's content."),
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
//# sourceMappingURL=schema.js.map