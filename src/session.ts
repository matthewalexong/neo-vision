import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserMode } from "./schema.js";
import { applyStealthToContext, applyStealthToPage } from "./stealth.js";

export interface SessionConfig {
  browserMode: BrowserMode;
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  cdpUrl?: string;
  chromePath?: string;
  stealth?: boolean; // defaults to true for stealth + bundled, false for attach
}

/**
 * Manages a single browser session per MCP connection.
 * Handles launch, page creation, viewport locking, stealth patches, and cleanup.
 */
export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: SessionConfig | null = null;

  async getPage(config: SessionConfig): Promise<Page> {
    // If config changed, tear down and rebuild
    if (this.page && this.config && !this.configMatches(config)) {
      await this.close();
    }

    if (this.page) {
      return this.page;
    }

    this.config = config;
    const useStealth = config.stealth ?? (config.browserMode !== "attach");

    switch (config.browserMode) {
      case "bundled":
        this.browser = await chromium.launch({
          headless: true,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-infobars",
            "--no-first-run",
            "--no-default-browser-check",
          ],
        });
        break;

      case "stealth":
        this.browser = await chromium.launch({
          headless: false,
          channel: "chrome",
          executablePath: config.chromePath || undefined,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions-except=",
            "--disable-default-apps",
          ],
        });
        break;

      case "attach": {
        if (!config.cdpUrl) {
          throw new Error(
            "attach mode requires cdp_url parameter. Launch Chrome with:\n" +
            '  google-chrome --remote-debugging-port=9222\n' +
            'Then pass cdp_url: "http://localhost:9222"'
          );
        }
        this.browser = await chromium.connectOverCDP(config.cdpUrl);

        // In attach mode, we use existing contexts and pages
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          this.context = contexts[0];
          const pages = this.context.pages();
          if (pages.length > 0) {
            this.page = pages[0];
            // Apply stealth to the existing page if requested
            if (useStealth) {
              await applyStealthToPage(this.page);
            }
            return this.page;
          }
        }
        // Fall through to create a new context if none exist
        break;
      }
    }

    // Create context with locked viewport and deterministic settings
    if (!this.context) {
      this.context = await this.browser!.newContext({
        viewport: {
          width: config.viewportWidth,
          height: config.viewportHeight,
        },
        deviceScaleFactor: config.zoom,
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
        ...(config.browserMode === "stealth" ? { bypassCSP: true } : {}),
      });
    }

    // Apply stealth patches to the context (runs before every page load)
    if (useStealth) {
      await applyStealthToContext(this.context);
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  /**
   * Get the current page without changing config. Returns null if no session.
   */
  getCurrentPage(): Page | null {
    return this.page;
  }

  /**
   * Get the current config. Used by action tools to avoid resetting the session.
   */
  getCurrentConfig(): SessionConfig | null {
    return this.config;
  }

  async close(): Promise<void> {
    if (this.page) {
      try { await this.page.close(); } catch { /* ignore */ }
      this.page = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
    // Don't close the browser in attach mode — we don't own it
    if (this.browser && this.config?.browserMode !== "attach") {
      try { await this.browser.close(); } catch { /* ignore */ }
    }
    this.browser = null;
    this.config = null;
  }

  private configMatches(config: SessionConfig): boolean {
    if (!this.config) return false;
    return (
      this.config.browserMode === config.browserMode &&
      this.config.viewportWidth === config.viewportWidth &&
      this.config.viewportHeight === config.viewportHeight &&
      this.config.zoom === config.zoom &&
      this.config.cdpUrl === config.cdpUrl &&
      this.config.chromePath === config.chromePath
    );
  }
}
