/**
 * NeoVision Injectable Spatial Snapshot
 *
 * Provides the self-contained browser-side JavaScript that maps the
 * visible DOM into structured spatial data.  This module is the bridge
 * between NeoVision's server-side TypeScript and ANY browser context:
 *
 *   - Claude in Chrome's javascript_tool  (hybrid mode — the main use case)
 *   - Chrome extension content scripts
 *   - Playwright page.evaluate()
 *   - DevTools console / bookmarklets
 *
 * Three exports cover every integration pattern:
 *
 *   1. `INJECTABLE_SOURCE`  — The raw JS source string.  Inject it once
 *      into a page, then call `neoVisionSnapshot()` as many times as
 *      you like.  Best for long-lived sessions where you want to
 *      snapshot → act → re-snapshot without re-injecting.
 *
 *   2. `getInjectableScript(opts)` — Returns a single JS expression
 *      that defines the function AND immediately invokes it, returning
 *      the SpatialMap.  Best for one-shot injection (e.g., Chrome
 *      extension `executeScript`, Claude in Chrome `javascript_tool`).
 *
 *   3. `InjectableSpatialMap` / `InjectableSpatialElement` — TypeScript
 *      types for the object returned by the injectable.  These are
 *      intentionally lighter than the Playwright-side SpatialElement
 *      (no selector, no ComputedLayout) because browser-side extraction
 *      keeps things minimal for fast serialization.
 */
export interface InjectableBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface InjectablePoint {
    x: number;
    y: number;
}
export interface InjectableSpatialElement {
    idx: number;
    tag: string;
    role: string | null;
    label: string | null;
    text: string | null;
    bounds: InjectableBounds;
    actionable: boolean;
    click_center: InjectablePoint | null;
    focusable: boolean;
    parent_idx: number | null;
}
export interface InjectableSpatialMap {
    url: string;
    timestamp: string;
    viewport: {
        width: number;
        height: number;
    };
    scroll: InjectablePoint;
    page_bounds: {
        width: number;
        height: number;
    };
    elements: InjectableSpatialElement[];
    stats: {
        total_elements: number;
        actionable_elements: number;
        focusable_elements: number;
    };
}
export interface InjectableOptions {
    /** Max DOM depth to traverse. Default: 50 */
    maxDepth?: number;
    /** Include display:none / visibility:hidden elements. Default: false */
    includeNonVisible?: boolean;
    /** Element filter: "actionable" (default), "landmarks", "all" */
    verbosity?: "actionable" | "landmarks" | "all";
}
export declare const INJECTABLE_SOURCE: string;
/**
 * Returns a single JS expression that defines neoVisionSnapshot AND
 * immediately invokes it with the given options.
 *
 * Usage with Claude in Chrome's javascript_tool:
 *   const script = getInjectableScript({ verbosity: "actionable" });
 *   // Paste/send `script` to javascript_tool — returns the SpatialMap JSON
 *
 * Usage with Playwright:
 *   const map = await page.evaluate(getInjectableScript({ verbosity: "all" }));
 *
 * Usage with Chrome extension:
 *   chrome.scripting.executeScript({
 *     target: { tabId },
 *     func: new Function(getInjectableScript()),
 *   });
 */
export declare function getInjectableScript(opts?: InjectableOptions): string;
/**
 * Returns the injectable source wrapped as a self-invoking function
 * that installs `neoVisionSnapshot` on `window` for repeated use.
 *
 * After injecting this once, call `neoVisionSnapshot()` or
 * `neoVisionSnapshot({ verbosity: "all" })` as many times as needed.
 */
export declare function getInjectableInstaller(): string;
