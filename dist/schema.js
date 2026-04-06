import { z } from "zod";
// ─── Browser Modes ───────────────────────────────────────────────
export const BrowserMode = z.enum(["bundled", "stealth", "attach"]);
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
    max_elements: z.number().int().min(10).max(10000).default(2000).describe("Maximum elements to return (default: 2000). If truncated, scroll + re-snapshot to see more."),
    compact: z.boolean().default(true).describe("Return compact elements (default: true). Compact strips CSS layout details, selectors, and DOM hierarchy — keeping only what you need: tag, role, label, text, bounds, click_center, actionable. Set false for full element data."),
    output_format: z.enum(["compact", "agent"]).default("compact").describe("Output format: 'compact' (default) returns the full element list with coordinates, roles, and accessibility info for general browsing and UI tasks. 'agent' is optimized for AI context windows on text-dense pages (Wikipedia, Amazon, long articles): returns deduplicated readable page text + only interactive elements within the current viewport with click coordinates. In agent mode, elements are strictly confined to viewport bounds using click_center checks (not just bounding box overlap), preventing wide-layout leakage. Includes viewport_info with scroll position, page height, and percent_remaining. For long pages: use spatial_scroll(delta_y=~670) to advance, then re-request agent output for the next viewport."),
});
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
export const ImportCookiesInput = z.object({
    cookies: z.array(z.object({
        name: z.string().describe("Cookie name"),
        value: z.string().describe("Cookie value"),
        domain: z.string().describe("Cookie domain (e.g. '.yelp.com')"),
        path: z.string().optional().describe("Cookie path (default: '/')"),
        expires: z.number().optional().describe("Expiry as Unix timestamp. -1 for session cookie"),
        httpOnly: z.boolean().optional().describe("HTTP-only flag"),
        secure: z.boolean().optional().describe("Secure flag"),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite attribute"),
    })).describe("Array of cookies to import into the browser session"),
});
export const ExportCookiesInput = z.object({
    domains: z.array(z.string()).optional().describe("Filter to cookies matching these domains (e.g. ['yelp.com']). Omit for all cookies."),
});
export const ConnectCDPInput = z.object({
    cdp_url: z.string().default("http://localhost:9222").describe("CDP endpoint URL. Default: http://localhost:9222. The user must launch Chrome with: google-chrome --remote-debugging-port=9222"),
});
export const DisconnectCDPInput = z.object({});
//# sourceMappingURL=schema.js.map