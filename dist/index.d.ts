/**
 * NeoVision — Programmatic API
 *
 * See the web the way Neo sees the Matrix.
 * Use this to integrate spatial DOM mapping into any agent harness:
 * Claude Code, Cowork, OpenClaw, AntiGravity, LangChain, CrewAI, etc.
 *
 * Usage:
 *   import { SpatialBrowser } from 'neo-vision';
 *
 *   const browser = new SpatialBrowser({ mode: 'stealth' });
 *   const map = await browser.snapshot('https://example.com');
 *   console.log(map.elements.filter(e => e.actionable));
 *   await browser.click(map.elements[5].click_center!);
 *   await browser.close();
 */
export { SessionManager, type SessionConfig } from "./session.js";
export { takeSnapshot, navigateWithFallback, type SnapshotOptions } from "./snapshot.js";
export { click, type, scroll } from "./actions.js";
export { queryMap, type QueryFilters } from "./query.js";
export { applyStealthToContext, applyStealthToPage, stealthCheck, humanDelay, humanSleep, typingDelay, STEALTH_PATCHES, DETERMINISTIC_CSS, } from "./stealth.js";
export type { BrowserMode, SpatialMap, SpatialElement, SpatialMapStats, Bounds, Point, ComputedLayout, } from "./schema.js";
export { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller, } from "./injectable.js";
export type { InjectableSpatialMap, InjectableSpatialElement, InjectableBounds, InjectablePoint, InjectableOptions, } from "./injectable.js";
export { ChromeBridge, type BridgeConfig } from "./bridge.js";
export { PacingEngine, getCaptchaDetector, CAPTCHA_DETECTOR_SOURCE, } from "./pacing.js";
export type { PacingConfig, PacingInstruction, PacingStats, } from "./pacing.js";
import { type QueryFilters } from "./query.js";
import type { SpatialMap, Point, BrowserMode } from "./schema.js";
export interface SpatialBrowserOptions {
    /** Browser mode: "bundled" (headless), "stealth" (real Chrome), "attach" (existing CDP) */
    mode?: BrowserMode;
    /** Viewport width in CSS pixels. Default: 1280 */
    width?: number;
    /** Viewport height in CSS pixels. Default: 720 */
    height?: number;
    /** Device scale factor. Default: 1.0 */
    zoom?: number;
    /** CDP WebSocket URL (required for "attach" mode) */
    cdpUrl?: string;
    /** Path to Chrome binary (optional, for "stealth" mode) */
    chromePath?: string;
    /** Enable stealth patches. Default: true for bundled/stealth, false for attach */
    stealth?: boolean;
}
export interface SnapshotConfig {
    /** Time to wait for dynamic content to settle. Default: 2000ms */
    settleMs?: number;
    /** Include display:none / visibility:hidden elements. Default: false */
    includeHidden?: boolean;
    /** Max DOM depth to traverse. Default: 50 */
    maxDepth?: number;
    /** Element filter: "actionable" (default), "landmarks", "all" */
    verbosity?: "actionable" | "landmarks" | "all";
}
/**
 * High-level wrapper for spatial DOM mapping.
 * Designed for easy integration into any agent harness.
 *
 * @example
 * ```ts
 * const browser = new SpatialBrowser({ mode: 'stealth' });
 * const map = await browser.snapshot('https://yelp.com/search?find_desc=pizza');
 *
 * // Find all clickable links
 * const links = map.elements.filter(e => e.role === 'link' && e.actionable);
 *
 * // Click the first result
 * await browser.click(links[0].click_center!);
 *
 * // Type into a search box
 * const searchBox = map.elements.find(e => e.role === 'searchbox');
 * if (searchBox) await browser.type(searchBox.click_center!, 'tacos');
 *
 * await browser.close();
 * ```
 */
export declare class SpatialBrowser {
    private session;
    private sessionConfig;
    private lastSnapshot;
    private snapshotOptions;
    constructor(options?: SpatialBrowserOptions);
    /**
     * Navigate to a URL and take a spatial snapshot.
     * Returns a SpatialMap with all elements, their coordinates, and actionability.
     */
    snapshot(url: string, config?: SnapshotConfig): Promise<SpatialMap>;
    /**
     * Take a snapshot of the current page without navigating.
     * Useful after click/type/scroll to see what changed.
     */
    refresh(config?: SnapshotConfig): Promise<SpatialMap>;
    /**
     * Click at a coordinate. Returns updated spatial map.
     */
    click(point: Point, options?: {
        button?: "left" | "right" | "middle";
        clickCount?: number;
    }): Promise<SpatialMap>;
    /**
     * Type text, optionally at a specific coordinate. Returns updated spatial map.
     */
    type(text: string, at?: Point, options?: {
        clearFirst?: boolean;
        pressEnter?: boolean;
    }): Promise<SpatialMap>;
    /**
     * Scroll the page. Returns updated spatial map.
     */
    scroll(deltaY: number, deltaX?: number, at?: Point): Promise<SpatialMap>;
    /**
     * Filter the last snapshot in memory (no network call).
     */
    query(filters: QueryFilters): SpatialMap;
    /**
     * Wait with human-like jitter (useful for stealth pacing between actions).
     */
    wait(baseMs?: number): Promise<void>;
    /**
     * Run a stealth self-check. Returns pass/fail for each detection vector.
     */
    checkStealth(): Promise<Record<string, boolean>>;
    /**
     * Get the last snapshot without re-taking it.
     */
    getLastSnapshot(): SpatialMap | null;
    /**
     * Close the browser session and clean up resources.
     */
    close(): Promise<void>;
}
