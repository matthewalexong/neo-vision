import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserMode } from "./schema.js";
import { applyStealthToContext, applyStealthToPage } from "./stealth.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// ─── Persistent Profile Directory ──────────────────────────────
// Instead of Playwright's ephemeral /tmp dirs, we use a persistent
// profile that retains cookies, localStorage, and history across
// sessions — making the browser look like a real, long-lived install.

const NEO_VISION_DIR = path.join(os.homedir(), ".neo-vision");
const PRIMARY_PROFILE = path.join(NEO_VISION_DIR, "chrome-profile");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Clean up stale Chrome Singleton* lock files from a profile directory.
 * These persist after Chrome crashes or gets killed, and prevent new
 * Chrome instances from starting with the same profile.
 */
function cleanStaleChromelocks(profileDir: string): void {
  for (const lockFile of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const lockPath = path.join(profileDir, lockFile);
    try { fs.unlinkSync(lockPath); } catch { /* ignore if doesn't exist */ }
  }
}

// ─── Concurrent Profile Resolution ─────────────────────────────
// Multiple MCP instances (e.g. Cowork + Hermes gateway) may try to
// open the same Chrome profile simultaneously. Playwright's
// launchPersistentContext will crash if the profile is already open.
//
// We use our own PID-based lock file (~/.neo-vision/profile.lock)
// since Chrome's SingletonLock is unreliable for detection.
//
// Strategy:
//   1. Check our lock file. If absent or stale (dead PID), claim the primary profile.
//   2. If the lock is held by a live process, use a fallback profile.
//   3. Write our PID into the lock on successful claim.

const LOCK_FILE = path.join(NEO_VISION_DIR, "profile.lock");

function resolveProfileDir(requestedDir?: string): string {
  if (requestedDir) {
    // Explicit dir requested — use it directly, no locking
    ensureDir(requestedDir);
    return requestedDir;
  }

  ensureDir(NEO_VISION_DIR);
  ensureDir(PRIMARY_PROFILE);

  // Check our own lock file
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (lockPid && lockPid !== process.pid) {
        try {
          process.kill(lockPid, 0); // check if alive
          // Lock holder is alive — use fallback profile
          const fallbackDir = path.join(NEO_VISION_DIR, `chrome-profile-${process.pid}`);
          ensureDir(fallbackDir);
          // Write our own lock for the fallback (in case a third instance appears)
          console.error(
            `Primary profile locked by PID ${lockPid}; using fallback: ${fallbackDir}`
          );
          return fallbackDir;
        } catch {
          // Lock holder is dead — stale lock, reclaim
          console.error(`Removed stale profile.lock (dead PID ${lockPid})`);
        }
      }
      // lockPid === process.pid means we already hold it
    } catch {
      // Corrupt lock file — overwrite it
    }
  }

  // Claim the primary profile
  fs.writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
  return PRIMARY_PROFILE;
}

// Clean up our lock file on process exit
function cleanupLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (lockPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch { /* best effort */ }
}
process.on("exit", cleanupLock);
process.on("SIGINT", () => { cleanupLock(); process.exit(130); });
process.on("SIGTERM", () => { cleanupLock(); process.exit(143); });

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
export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: SessionConfig | null = null;

  async getPage(config: SessionConfig): Promise<Page> {
    if (this.page && this.config && !this.configMatches(config)) {
      await this.close();
    }
    if (this.page) {
      return this.page;
    }

    this.config = config;
    const useStealth = config.stealth ?? (config.browserMode !== "attach");
    const profileDir = resolveProfileDir(config.profileDir);

    const stealthArgs = [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-automation",
      "--test-type",
    ];

    const contextOpts = {
      viewport: {
        width: config.viewportWidth,
        height: config.viewportHeight,
      },
      deviceScaleFactor: config.zoom,
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      reducedMotion: "reduce" as const,
    };

    // Clean up stale Chrome locks before launching — prevents crash
    // when Chrome was previously killed without clean shutdown
    cleanStaleChromelocks(profileDir);

    switch (config.browserMode) {
      case "bundled":
        this.context = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          args: [...stealthArgs, "--headless=new"],
          ignoreDefaultArgs: ["--enable-automation"],
          ...contextOpts,
        });
        this.browser = this.context.browser();
        break;

      case "stealth":
        this.context = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          channel: "chrome",
          executablePath: config.chromePath || undefined,
          args: stealthArgs,
          ignoreDefaultArgs: ["--enable-automation"],
          ...contextOpts,
          bypassCSP: true,
        });
        this.browser = this.context.browser();
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
        const contexts = this.browser.contexts();
        if (contexts.length > 0) {
          this.context = contexts[0];
          const pages = this.context.pages();
          if (pages.length > 0) {
            this.page = pages[0];
            if (useStealth) {
              await applyStealthToPage(this.page);
            }
            return this.page;
          }
        }
        break;
      }
    }

    // For attach mode fallthrough
    if (!this.context) {
      this.context = await this.browser!.newContext({
        ...contextOpts,
        ...(config.browserMode === "stealth" ? { bypassCSP: true } : {}),
      });
    }

    if (useStealth) {
      await applyStealthToContext(this.context);
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  getCurrentPage(): Page | null {
    return this.page;
  }

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
