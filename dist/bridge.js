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
import { getInjectableScript } from "./injectable.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
export class ChromeBridge {
    wss = null;
    extension = null;
    externalClients = new Set();
    pendingRequests = new Map();
    requestCounter = 0;
    port;
    _ready = false;
    chromeProcess = null;
    autoLaunching = false;
    extensionPath;
    constructor(config = {}) {
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
    async autoLaunchChrome() {
        if (this.autoLaunching)
            return; // prevent concurrent launches
        if (this.ready)
            return; // already connected
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
            let chromeBin = null;
            for (const p of chromePaths) {
                if (existsSync(p)) {
                    chromeBin = p;
                    break;
                }
            }
            if (!chromeBin) {
                throw new Error("Chrome not found. Install Google Chrome to use bridge tools.");
            }
            // Check if Chrome is already running — if so, we can't use --load-extension
            // because Chrome only allows one instance per user-data-dir.
            // Use a dedicated NeoVision profile to avoid conflicts with the user's main Chrome.
            const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
            const profileDir = join(homeDir, ".neo-vision", "bridge-profile");
            console.error(`[NeoVision Bridge] Auto-launching Chrome with extension...`);
            console.error(`[NeoVision Bridge]   Chrome: ${chromeBin}`);
            console.error(`[NeoVision Bridge]   Extension: ${this.extensionPath}`);
            this.chromeProcess = spawn(chromeBin, [
                `--load-extension=${this.extensionPath}`,
                `--user-data-dir=${profileDir}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
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
            // Wait for extension to connect (up to 15 seconds)
            const connected = await this.waitForExtension(15000);
            if (!connected) {
                throw new Error("Chrome launched but extension did not connect within 15 seconds.");
            }
            console.error(`[NeoVision Bridge] Chrome extension connected automatically.`);
        }
        finally {
            this.autoLaunching = false;
        }
    }
    /** Wait for the Chrome extension to connect via WebSocket */
    waitForExtension(timeoutMs) {
        if (this.ready)
            return Promise.resolve(true);
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (this.ready) {
                    resolve(true);
                }
                else if (Date.now() - start > timeoutMs) {
                    resolve(false);
                }
                else {
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
    async ensureConnected() {
        if (this.ready)
            return;
        // Start WebSocket server if not already running
        if (!this.wss) {
            await this.start();
            // Give extension a moment to auto-reconnect (it retries every 5s)
            const quickConnect = await this.waitForExtension(8000);
            if (quickConnect)
                return;
        }
        // Try auto-launching Chrome with the extension
        await this.autoLaunchChrome();
        if (!this.ready) {
            throw new Error("Could not connect to Chrome extension. " +
                "Make sure Chrome is installed and the NeoVision extension folder exists.");
        }
    }
    /** Start the WebSocket server */
    start() {
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
                    }
                    catch (err) {
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
                    }
                    else {
                        this.externalClients.delete(ws);
                        console.error("[NeoVision Bridge] External client disconnected");
                    }
                });
            });
        });
    }
    /** Relay a command from an external client to the extension, then route the response back */
    relayToExtension(clientWs, msg) {
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
            resolve: (result) => {
                clientWs.send(JSON.stringify({ id: originalId, type: "result", result }));
            },
            reject: (err) => {
                clientWs.send(JSON.stringify({ id: originalId, type: "error", error: err.message || String(err) }));
            },
            timer,
        });
        // Forward the command to the extension
        this.extension.send(JSON.stringify(msg));
    }
    /** Check if the extension is connected */
    get ready() {
        return this._ready && this.extension !== null && this.extension.readyState === WebSocket.OPEN;
    }
    /** Send a command to the extension and wait for a response.
     *  Automatically launches Chrome with the extension if not connected. */
    async send(command, params = {}, timeoutMs = 60000) {
        // Auto-connect: launch Chrome with extension if not connected
        await this.ensureConnected();
        const id = `req_${++this.requestCounter}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pendingRequests.set(id, { resolve, reject, timer });
            this.extension.send(JSON.stringify({ id, command, params }));
        });
    }
    /** Handle a response from the extension (could be for an MCP tool or an external client relay) */
    handleExtensionMessage(msg) {
        // Response to a pending request (from MCP tools or relayed external clients)
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const req = this.pendingRequests.get(msg.id);
            clearTimeout(req.timer);
            this.pendingRequests.delete(msg.id);
            if (msg.type === "error") {
                req.reject(new Error(msg.error));
            }
            else {
                req.resolve(msg.result);
            }
        }
    }
    // ─── High-level commands ──────────────────────────────────────
    /** Navigate to a URL */
    async navigate(url) {
        return this.send("navigate", { url });
    }
    /** Execute JavaScript in the page context */
    async executeJs(code, tabId) {
        return this.send("execute_js", { code, tabId });
    }
    /** Inject the NeoVision spatial snapshot and return the spatial map */
    async injectSpatial(options, tabId) {
        const script = getInjectableScript({
            verbosity: options?.verbosity || "actionable",
            maxDepth: options?.maxDepth || 50,
            includeNonVisible: options?.includeNonVisible || false,
        });
        return this.send("inject_spatial", { injectable_source: script, tabId });
    }
    /** Click at coordinates */
    async click(x, y, button = "left", tabId) {
        return this.send("click", { x, y, button, tabId });
    }
    /** Type text at coordinates */
    async type(x, y, text, clearFirst = false, tabId) {
        return this.send("type", { x, y, text, clearFirst, tabId });
    }
    /** Scroll at coordinates */
    async scroll(deltaX, deltaY, x = 640, y = 360, tabId) {
        return this.send("scroll", { x, y, deltaX, deltaY, tabId });
    }
    /** Wait for a number of seconds */
    async wait(seconds) {
        return this.send("wait", { seconds });
    }
    /** Take a screenshot */
    async screenshot(tabId) {
        return this.send("screenshot", { tabId });
    }
    /** Get page info */
    async getPageInfo(tabId) {
        return this.send("get_page_info", { tabId });
    }
    /** Get page text content */
    async getPageText(tabId) {
        return this.send("get_page_text", { tabId });
    }
    /** Stop the bridge server and any auto-launched Chrome */
    async stop() {
        if (this.extension)
            this.extension.close();
        if (this.wss)
            this.wss.close();
        this._ready = false;
        // Don't kill user's Chrome — they may have tabs open.
        // Just release references. Chrome stays running independently.
        this.chromeProcess = null;
    }
}
//# sourceMappingURL=bridge.js.map