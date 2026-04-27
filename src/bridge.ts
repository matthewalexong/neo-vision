/**
 * NeoVision Bridge — WebSocket server that connects the MCP server
 * to the Chrome extension.
 *
 * Architecture:
 *   AI Agent ←→ MCP Server ←→ WebSocket Bridge ←→ Chrome Extension ←→ Real Browser
 *
 * The bridge:
 * 1. Starts a WebSocket server on port 7665
 * 2. Waits for the Chrome extension to connect
 * 3. Receives commands from MCP tools
 * 4. Forwards them to the extension
 * 5. Returns results back to the MCP tool caller
 */

import { WebSocketServer, WebSocket } from "ws";
import { INJECTABLE_SOURCE, getInjectableScript } from "./injectable.js";
import { spawn } from "child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

// Where extension-forwarded log messages get written.
const EXTENSION_LOG_PATH = join(homedir(), ".neo-vision", "logs", "extension.log");
function appendExtensionLog(line: string): void {
  try {
    mkdirSync(dirname(EXTENSION_LOG_PATH), { recursive: true });
    appendFileSync(EXTENSION_LOG_PATH, line + "\n", "utf8");
  } catch {
    // Last-ditch — don't crash the daemon over a log write failure.
  }
}

export interface BridgeConfig {
  port?: number;
  /** Milliseconds to wait for a new connection to identify itself (default: 10000) */
  identifyTimeoutMs?: number;
  /** Milliseconds between heartbeat pings to the extension (default: 15000). 0 disables. */
  heartbeatIntervalMs?: number;
  /** How many consecutive missed pongs before declaring the connection dead (default: 2) */
  heartbeatMaxMissed?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export class ChromeBridge {
  private wss: WebSocketServer | null = null;
  private extension: WebSocket | null = null;
  private externalClients = new Set<WebSocket>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private port: number;
  private _ready = false;
  private chromeProcess: ReturnType<typeof spawn> | null = null;
  private autoLaunching = false;
  private extensionPath: string;
  _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  // Self-healing reconnect: never give up, exponential backoff capped at 30s.
  // The previous fixed cap of 3 attempts caused the daemon to enter a permanent
  // dead state after a few transient extension disconnects (which happen
  // routinely when MV3 service workers are recycled).
  private static readonly RECONNECT_BASE_DELAY_MS = 1_000;
  private static readonly RECONNECT_MAX_DELAY_MS = 30_000;

  /** SHA-256 hash of the on-disk extension files. Used to detect when the
   * running extension is out of date relative to the daemon's source. */
  private expectedBuildHash: string;

  constructor(config: BridgeConfig = {}) {
    this.port = config.port || 7665;
    // Resolve extension path relative to this file's location (src/ or dist/)
    const thisDir = typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    this.extensionPath = resolve(thisDir, "..", "extension");
    this.expectedBuildHash = this.computeExtensionHash();
  }

  /**
   * Ask the extension for its build hash; if it differs from the on-disk
   * hash, push reload_self. Tolerates older extensions that don't know
   * about `fingerprint` — those get reload_self anyway.
   */
  private async checkAndReloadIfStale(): Promise<void> {
    try {
      // 15s timeout — MV3 service workers can take 4-8s to spin up cold,
      // especially when the daemon respawns mid-session. Anything shorter
      // misclassifies a healthy SW as a zombie and triggers unnecessary
      // force-close cycles.
      const resp = await this.send("fingerprint", {}, 15000);
      if (resp && resp.success && typeof resp.build === "string") {
        if (resp.build === this.expectedBuildHash) {
          console.error(`[NeoVision Bridge] Extension is up-to-date (build ${resp.build}).`);
          return;
        }
        console.error(`[NeoVision Bridge] Extension build mismatch — running ${resp.build}, expected ${this.expectedBuildHash}. Pushing reload_self.`);
      } else {
        console.error(`[NeoVision Bridge] Extension does not support fingerprint — assuming stale. Pushing reload_self.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Unknown command: fingerprint" → ancient extension. Push reload anyway.
      if (/unknown command/i.test(msg)) {
        console.error("[NeoVision Bridge] Extension is too old to report fingerprint — pushing reload_self.");
      } else if (/timed out|timeout/i.test(msg)) {
        // Timeout = service worker is zombie (alive in TCP terms but its content
        // script isn't dispatching commands). Force-close the WebSocket so the
        // extension's MV3 alarm-based selfHeal() reconnects with a fresh SW.
        // Previously we just `return`-ed here and entered an infinite reconnect
        // loop where every command timed out. (See zombie-extension incident
        // 2026-04-27.)
        console.error(`[NeoVision Bridge] fingerprint timed out — likely zombie service worker. Force-closing to trigger reconnect.`);
        if (this.extension && this.extension.readyState === 1) {
          this.extension.close(4002, "Fingerprint timeout — forcing fresh reconnect");
        }
        return;
      } else {
        console.error(`[NeoVision Bridge] fingerprint check failed: ${msg}. Skipping auto-reload.`);
        return;
      }
    }
    // Push reload_self. The extension will chrome.runtime.reload() and reconnect
    // on the new code. The infinite-retry reconnect handler picks it back up.
    try {
      await this.send("reload_self", {}, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/unknown command|disconnected/i.test(msg)) {
        console.error(`[NeoVision Bridge] reload_self push failed: ${msg}`);
      }
      // If reload_self isn't supported either, the user has to do it manually
      // ONCE more at chrome://extensions to get the bootstrap code that
      // includes both fingerprint and reload_self handlers.
    }
  }

  /**
   * SHA-256 of the concatenated extension source files. Used to detect when
   * the extension running in Chrome is out of sync with the on-disk code.
   *
   * The extension computes the same hash on its side (via fetch +
   * SubtleCrypto over the same files). When the daemon receives a hash
   * mismatch on the `fingerprint` command response, it pushes `reload_self`
   * to the extension, which calls chrome.runtime.reload() to pick up the
   * new code from disk. No manual chrome://extensions reload required.
   */
  private computeExtensionHash(): string {
    const files = ["background.js", "spatial-snapshot.js", "offscreen.js", "manifest.json"];
    const h = createHash("sha256");
    for (const f of files) {
      try {
        h.update(readFileSync(join(this.extensionPath, f), "utf8"));
      } catch {
        // missing file is fine — just hash what we have
      }
    }
    return h.digest("hex").slice(0, 16); // short prefix is enough; truly unique for our purposes
  }

  /**
   * Auto-launch Chrome with the NeoVision Bridge extension loaded.
   * Called automatically when bridge tools are used but no extension is connected.
   * Uses --load-extension to inject the extension without manual setup.
   */
  async autoLaunchChrome(): Promise<void> {
    if (this.autoLaunching) return; // prevent concurrent launches
    if (this.ready) return; // already connected

    this.autoLaunching = true;
    try {
      if (!existsSync(this.extensionPath)) {
        throw new Error(`Extension not found at ${this.extensionPath}`);
      }

      // Find Chrome binary (macOS, Linux, Windows)
      const chromePaths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];

      let chromeBin: string | null = null;
      for (const p of chromePaths) {
        if (existsSync(p)) { chromeBin = p; break; }
      }
      if (!chromeBin) {
        throw new Error("Chrome not found. Install Google Chrome to use bridge tools.");
      }

      // Launch Chrome with the user's DEFAULT profile (real cookies, logins, history).
      //
      // IMPORTANT: Google Chrome silently ignores `--load-extension` (logs:
      // "--load-extension is not allowed in Google Chrome, ignoring."). This
      // is by Google's policy and applies to BOTH the default profile and any
      // dedicated --user-data-dir profile. The flag is kept here for two
      // reasons:
      //   1. It works in Chromium/Canary/Dev/Beta channels.
      //   2. It signals intent — the extension path is documented in the
      //      command line for setup tools (see scripts/install.sh).
      //
      // For Google Chrome stable, the user must INSTALL the extension once
      // manually at chrome://extensions (Load unpacked → select extension/).
      // After that, updates auto-deploy via the `reload_self` WebSocket
      // command — the daemon hashes background.js + spatial-snapshot.js on
      // every startup, sends the hash on the hello message, and the extension
      // calls chrome.runtime.reload() if its stored hash differs.
      console.error(`[NeoVision Bridge] Auto-launching Chrome with extension...`);
      console.error(`[NeoVision Bridge]   Chrome: ${chromeBin}`);
      console.error(`[NeoVision Bridge]   Extension: ${this.extensionPath}`);

      this.chromeProcess = spawn(chromeBin, [
        `--load-extension=${this.extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ], {
        detached: true,
        stdio: "ignore",
      });

      // Don't let the Chrome process prevent Node from exiting
      this.chromeProcess.unref();

      this.chromeProcess.on("error", (err) => {
        console.error(`[NeoVision Bridge] Chrome launch failed:`, err);
      });

      // Wait for extension to connect (up to 20 seconds — default profile may take longer to load)
      const connected = await this.waitForExtension(20000);
      if (!connected) {
        throw new Error(
          "Chrome launched but extension did not connect within 20 seconds. " +
          "If Chrome was already running, the extension may need to be reloaded at chrome://extensions."
        );
      }

      console.error(`[NeoVision Bridge] Chrome extension connected (real Chrome profile).`);
    } finally {
      this.autoLaunching = false;
    }
  }

  /** Wait for the Chrome extension to connect via WebSocket */
  private waitForExtension(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);

    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.ready) {
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  /**
   * Ensure the extension is connected.
   *
   * Default behavior: if the extension isn't connected, return an error
   * telling the caller to open Chrome themselves. The daemon happily sits
   * idle on its WebSocket port; the extension's offscreen.js scans
   * 7665-7674 and reconnects automatically the moment Chrome reopens with
   * the extension loaded.
   *
   * Opt-in auto-launch: set env var NEO_VISION_AUTO_LAUNCH_CHROME=1 to
   * restore the legacy behavior of spawning a blank Chrome window if the
   * extension isn't connected when a tool is called.
   *
   * Why opt-in: closing Chrome and having the daemon pop a blank Chrome
   * a second later is confusing — the daemon shouldn't second-guess the
   * user's deliberate quit. (See user-feedback 2026-04-27.)
   */
  async ensureConnected(): Promise<void> {
    if (this.ready) return;

    // Start WebSocket server if not already running
    if (!this.wss) {
      await this.start();
      // Give extension a moment to auto-reconnect (it retries every 5s)
      const quickConnect = await this.waitForExtension(8000);
      if (quickConnect) return;
    }

    const autoLaunch = process.env.NEO_VISION_AUTO_LAUNCH_CHROME === "1";
    if (autoLaunch) {
      await this.autoLaunchChrome();
    }

    if (!this.ready) {
      throw new Error(
        autoLaunch
          ? "Could not connect to Chrome extension. Make sure Chrome is installed and the NeoVision extension folder exists."
          : "Chrome extension not connected. Open Chrome (with the NeoVision extension loaded) and the daemon will reconnect automatically. To enable legacy auto-launch, set NEO_VISION_AUTO_LAUNCH_CHROME=1."
      );
    }
  }

  /** Start the WebSocket server, trying multiple ports if the default is busy */
  async start(): Promise<void> {
    const maxPortAttempts = 10; // Try ports 7665–7674
    for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
      const port = this.port + attempt;
      try {
        await this._startOnPort(port);
        this.port = port; // Update to the port that actually worked
        return;
      } catch (err: any) {
        if (err.code === "EADDRINUSE" && attempt < maxPortAttempts - 1) {
          console.error(`[NeoVision Bridge] Port ${port} in use, trying ${port + 1}...`);
          continue;
        }
        throw err;
      }
    }
  }

  /** Try to start WebSocket server on a specific port */
  private _startOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port });

      wss.on("listening", () => {
        this.wss = wss;
        this._attachWssHandlers();
        console.error(`[NeoVision Bridge] WebSocket server listening on port ${port}`);
        resolve();
      });

      wss.on("error", (err) => {
        wss.close();
        reject(err);
      });
    });
  }

  /** Attach connection/message handlers to the active WebSocket server */
  private _attachWssHandlers(): void {
    if (!this.wss) return;

      this.wss.on("connection", (ws) => {
        // New connection — we don't know yet if it's the extension or an
        // external client (Python script, etc.). We wait for the first
        // message to decide. The extension sends a "hello"; external
        // clients send command messages.
        //
        // BUG FIX: Chrome's main browser process (NetworkService) sometimes
        // opens a WebSocket to localhost:7665 but never sends any data.
        // This stale connection would block the real extension from being
        // recognized. We set a 10-second identification timeout — any
        // connection that doesn't send a valid message gets closed.
        let identified = false;

        const identifyTimeout = setTimeout(() => {
          if (!identified) {
            console.error("[NeoVision Bridge] Closing unidentified connection (no hello/command within 10s)");
            ws.close(4000, "Identification timeout — not a NeoVision client");
          }
        }, 10000);

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());

            // Identify as extension if it sends a hello
            if (!identified && msg.type === "hello") {
              identified = true;
              clearTimeout(identifyTimeout);
              // If another WebSocket was previously the extension, close it
              // (handles reconnect scenarios cleanly)
              if (this.extension && this.extension !== ws && this.extension.readyState === WebSocket.OPEN) {
                console.error("[NeoVision Bridge] Replacing stale extension connection with new one");
                this.extension.close(4001, "Replaced by new extension connection");
              }
              this.extension = ws;
              this._ready = true;
              console.error(`[NeoVision Bridge] Extension identified: ${msg.agent} v${msg.version}`);
              // Start heartbeat watchdog — closes zombie WS if no heartbeat for 45s.
              this.startHeartbeatWatchdog();
              // Auto-update check: if the extension's running code differs
              // from the on-disk code, push reload_self so it re-reads from
              // the unpacked extension folder.
              this.checkAndReloadIfStale().catch((err) => {
                console.error("[NeoVision Bridge] Auto-update check failed:", err);
              });
              return;
            }

            // If this IS the extension, handle its responses to pending requests
            if (ws === this.extension) {
              this.handleExtensionMessage(msg);
              return;
            }

            // Otherwise, this is an external client sending a command.
            // Relay it to the extension and route the response back.
            if (!identified) {
              identified = true;
              clearTimeout(identifyTimeout);
              this.externalClients.add(ws);
              console.error(`[NeoVision Bridge] External client connected`);
            }
            this.relayToExtension(ws, msg);
          } catch (err) {
            console.error("[NeoVision Bridge] Bad message:", err);
          }
        });

        ws.on("close", () => {
          clearTimeout(identifyTimeout);
          if (ws === this.extension) {
            this.extension = null;
            this._ready = false;
            this._handleExtensionDisconnect();
          } else {
            this.externalClients.delete(ws);
            console.error("[NeoVision Bridge] External client disconnected");
          }
        });
      });
  }  // end _attachWssHandlers

  /** Relay a command from an external client to the extension, then route the response back */
  private relayToExtension(clientWs: WebSocket, msg: any) {
    if (!this.ready) {
      clientWs.send(JSON.stringify({ id: msg.id, type: "error", error: "Extension not connected" }));
      return;
    }

    const originalId = msg.id;

    // Set up a pending request that routes the response back to the external client
    const timer = setTimeout(() => {
      this.pendingRequests.delete(originalId);
      clientWs.send(JSON.stringify({ id: originalId, type: "error", error: "Timeout" }));
    }, 60000);

    this.pendingRequests.set(originalId, {
      resolve: (result: any) => {
        clientWs.send(JSON.stringify({ id: originalId, type: "result", result }));
      },
      reject: (err: any) => {
        clientWs.send(JSON.stringify({ id: originalId, type: "error", error: err.message || String(err) }));
      },
      timer,
    });

    // Forward the command to the extension
    this.extension!.send(JSON.stringify(msg));
  }

  /** Check if the extension is connected */
  get ready(): boolean {
    return this._ready && this.extension !== null && this.extension.readyState === WebSocket.OPEN;
  }

  getStatus(): { bridge: boolean; extension: boolean; port: number } {
    return {
      bridge: true,
      extension: this.ready,
      port: this.port,
    };
  }

  /** Send a command to the extension and wait for a response.
   *  Automatically launches Chrome with the extension if not connected. */
  async send(command: string, params: Record<string, any> = {}, timeoutMs = 60000): Promise<any> {
    // Auto-connect: launch Chrome with extension if not connected
    await this.ensureConnected();

    const id = `req_${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.extension!.send(JSON.stringify({ id, command, params }));
    });
  }

  /** Handle a response from the extension (could be for an MCP tool or an external client relay) */
  private handleExtensionMessage(msg: any) {
    // Track heartbeats from offscreen.js (every ~15s). Used by the watchdog to
    // detect zombie state where the WebSocket is alive but the SW has been
    // recycled and isn't dispatching commands.
    if (msg && msg.type === "heartbeat") {
      this._lastHeartbeatAt = Date.now();
      return;
    }

    // Forwarded log lines from the extension. Persisted to extension.log so
    // the user can grep for issues without having to open chrome://extensions
    // and click into the service worker devtools console. Until this existed,
    // most extension errors were invisible because the SW console isn't
    // visible by default and several catch blocks swallowed errors silently.
    if (msg && msg.type === "log") {
      const ts = new Date().toISOString();
      const level = (msg.level || "info").toUpperCase();
      const ctx = msg.ctx ? ` ${JSON.stringify(msg.ctx)}` : "";
      const src = msg.src ? ` [${msg.src}]` : "";
      appendExtensionLog(`[${ts}] [${level}]${src} ${msg.msg || ""}${ctx}`);
      return;
    }

    // Response to a pending request (from MCP tools or relayed external clients)
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const req = this.pendingRequests.get(msg.id)!;
      clearTimeout(req.timer);
      this.pendingRequests.delete(msg.id);

      if (msg.type === "error") {
        req.reject(new Error(msg.error));
      } else {
        req.resolve(msg.result);
      }
    }
  }

  // ─── Heartbeat watchdog ──────────────────────────────────────
  // The extension's offscreen.js sends {type:'heartbeat'} every 15s while the
  // WebSocket is healthy. If we stop seeing them while we still think the
  // extension is connected, the connection is zombie — close it so the
  // extension's MV3 alarm-based selfHeal() picks up with a fresh SW.
  private _lastHeartbeatAt = 0;
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WATCHDOG_INTERVAL_MS = 15_000;
  private static readonly WATCHDOG_MAX_GAP_MS = 45_000; // 3 missed heartbeats

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    this._lastHeartbeatAt = Date.now(); // grace period on connect
    this._watchdogTimer = setInterval(() => {
      if (!this.extension || this.extension.readyState !== 1) return;
      const gap = Date.now() - this._lastHeartbeatAt;
      if (gap > ChromeBridge.WATCHDOG_MAX_GAP_MS) {
        console.error(`[NeoVision Bridge] No heartbeat for ${Math.round(gap/1000)}s — assuming zombie SW. Force-closing to reconnect.`);
        try { this.extension.close(4003, "Heartbeat watchdog timeout"); } catch {}
        this._lastHeartbeatAt = Date.now(); // reset to avoid spam-closing
      }
    }, ChromeBridge.WATCHDOG_INTERVAL_MS);
  }

  private stopHeartbeatWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ─── High-level commands ──────────────────────────────────────

  /** Navigate to a URL */
  async navigate(url: string, tabId?: number): Promise<{ url: string; title: string }> {
    return this.send("navigate", tabId !== undefined ? { url, tabId } : { url });
  }

  /**
   * Execute JavaScript in the page.
   *
   * @param code        JS expression to evaluate. The expression's value is returned.
   * @param world       'isolated' (default, CSP-safe, no page-world vars)
   *                  | 'main' (page world, has page vars, fails on CSP-strict sites)
   * @param tabId       Target tab. Defaults to the managed NeoVision tab.
   */
  async executeJs(
    code: string,
    world: "isolated" | "main" = "isolated",
    tabId?: number
  ): Promise<any> {
    return this.send("execute_js", { code, world, tabId });
  }

  /**
   * Inject the NeoVision spatial snapshot and return the spatial map.
   *
   * The extension now loads the snapshot from a bundled file (CSP-safe),
   * so we just pass structured options. The legacy `injectable_source`
   * field is kept for older extension builds that still expect it.
   */
  async injectSpatial(options?: { verbosity?: string; maxDepth?: number; includeNonVisible?: boolean }, tabId?: number): Promise<any> {
    const snapshot_options = {
      verbosity: options?.verbosity || "actionable",
      maxDepth: options?.maxDepth || 50,
      includeNonVisible: options?.includeNonVisible || false,
    };
    // Legacy fallback — older extension versions read `injectable_source`.
    // New extension ignores it and uses extension/spatial-snapshot.js.
    const legacy_source = getInjectableScript(snapshot_options as any);
    return this.send("inject_spatial", {
      snapshot_options,
      injectable_source: legacy_source,
      tabId,
    });
  }

  /**
   * Get Chrome window geometry needed to convert page CSS coordinates
   * into screen pixel coordinates for OS-level input dispatch (cliclick).
   *
   * Returns:
   *   - window: { left, top, width, height, state, focused }
   *   - viewport: { width, height }  (page innerWidth/innerHeight)
   *   - chrome_offset: { x, y }       (vertical = tabs+address bar height)
   *   - scroll: { x, y }
   *   - device_pixel_ratio: number
   */
  async getWindowGeometry(tabId?: number): Promise<{
    window: { left: number; top: number; width: number; height: number; state?: string; focused?: boolean };
    viewport: { width: number; height: number };
    chrome_offset: { x: number; y: number };
    scroll: { x: number; y: number };
    device_pixel_ratio: number;
  }> {
    return this.send("get_window_geometry", { tabId });
  }

  /** Click at coordinates */
  async click(x: number, y: number, button: "left" | "right" = "left", tabId?: number): Promise<any> {
    return this.send("click", { x, y, button, tabId });
  }

  /** Type text at coordinates */
  async type(x: number, y: number, text: string, clearFirst = false, tabId?: number): Promise<any> {
    return this.send("type", { x, y, text, clearFirst, tabId });
  }

  /** Scroll at coordinates */
  async scroll(deltaX: number, deltaY: number, x = 640, y = 360, tabId?: number): Promise<any> {
    return this.send("scroll", { x, y, deltaX, deltaY, tabId });
  }

  /** Wait for a number of seconds */
  async wait(seconds: number): Promise<any> {
    return this.send("wait", { seconds });
  }

  /** Take a screenshot */
  async screenshot(tabId?: number): Promise<any> {
    return this.send("screenshot", { tabId });
  }

  /** Get page info */
  async getPageInfo(tabId?: number): Promise<any> {
    return this.send("get_page_info", { tabId });
  }

  /** Get page text content */
  async getPageText(tabId?: number): Promise<any> {
    return this.send("get_page_text", { tabId });
  }

  /** Handle extension disconnect: reject pending requests and schedule reconnect.
   *
   * Uses exponential backoff capped at 30s with NO maximum attempt limit.
   * Rationale: MV3 service workers are aggressively recycled by Chrome, which
   * causes the offscreen WebSocket to drop intermittently. Giving up after a
   * fixed number of attempts leaves the daemon in a dead state requiring
   * manual user intervention. Infinite retry with backoff is the only sane
   * default for an always-on local daemon.
   */
  _handleExtensionDisconnect(): void {
    console.error("[NeoVision Bridge] Chrome extension disconnected");

    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error("Extension disconnected"));
    }
    this.pendingRequests.clear();

    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s...
    // This gives the extension time to recover from transient SW recycles
    // without burning CPU spinning, while still recovering quickly from
    // brief outages.
    const delay = Math.min(
      ChromeBridge.RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(this._reconnectAttempts, 5)),
      ChromeBridge.RECONNECT_MAX_DELAY_MS
    );

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.ready) {
        this._reconnectAttempts = 0; // recovered on its own
        return;
      }
      this._reconnectAttempts++;
      console.error(
        `[NeoVision Bridge] Reconnect attempt ${this._reconnectAttempts} (next backoff if it fails: ${Math.min(ChromeBridge.RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.min(this._reconnectAttempts, 5)), ChromeBridge.RECONNECT_MAX_DELAY_MS) / 1000}s)...`
      );
      try {
        // First check if the extension is just temporarily down — give it a
        // brief moment to reconnect on its own before relaunching Chrome.
        const naturalRecovery = await this.waitForExtension(2000);
        if (naturalRecovery) {
          this._reconnectAttempts = 0;
          console.error("[NeoVision Bridge] Extension reconnected on its own — no Chrome relaunch needed.");
          return;
        }
        // Still not connected; relaunch Chrome (which loads the extension).
        await this.autoLaunchChrome();
        if (this.ready) {
          this._reconnectAttempts = 0;
          console.error("[NeoVision Bridge] Reconnect succeeded.");
        } else {
          // Schedule another attempt — autoLaunchChrome may have hit the
          // 20s wait timeout but the extension could still appear shortly.
          this._handleExtensionDisconnect();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[NeoVision Bridge] Reconnect failed: ${msg}. Will retry with backoff.`);
        // Schedule the next attempt — never give up.
        this._handleExtensionDisconnect();
      }
    }, delay);
  }

  /** Stop the bridge server and any auto-launched Chrome */
  async stop() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.extension) this.extension.close();
    if (this.wss) this.wss.close();
    this._ready = false;
    this.chromeProcess = null;
  }
}
