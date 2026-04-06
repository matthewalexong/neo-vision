import { type BrowserContext, type Page } from "playwright";
import type { BrowserMode } from "./schema.js";
export interface SessionConfig {
    browserMode: BrowserMode;
    viewportWidth: number;
    viewportHeight: number;
    zoom: number;
    cdpUrl?: string;
    chromePath?: string;
    profileDir?: string;
    stealth?: boolean;
}
/**
 * Manages a single browser session per MCP connection.
 * Uses launchPersistentContext for bundled/stealth modes so Playwright
 * manages the Chrome profile directory natively.
 */
export declare class SessionManager {
    private browser;
    private context;
    private page;
    private config;
    private cdpConnected;
    /**
     * Connect to the user's Chrome via CDP.
     * If Chrome isn't running with --remote-debugging-port, NeoVision
     * automatically restarts it with the flag. Chrome restores all tabs
     * on relaunch, so the user barely notices.
     *
     * Flow:
     *   1. Try connecting to cdpUrl
     *   2. If refused → restart Chrome with CDP enabled → retry
     *   3. Grab the first context + page
     */
    connectCDP(cdpUrl?: string): Promise<{
        pages: number;
        contexts: number;
        url: string | null;
        restarted: boolean;
    }>;
    /**
     * Whether we're connected to an external Chrome via CDP.
     * When true, spatial_snapshot should navigate on the existing page
     * instead of trying to launch a new browser.
     */
    isCDPConnected(): boolean;
    getPage(config: SessionConfig): Promise<Page>;
    getCurrentPage(): Page | null;
    getCurrentContext(): BrowserContext | null;
    getCurrentConfig(): SessionConfig | null;
    /**
     * Import cookies into the browser context.
     * Accepts Playwright-format cookies (name, value, domain, path, etc.)
     * Use this to warm up sessions with cookies from the user's real browser,
     * allowing NeoVision to bypass anti-bot systems like DataDome/Cloudflare
     * that require established session history.
     */
    importCookies(cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "Strict" | "Lax" | "None";
    }>): Promise<number>;
    /**
     * Export all cookies from the current browser context.
     * Useful for saving session state.
     */
    exportCookies(domains?: string[]): Promise<any[]>;
    close(): Promise<void>;
    private configMatches;
}
