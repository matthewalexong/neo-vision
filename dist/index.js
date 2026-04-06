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
export { SessionManager } from "./session.js";
export { takeSnapshot, navigateWithFallback } from "./snapshot.js";
export { click, type, scroll } from "./actions.js";
export { queryMap } from "./query.js";
export { applyStealthToContext, applyStealthToPage, stealthCheck, humanDelay, humanSleep, typingDelay, STEALTH_PATCHES, DETERMINISTIC_CSS, } from "./stealth.js";
// ─── Injectable (browser-side spatial snapshot) ──────────────────
export { INJECTABLE_SOURCE, getInjectableScript, getInjectableInstaller, } from "./injectable.js";
// ─── Chrome Bridge (extension-based browser control) ───────────────
export { ChromeBridge } from "./bridge.js";
// ─── Pacing (human-like throttling for scraping) ─────────────────
export { PacingEngine, getCaptchaDetector, CAPTCHA_DETECTOR_SOURCE, } from "./pacing.js";
import { SessionManager } from "./session.js";
import { takeSnapshot, navigateWithFallback } from "./snapshot.js";
import { click as rawClick, type as rawType, scroll as rawScroll } from "./actions.js";
import { queryMap } from "./query.js";
import { stealthCheck, humanSleep } from "./stealth.js";
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
export class SpatialBrowser {
    session;
    sessionConfig;
    lastSnapshot = null;
    snapshotOptions;
    constructor(options = {}) {
        this.session = new SessionManager();
        this.sessionConfig = {
            browserMode: options.mode ?? "bundled",
            viewportWidth: options.width ?? 1280,
            viewportHeight: options.height ?? 720,
            zoom: options.zoom ?? 1.0,
            cdpUrl: options.cdpUrl,
            chromePath: options.chromePath,
            stealth: options.stealth,
        };
        this.snapshotOptions = {
            settleMs: 2000,
            includeNonVisible: false,
            maxDepth: 50,
            verbosity: "actionable",
        };
    }
    /**
     * Navigate to a URL and take a spatial snapshot.
     * Returns a SpatialMap with all elements, their coordinates, and actionability.
     */
    async snapshot(url, config) {
        const page = await this.session.getPage(this.sessionConfig);
        await navigateWithFallback(page, url);
        const opts = {
            settleMs: config?.settleMs ?? this.snapshotOptions.settleMs,
            includeNonVisible: config?.includeHidden ?? this.snapshotOptions.includeNonVisible,
            maxDepth: config?.maxDepth ?? this.snapshotOptions.maxDepth,
            verbosity: config?.verbosity ?? this.snapshotOptions.verbosity,
        };
        this.snapshotOptions = opts;
        this.lastSnapshot = await takeSnapshot(page, opts);
        return this.lastSnapshot;
    }
    /**
     * Take a snapshot of the current page without navigating.
     * Useful after click/type/scroll to see what changed.
     */
    async refresh(config) {
        const page = await this.session.getPage(this.sessionConfig);
        const opts = {
            settleMs: config?.settleMs ?? this.snapshotOptions.settleMs,
            includeNonVisible: config?.includeHidden ?? this.snapshotOptions.includeNonVisible,
            maxDepth: config?.maxDepth ?? this.snapshotOptions.maxDepth,
            verbosity: config?.verbosity ?? this.snapshotOptions.verbosity,
        };
        this.lastSnapshot = await takeSnapshot(page, opts);
        return this.lastSnapshot;
    }
    /**
     * Click at a coordinate. Returns updated spatial map.
     */
    async click(point, options) {
        const page = await this.session.getPage(this.sessionConfig);
        this.lastSnapshot = await rawClick(page, point.x, point.y, options?.button ?? "left", options?.clickCount ?? 1, this.snapshotOptions);
        return this.lastSnapshot;
    }
    /**
     * Type text, optionally at a specific coordinate. Returns updated spatial map.
     */
    async type(text, at, options) {
        const page = await this.session.getPage(this.sessionConfig);
        this.lastSnapshot = await rawType(page, text, { x: at?.x, y: at?.y, clearFirst: options?.clearFirst, pressEnter: options?.pressEnter }, this.snapshotOptions);
        return this.lastSnapshot;
    }
    /**
     * Scroll the page. Returns updated spatial map.
     */
    async scroll(deltaY, deltaX = 0, at) {
        const page = await this.session.getPage(this.sessionConfig);
        this.lastSnapshot = await rawScroll(page, deltaX, deltaY, at?.x, at?.y, this.snapshotOptions);
        return this.lastSnapshot;
    }
    /**
     * Filter the last snapshot in memory (no network call).
     */
    query(filters) {
        if (!this.lastSnapshot) {
            throw new Error("No snapshot taken yet. Call snapshot() first.");
        }
        return queryMap(this.lastSnapshot, filters);
    }
    /**
     * Wait with human-like jitter (useful for stealth pacing between actions).
     */
    async wait(baseMs = 2000) {
        const page = await this.session.getPage(this.sessionConfig);
        await humanSleep(page, baseMs);
    }
    /**
     * Run a stealth self-check. Returns pass/fail for each detection vector.
     */
    async checkStealth() {
        const page = await this.session.getPage(this.sessionConfig);
        return stealthCheck(page);
    }
    /**
     * Get the last snapshot without re-taking it.
     */
    getLastSnapshot() {
        return this.lastSnapshot;
    }
    /**
     * Close the browser session and clean up resources.
     */
    async close() {
        await this.session.close();
        this.lastSnapshot = null;
    }
}
//# sourceMappingURL=index.js.map