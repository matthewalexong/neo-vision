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
import { existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

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
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_DELAY_MS = 10_000;

  constructor(config: BridgeConfig = {}) {
    this.port = config.port || 7665;
    // Resolve extension path relative to this file's location (src/ or dist/)
    const thisDir = typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    this.extensionPath = resolve(thisDir, "..", "extension");
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
      // --load-extension injects NeoVision into the session.
      // If Chrome is already running, this opens a new window in the existing instance
      // and the extension (if already installed) should connect.
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
   * Ensure the extension is connected, auto-launching Chrome if needed.
   * This is the main entry point for bridge tools — call this before any command.
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

    // Try auto-launching Chrome with the extension
    await this.autoLaunchChrome();

    if (!this.ready) {
      throw new Error(
        "Could not connect to Chrome extension. " +
        "Make sure Chrome is installed and the NeoVision extension folder exists."
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

  // ─── High-level commands ──────────────────────────────────────

  /** Navigate to a URL */
  async navigate(url: string): Promise<{ url: string; title: string }> {
    return this.send("navigate", { url });
  }

  /** Execute JavaScript in the page context */
  async executeJs(code: string, tabId?: number): Promise<any> {
    return this.send("execute_js", { code, tabId });
  }

  /** Inject the NeoVision spatial snapshot and return the spatial map */
  async injectSpatial(options?: { verbosity?: string; maxDepth?: number; includeNonVisible?: boolean }, tabId?: number): Promise<any> {
    const script = getInjectableScript({
      verbosity: (options?.verbosity as any) || "actionable",
      maxDepth: options?.maxDepth || 50,
      includeNonVisible: options?.includeNonVisible || false,
    });
    return this.send("inject_spatial", { injectable_source: script, tabId });
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

  /** Handle extension disconnect: reject pending requests and schedule reconnect */
  _handleExtensionDisconnect(): void {
    console.error("[NeoVision Bridge] Chrome extension disconnected");

    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error("Extension disconnected"));
    }
    this.pendingRequests.clear();

    if (this._reconnectAttempts >= ChromeBridge.MAX_RECONNECT_ATTEMPTS) {
      console.error("[NeoVision Bridge] Max reconnect attempts reached — giving up.");
      return;
    }

    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.ready) return; // reconnected on its own
      this._reconnectAttempts++;
      console.error(
        `[NeoVision Bridge] Reconnect attempt ${this._reconnectAttempts}/${ChromeBridge.MAX_RECONNECT_ATTEMPTS}...`
      );
      try {
        await this.autoLaunchChrome();
        if (this.ready) this._reconnectAttempts = 0; // reset on success
      } catch (err) {
        console.error("[NeoVision Bridge] Reconnect failed:", err);
      }
    }, ChromeBridge.RECONNECT_DELAY_MS);
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
