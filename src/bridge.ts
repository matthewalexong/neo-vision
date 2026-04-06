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

export interface BridgeConfig {
  port?: number;
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

  constructor(config: BridgeConfig = {}) {
    this.port = config.port || 7665;
  }

  /** Start the WebSocket server */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("listening", () => {
        console.error(`[NeoVision Bridge] WebSocket server listening on port ${this.port}`);
        resolve();
      });

      this.wss.on("error", (err) => {
        console.error(`[NeoVision Bridge] Server error:`, err);
        reject(err);
      });

      this.wss.on("connection", (ws) => {
        // New connection — we don't know yet if it's the extension or an
        // external client (Python script, etc.). We wait for the first
        // message to decide. The extension sends a "hello"; external
        // clients send command messages.
        let identified = false;

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());

            // Identify as extension if it sends a hello
            if (!identified && msg.type === "hello") {
              identified = true;
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
              this.externalClients.add(ws);
              console.error(`[NeoVision Bridge] External client connected`);
            }
            this.relayToExtension(ws, msg);
          } catch (err) {
            console.error("[NeoVision Bridge] Bad message:", err);
          }
        });

        ws.on("close", () => {
          if (ws === this.extension) {
            console.error("[NeoVision Bridge] Chrome extension disconnected");
            this.extension = null;
            this._ready = false;
            // Reject all pending requests
            for (const [id, req] of this.pendingRequests) {
              clearTimeout(req.timer);
              req.reject(new Error("Extension disconnected"));
            }
            this.pendingRequests.clear();
          } else {
            this.externalClients.delete(ws);
            console.error("[NeoVision Bridge] External client disconnected");
          }
        });
      });
    });
  }

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

  /** Send a command to the extension and wait for a response */
  async send(command: string, params: Record<string, any> = {}, timeoutMs = 60000): Promise<any> {
    if (!this.ready) {
      throw new Error("Chrome extension not connected. Install the NeoVision Bridge extension and click Connect.");
    }

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

  /** Stop the bridge server */
  async stop() {
    if (this.extension) this.extension.close();
    if (this.wss) this.wss.close();
    this._ready = false;
  }
}
