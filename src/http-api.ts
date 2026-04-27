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
import {
  osClick,
  osType,
  pageToScreen,
  isCliclickInstalled,
  stealthGap,
  type WindowGeometry,
} from "./os-input.js";

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
        case "/api/window_geometry":
          return this.handleWindowGeometry(body, res);
        case "/api/click_os":
          return this.handleClickOs(body, res);
        case "/api/type_os":
          return this.handleTypeOs(body, res);
        case "/api/list_tabs":
          return this.handleListTabs(res);
        case "/api/spawn_tab":
          return this.handleSpawnTab(body, res);
        case "/api/close_tab":
          return this.handleCloseTab(body, res);
        case "/api/read_console_messages":
          return this.handleReadConsoleMessages(body, res);
        case "/api/read_network_requests":
          return this.handleReadNetworkRequests(body, res);
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
      const result = await this.queue.enqueue(
        () => this.bridge.navigate(body.url, body.tabId),
        60000,
        body.tabId,
      );
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
    const world = body.world === "main" ? "main" : "isolated";
    try {
      const result = await this.queue.enqueue(
        () => this.bridge.executeJs(body.code, world, body.tabId),
        60000,
        body.tabId,
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

  // ─── OS-level input (cliclick / AppleScript) ───────────────────

  private async handleWindowGeometry(_body: any, res: ServerResponse): Promise<void> {
    try {
      const geom = await this.queue.enqueue(() => this.bridge.getWindowGeometry());
      this.sendJson(res, 200, { ok: true, data: geom });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * OS-level click. Body:
   *   { x, y, button?, stealth?, synthetic?, focus_chrome? }
   *
   * x, y are PAGE CSS coordinates from a spatial_snapshot. The daemon
   * fetches current Chrome window geometry, converts to screen coords,
   * then dispatches via cliclick (real CGEvent, isTrusted=true).
   *
   * Stealth defaults: animated cursor travel + post-arrival pause +
   * coord jitter. Pass stealth=false to skip animation. Pass
   * synthetic=true to fall back to the legacy in-page MouseEvent
   * dispatch (CSP-fragile, isTrusted=false — only for edge cases).
   *
   * If cliclick is not installed, returns 503 with install instructions
   * unless synthetic=true was requested.
   */
  private async handleClickOs(body: any, res: ServerResponse): Promise<void> {
    if (body.x == null || body.y == null) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required fields: x, y" });
    }
    const useSynthetic = body.synthetic === true;
    if (!useSynthetic && !isCliclickInstalled()) {
      return this.sendJson(res, 503, {
        ok: false,
        error: "cliclick not installed. Run: brew install cliclick. Or pass { synthetic: true } to fall back to in-page MouseEvent dispatch (loses isTrusted=true).",
      });
    }
    try {
      const result = await this.queue.enqueue(async () => {
        if (useSynthetic) {
          return this.bridge.click(body.x, body.y, body.button || "left");
        }
        const geom = (await this.bridge.getWindowGeometry()) as WindowGeometry;
        const screen = pageToScreen({ x: body.x, y: body.y }, geom);
        await osClick(screen.x, screen.y, {
          stealth: body.stealth !== false,
          button: body.button || "left",
          focusChrome: body.focus_chrome !== false,
        });
        return {
          dispatched: "os",
          page: { x: body.x, y: body.y },
          screen,
          stealth: body.stealth !== false,
        };
      });
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * OS-level type. Body:
   *   { text, x?, y?, focus_first?, clear_first?, press_enter?, stealth?, synthetic? }
   *
   * If x and y are provided AND focus_first !== false, OS-clicks that
   * coordinate first to focus the field, then types via cliclick. If
   * focus is already where you want it, omit x/y.
   *
   * clear_first uses cmd+a then delete to wipe existing text before typing.
   * press_enter sends a return keystroke after the text.
   */
  private async handleTypeOs(body: any, res: ServerResponse): Promise<void> {
    if (!body.text && !body.press_enter) {
      return this.sendJson(res, 400, { ok: false, error: "Missing required field: text" });
    }
    const useSynthetic = body.synthetic === true;
    if (!useSynthetic && !isCliclickInstalled()) {
      return this.sendJson(res, 503, {
        ok: false,
        error: "cliclick not installed. Run: brew install cliclick. Or pass { synthetic: true } to use the legacy in-page dispatch.",
      });
    }
    try {
      const result = await this.queue.enqueue(async () => {
        if (useSynthetic) {
          const x = body.x ?? 0;
          const y = body.y ?? 0;
          await this.bridge.type(x, y, body.text || "", body.clear_first || false);
          if (body.press_enter) {
            await this.bridge.executeJs(
              "document.activeElement?.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter'})); true;"
            );
          }
          return { dispatched: "synthetic", typed: body.text || "" };
        }

        // Focus the target field first, if coordinates given.
        if (body.x != null && body.y != null && body.focus_first !== false) {
          const geom = (await this.bridge.getWindowGeometry()) as WindowGeometry;
          const screen = pageToScreen({ x: body.x, y: body.y }, geom);
          await osClick(screen.x, screen.y, { stealth: body.stealth !== false });
          await stealthGap(150, 350);
        }

        if (body.clear_first) {
          // Cmd+A then delete via cliclick key presses.
          // kd:cmd / ku:cmd hold/release; t:a inside types 'a' which combined
          // with cmd yields select-all. Then `kp:delete`.
          const { spawn } = await import("child_process");
          const runCli = (args: string[]) => new Promise<void>((resolve, reject) => {
            const p = spawn("cliclick", args, { stdio: ["ignore", "ignore", "pipe"] });
            p.on("error", reject);
            p.on("close", () => resolve());
          });
          await runCli(["kd:cmd"]);
          await runCli(["t:a"]);
          await runCli(["ku:cmd"]);
          await runCli(["kp:delete"]);
          await stealthGap(80, 180);
        }

        if (body.text) {
          await osType(body.text, { stealth: body.stealth !== false });
        }

        if (body.press_enter) {
          await stealthGap(150, 400);
          const { spawn } = await import("child_process");
          await new Promise<void>((resolve, reject) => {
            const p = spawn("cliclick", ["kp:return"], { stdio: ["ignore", "ignore", "pipe"] });
            p.on("error", reject);
            p.on("close", () => resolve());
          });
        }

        return {
          dispatched: "os",
          typed: body.text || "",
          press_enter: !!body.press_enter,
          stealth: body.stealth !== false,
        };
      });
      this.sendJson(res, 200, { ok: true, data: result });
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

  // ─── Tab pool endpoints ───────────────────────────────────────────

  /** GET-style POST: list all tabs the extension considers managed. */
  private async handleListTabs(res: ServerResponse): Promise<void> {
    try {
      // Goes through the global bucket since it's a meta-operation, not
      // a tab-targeted one.
      const result = await this.queue.enqueue(() => this.bridge.send("list_tabs", {}));
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /** Spawn a new tab in the dedicated NeoVision window. Returns its tabId. */
  private async handleSpawnTab(body: any, res: ServerResponse): Promise<void> {
    try {
      const result = await this.queue.enqueue(() =>
        this.bridge.send("spawn_tab", { url: body.url || "about:blank" })
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * Read recent console.* output from a tab (captured by console-capture.js
   * in the page's main world). Body: {tabId?, limit?, clear?}.
   */
  private async handleReadConsoleMessages(body: any, res: ServerResponse): Promise<void> {
    try {
      const result = await this.queue.enqueue(
        () => this.bridge.send("read_console_messages", body || {}),
        15000,
        body?.tabId,
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /**
   * Read recent network request lifecycle entries from a tab (captured via
   * chrome.webRequest). Body: {tabId?, limit?, clear?, urlPattern?, errorsOnly?}.
   */
  private async handleReadNetworkRequests(body: any, res: ServerResponse): Promise<void> {
    try {
      const result = await this.queue.enqueue(
        () => this.bridge.send("read_network_requests", body || {}),
        15000,
        body?.tabId,
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }

  /** Close a managed tab. Will not close non-NeoVision tabs (extension enforces). */
  private async handleCloseTab(body: any, res: ServerResponse): Promise<void> {
    if (typeof body.tabId !== "number") {
      return this.sendJson(res, 400, { ok: false, error: "Missing required field: tabId (number)" });
    }
    try {
      const result = await this.queue.enqueue(
        () => this.bridge.send("close_tab", { tabId: body.tabId }),
        30000,
        body.tabId,
      );
      this.sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      this.sendError(res, err);
    }
  }
}
