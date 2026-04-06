import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BrowserMode } from "./schema.js";
import { applyStealthToContext, applyStealthToPage } from "./stealth.js";
import { execSync, spawn } from "child_process";
import * as http from "http";
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

// ─── CDP Auto-Restart Helpers ─────────────────────────────────
// When the user's Chrome isn't running with --remote-debugging-port,
// we automatically restart it with the flag. Chrome restores all
// tabs on macOS by default, so the user barely notices.

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findChromePath(): string | null {
  const candidates = CHROME_PATHS[process.platform] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Check if a CDP endpoint is responding on the given URL.
 */
function checkCDP(cdpUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL("/json/version", cdpUrl);
    const req = http.get(url, (res) => {
      res.resume(); // drain
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Poll until CDP endpoint is ready, with timeout.
 */
async function waitForCDP(cdpUrl: string, timeoutMs: number = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkCDP(cdpUrl)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Gracefully quit Chrome on macOS via AppleScript, wait for it to
 * actually exit, then relaunch with --remote-debugging-port.
 */
async function restartChromeWithCDP(port: number = 9222): Promise<void> {
  const platform = process.platform;
  const chromePath = findChromePath();

  if (!chromePath) {
    throw new Error(
      "Could not find Chrome installation. Install Google Chrome or pass the path manually."
    );
  }

  // Step 1: Gracefully quit Chrome if it's running
  if (platform === "darwin") {
    try {
      execSync(
        `osascript -e 'tell application "Google Chrome" to quit'`,
        { timeout: 5000 }
      );
    } catch {
      // Chrome might not be running — that's fine
    }
  } else if (platform === "linux") {
    try {
      execSync("pkill -TERM -f 'google-chrome|chromium'", { timeout: 5000 });
    } catch { /* not running */ }
  } else if (platform === "win32") {
    try {
      execSync("taskkill /IM chrome.exe /F", { timeout: 5000 });
    } catch { /* not running */ }
  }

  // Step 2: Wait for Chrome to fully exit
  const exitStart = Date.now();
  while (Date.now() - exitStart < 8000) {
    try {
      if (platform === "darwin") {
        const result = execSync("pgrep -f 'Google Chrome'", { encoding: "utf-8" }).trim();
        if (!result) break;
      } else if (platform === "linux") {
        const result = execSync("pgrep -f 'google-chrome|chromium'", { encoding: "utf-8" }).trim();
        if (!result) break;
      } else {
        break; // Windows taskkill is synchronous
      }
    } catch {
      break; // pgrep returns non-zero when no matches — Chrome is gone
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 3: Relaunch Chrome with CDP flag
  // Use 'open' on macOS to launch properly as a GUI app, or spawn directly on Linux
  if (platform === "darwin") {
    // 'open -a' with --args passes flags to Chrome
    // We use spawn (detached) so it doesn't block or die with our process
    const child = spawn("open", [
      "-a", "Google Chrome",
      "--args",
      `--remote-debugging-port=${port}`,
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    const child = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // Step 4: Wait for CDP to become available
  const ready = await waitForCDP(`http://localhost:${port}`, 15000);
  if (!ready) {
    throw new Error(
      `Chrome relaunched but CDP endpoint not responding on port ${port} after 15s. ` +
      "Chrome may still be loading — try calling spatial_connect_cdp again in a few seconds."
    );
  }
}

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
  private cdpConnected: boolean = false;

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
  async connectCDP(cdpUrl: string = "http://localhost:9222"): Promise<{
    pages: number;
    contexts: number;
    url: string | null;
    restarted: boolean;
  }> {
    // Close any existing session first
    if (this.browser || this.page) {
      await this.close();
    }

    let restarted = false;

    // Step 1: Try connecting directly — maybe Chrome already has CDP open
    const alreadyReady = await checkCDP(cdpUrl);

    if (!alreadyReady) {
      // Step 2: Chrome isn't listening on CDP — restart it with the flag
      const parsed = new URL(cdpUrl);
      const port = parseInt(parsed.port, 10) || 9222;
      console.error(`CDP not available at ${cdpUrl} — restarting Chrome with --remote-debugging-port=${port}...`);
      await restartChromeWithCDP(port);
      restarted = true;
    }

    // Step 3: Connect via CDP
    this.browser = await chromium.connectOverCDP(cdpUrl);
    this.cdpConnected = true;

    const contexts = this.browser.contexts();
    if (contexts.length > 0) {
      this.context = contexts[0];
      const pages = this.context.pages();
      if (pages.length > 0) {
        // Grab the first page (usually the active tab)
        this.page = pages[0];
      }
    }

    // Store config so getPage() knows we're in attach mode
    this.config = {
      browserMode: "attach",
      viewportWidth: 1280,
      viewportHeight: 720,
      zoom: 1,
      cdpUrl,
    };

    return {
      pages: this.context?.pages().length ?? 0,
      contexts: contexts.length,
      url: this.page?.url() ?? null,
      restarted,
    };
  }

  /**
   * Whether we're connected to an external Chrome via CDP.
   * When true, spatial_snapshot should navigate on the existing page
   * instead of trying to launch a new browser.
   */
  isCDPConnected(): boolean {
    return this.cdpConnected && this.browser !== null;
  }

  async getPage(config: SessionConfig): Promise<Page> {
    // If we're CDP-connected, reuse the existing page — don't launch a new browser.
    // The config will say "stealth" (default from spatial_snapshot) but we want
    // to stay on the CDP connection.
    if (this.cdpConnected && this.page) {
      return this.page;
    }

    if (this.page && this.config && !this.configMatches(config)) {
      await this.close();
    }
    // Check if existing page is still alive — Chrome may have crashed
    if (this.page) {
      try {
        if (this.page.isClosed()) {
          console.error("Chrome page was closed unexpectedly — reconnecting...");
          await this.close();
        } else {
          return this.page;
        }
      } catch {
        console.error("Chrome page unreachable — reconnecting...");
        await this.close();
      }
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
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      reducedMotion: "reduce" as const,
    };

    // Clean up stale Chrome locks before launching — prevents crash
    // when Chrome was previously killed without clean shutdown
    cleanStaleChromelocks(profileDir);

    // Retry Chrome launch with exponential backoff (1s, 2s, 4s)
    // Handles transient failures on memory-constrained systems
    const MAX_RETRIES = 3;
    const launchBrowser = async () => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          switch (config.browserMode) {
            case "bundled":
              this.context = await chromium.launchPersistentContext(profileDir, {
                headless: false,
                args: stealthArgs,
                ignoreDefaultArgs: ["--enable-automation"],
                ...contextOpts,
              });
              this.browser = this.context.browser();
              return;

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
              return;

            default:
              return; // attach mode handled separately
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_RETRIES) {
            const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
            console.error(`Chrome launch failed (attempt ${attempt}/${MAX_RETRIES}): ${msg}. Retrying in ${backoffMs}ms...`);
            cleanStaleChromelocks(profileDir);
            await new Promise(r => setTimeout(r, backoffMs));
          } else {
            throw new Error(`Chrome failed to launch after ${MAX_RETRIES} attempts: ${msg}`);
          }
        }
      }
    };

    switch (config.browserMode) {
      case "bundled":
      case "stealth":
        await launchBrowser();
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

  getCurrentContext(): BrowserContext | null {
    return this.context;
  }

  getCurrentConfig(): SessionConfig | null {
    return this.config;
  }

  /**
   * Import cookies into the browser context.
   * Accepts Playwright-format cookies (name, value, domain, path, etc.)
   * Use this to warm up sessions with cookies from the user's real browser,
   * allowing NeoVision to bypass anti-bot systems like DataDome/Cloudflare
   * that require established session history.
   */
  async importCookies(cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>): Promise<number> {
    if (!this.context) {
      throw new Error("No browser context — call getPage() first to start a session");
    }
    // Normalize cookies for Playwright
    const normalized = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.expires || -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || "Lax" as const,
    }));
    await this.context.addCookies(normalized);
    return normalized.length;
  }

  /**
   * Export all cookies from the current browser context.
   * Useful for saving session state.
   */
  async exportCookies(domains?: string[]): Promise<any[]> {
    if (!this.context) {
      throw new Error("No browser context — call getPage() first to start a session");
    }
    let cookies = await this.context.cookies();
    if (domains && domains.length > 0) {
      cookies = cookies.filter(c =>
        domains.some(d => c.domain.includes(d))
      );
    }
    return cookies;
  }

  async close(): Promise<void> {
    // In CDP mode, don't close pages or the browser — that's the user's Chrome!
    // Just disconnect Playwright's CDP handle.
    if (this.cdpConnected) {
      if (this.browser) {
        try { await this.browser.close(); } catch { /* ignore — disconnects CDP */ }
      }
      this.browser = null;
      this.context = null;
      this.page = null;
      this.config = null;
      this.cdpConnected = false;
      return;
    }

    if (this.page) {
      try { await this.page.close(); } catch { /* ignore */ }
      this.page = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
    if (this.browser) {
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
