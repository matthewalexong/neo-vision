/**
 * NeoVision HTTP Client — Thin client that MCP server.ts uses to talk to the daemon.
 *
 * Same interface as ChromeBridge's high-level methods, but implemented as
 * HTTP POSTs to the daemon's API at localhost:7680.
 *
 * Stateless: every call is an independent HTTP request. No WebSocket,
 * no persistent connection, nothing to keep alive.
 */

import http from "http";
import { URL } from "url";

export interface HttpClientConfig {
  daemonUrl?: string; // default "http://localhost:7680"
  timeoutMs?: number; // default 60000
}

export class HttpClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: HttpClientConfig = {}) {
    this.baseUrl = config.daemonUrl || "http://localhost:7680";
    this.timeoutMs = config.timeoutMs || 60000;
  }

  // ─── HTTP Primitives ─────────────────────────────────────────────

  private request(method: string, path: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);

      const payload = body ? JSON.stringify(body) : undefined;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: this.timeoutMs,
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            const parsed = JSON.parse(raw);
            if (parsed.ok === false) {
              reject(new Error(parsed.error || "Unknown daemon error"));
            } else {
              resolve(parsed.data);
            }
          } catch {
            reject(new Error(`Invalid JSON from daemon: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") {
          reject(new Error(
            "NeoVision daemon not running. Start it with: npx neo-vision-daemon\n" +
            "The daemon owns the Chrome extension connection. MCP server talks to it via HTTP."
          ));
        } else {
          reject(err);
        }
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request to daemon timed out after ${this.timeoutMs}ms`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  private post(path: string, body: any = {}): Promise<any> {
    return this.request("POST", path, body);
  }

  private get(path: string): Promise<any> {
    return this.request("GET", path);
  }

  // ─── High-level Commands (same interface as ChromeBridge) ────────

  async navigate(url: string): Promise<{ url: string; title: string }> {
    return this.post("/api/navigate", { url });
  }

  async injectSpatial(options?: {
    verbosity?: string;
    maxDepth?: number;
    includeNonVisible?: boolean;
  }): Promise<any> {
    return this.post("/api/snapshot", {
      verbosity: options?.verbosity,
      max_depth: options?.maxDepth,
      include_non_visible: options?.includeNonVisible,
    });
  }

  async click(x: number, y: number, button: "left" | "right" = "left"): Promise<any> {
    return this.post("/api/click", { x, y, button });
  }

  async type(x: number, y: number, text: string, clearFirst = false): Promise<any> {
    return this.post("/api/type", { x, y, text, clear_first: clearFirst });
  }

  async scroll(deltaX: number, deltaY: number, x = 640, y = 360): Promise<any> {
    return this.post("/api/scroll", { delta_x: deltaX, delta_y: deltaY, x, y });
  }

  async executeJs(code: string): Promise<any> {
    return this.post("/api/execute_js", { code });
  }

  async screenshot(): Promise<any> {
    return this.post("/api/screenshot", {});
  }

  async wait(seconds: number): Promise<void> {
    // Wait is local — no need to hit the daemon
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  async getStatus(): Promise<{
    bridge: boolean;
    extension: boolean;
    port: number;
    queue: any;
  }> {
    return this.get("/api/status");
  }

  /**
   * Check if the daemon is running and the extension is connected.
   * Throws a descriptive error if not.
   */
  async ensureConnected(): Promise<void> {
    try {
      const status = await this.getStatus();
      if (!status.extension) {
        throw new Error(
          "NeoVision daemon is running but Chrome extension is not connected. " +
          "Make sure Chrome is open with the NeoVision extension installed and enabled."
        );
      }
    } catch (err: any) {
      if (err.message?.includes("daemon not running")) {
        throw err; // Already a good error message
      }
      throw new Error(
        `Cannot reach NeoVision daemon: ${err.message}`
      );
    }
  }

  /**
   * Synchronous ready check — best-effort only.
   * For reliable checking, use ensureConnected() instead.
   */
  get ready(): boolean {
    return true; // Can't check synchronously over HTTP
  }

  /**
   * Compatibility shim — getStatus returns the same shape as ChromeBridge.getStatus()
   * plus queue stats.
   */
  async getFullStatus(): Promise<{
    bridge: boolean;
    extension: boolean;
    port: number;
    queue: any;
    lastSnapshot: any;
  }> {
    return this.get("/api/status");
  }
}
