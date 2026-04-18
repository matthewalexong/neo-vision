/**
 * NeoVision HTTP API — The spoke interface for bots and external clients.
 *
 * Architecture:
 *   Bot/Agent → HTTP POST → HttpApi → RequestQueue → ChromeBridge → Extension → Chrome
 *
 * Stateless: clients send a request, get a response, done. No persistent
 * connections to maintain. The queue serializes everything so concurrent
 * requests from multiple bots don't step on each other.
 *
 * Uses Node built-in http module — zero external dependencies.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import type { Server } from "http";
import { ChromeBridge } from "./bridge.js";
import { RequestQueue, type QueueStats } from "./queue.js";
import { queryMap } from "./query.js";
import { getInjectableScript } from "./injectable.js";
import type { SpatialMap } from "./schema.js";

export interface HttpApiConfig {
  port?: number;
}

export class HttpApi {
  private server: Server | null = null;
  private lastSnapshot: SpatialMap | null = null;
  private port: number;

  constructor(
    private bridge: ChromeBridge,
    private queue: RequestQueue,
    port = 7680
  ) {
    this.port = port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error("[NeoVision HTTP API] Unhandled error:", err);
          this.sendJson(res, 500, { ok: false, error: "Internal server error" });
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.port, () => {
        console.error(`[NeoVision HTTP API] Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ─── Request Router ──────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers for browser-based clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || "/";

    // GET routes
    if (req.method === "GET") {
      if (url === "/api/status") return this.handleStatus(res);
      return this.sendJson(res, 404, { ok: false, error: `Unknown route: GET ${url}` });
    }

    // POST routes
    if (req.method === "POST") {
      const body = await this.readBody(req);

      switch (url) {
        case "/api/navigate":
          return this.handleNavigate(body, res);
        case "/api/snapshot":
          return this.handleSnapshot(body, res);
        case "/api/click":
          return this.handleClick(body, res);
        case "/api/type":
          return this.handleType(body, res);
        case "/api/scroll":
          return this.handleScroll(body, res);
        case "/api/execute_js":
          return this.handleExecuteJs(body, res);
        case "/api/screenshot":
          return this.handleScreenshot(res);
        case "/api/query":
          return this.handleQuery(body, res);
        default:
          return this.sendJson(res, 404, { ok: false, error: `Unknown route: POST ${url}` });
      }
    }

    this.sendJson(res, 405, { ok: false, error: `Method ${req.method} not allowed` });
  }

  // ─── Endpoint Handlers ───────────────────────────────────────────

  private async handleStatus(res: ServerResponse): Promise<void> {
    const bridgeStatus = this.bridge.getStatus();
    const queueStats = this.queue.getStats();
    this.sendJson(res, 200, {
      ok: true,
      data: {
        ...bridgeStatus,
        queue: queueStats,
        lastSnapshot: this.lastSnapshot ? {
          url: this.lastSnapshot.url,
          timestamp: this.lastSnapshot.timestamp,
          elements: this.lastSnapshot.elements?.length ?? 0,
        } : null,
      },
    });
  }

  private async handleNavigate(body: any, res: ServerResponse): Promise<void> {
    if (!body.url) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required field: url" });
    }
    try {
      const result = await this.queue.enqueue(() => this.bridge.navigate(body.url));
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleSnapshot(body: any, res: ServerResponse): Promise<void> {
    try {
      const result = await this.queue.enqueue(async () => {
        // Navigate if URL provided
        if (body.url) {
          await this.bridge.navigate(body.url);
          const settleMs = body.settle_ms || 1500;
          await this.bridge.wait(settleMs / 1000);
        }

        // Take spatial snapshot
        const snapshot = await this.bridge.injectSpatial({
          verbosity: body.verbosity || "actionable",
          maxDepth: body.max_depth || 50,
          includeNonVisible: body.include_non_visible || false,
        });

        return snapshot;
      });

      // Cache for /api/query — unwrap spatial_map if bridge returns wrapper
      const snapshot = (result as any)?.spatial_map ?? result;
      this.lastSnapshot = snapshot as SpatialMap;

      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleClick(body: any, res: ServerResponse): Promise<void> {
    if (body.x == null || body.y == null) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required fields: x, y" });
    }
    try {
      const result = await this.queue.enqueue(() =>
        this.bridge.click(body.x, body.y, body.button || "left")
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleType(body: any, res: ServerResponse): Promise<void> {
    if (!body.text) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required field: text" });
    }
    try {
      const result = await this.queue.enqueue(async () => {
        const x = body.x ?? 0;
        const y = body.y ?? 0;
        await this.bridge.type(x, y, body.text, body.clear_first || false);

        if (body.press_enter) {
          await this.bridge.executeJs(
            "document.activeElement?.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter'})); true;"
          );
        }

        return { typed: body.text, press_enter: !!body.press_enter };
      });
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleScroll(body: any, res: ServerResponse): Promise<void> {
    const deltaX = body.delta_x ?? 0;
    const deltaY = body.delta_y ?? 0;
    const x = body.x ?? 640;
    const y = body.y ?? 360;
    try {
      const result = await this.queue.enqueue(() =>
        this.bridge.scroll(deltaX, deltaY, x, y)
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleExecuteJs(body: any, res: ServerResponse): Promise<void> {
    if (!body.code) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required field: code" });
    }
    try {
      const result = await this.queue.enqueue(() =>
        this.bridge.executeJs(body.code)
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleScreenshot(res: ServerResponse): Promise<void> {
    try {
      const result = await this.queue.enqueue(() => this.bridge.screenshot());
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async handleQuery(body: any, res: ServerResponse): Promise<void> {
    if (!this.lastSnapshot) {
      return this.sendJson(res, 400, {
        ok: false,
        error: "No snapshot cached. Call POST /api/snapshot first.",
      });
    }

    try {
      const filtered = queryMap(this.lastSnapshot, {
        role: body.role,
        tag: body.tag,
        labelContains: body.label_contains,
        textContains: body.text_contains,
        region: body.region,
        actionableOnly: body.actionable_only,
      });
      this.sendJson(res, 200, { ok: true, data: filtered });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.sendJson(res, 500, { ok: false, error: msg });
  }
}
