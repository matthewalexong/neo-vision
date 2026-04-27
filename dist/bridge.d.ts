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
export interface BridgeConfig {
    port?: number;
    /** Milliseconds to wait for a new connection to identify itself (default: 10000) */
    identifyTimeoutMs?: number;
    /** Milliseconds between heartbeat pings to the extension (default: 15000). 0 disables. */
    heartbeatIntervalMs?: number;
    /** How many consecutive missed pongs before declaring the connection dead (default: 2) */
    heartbeatMaxMissed?: number;
}
export declare class ChromeBridge {
    private wss;
    private extension;
    private externalClients;
    private pendingRequests;
    private requestCounter;
    private port;
    private _ready;
    private chromeProcess;
    private autoLaunching;
    private extensionPath;
    _reconnectTimer: ReturnType<typeof setTimeout> | null;
    private _reconnectAttempts;
    private static readonly RECONNECT_BASE_DELAY_MS;
    private static readonly RECONNECT_MAX_DELAY_MS;
    /** SHA-256 hash of the on-disk extension files. Used to detect when the
     * running extension is out of date relative to the daemon's source. */
    private expectedBuildHash;
    constructor(config?: BridgeConfig);
    /**
     * Ask the extension for its build hash; if it differs from the on-disk
     * hash, push reload_self. Tolerates older extensions that don't know
     * about `fingerprint` — those get reload_self anyway.
     */
    private checkAndReloadIfStale;
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
    private computeExtensionHash;
    /**
     * Auto-launch Chrome with the NeoVision Bridge extension loaded.
     * Called automatically when bridge tools are used but no extension is connected.
     * Uses --load-extension to inject the extension without manual setup.
     */
    autoLaunchChrome(): Promise<void>;
    /** Wait for the Chrome extension to connect via WebSocket */
    private waitForExtension;
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
    ensureConnected(): Promise<void>;
    /** Start the WebSocket server, trying multiple ports if the default is busy */
    start(): Promise<void>;
    /** Try to start WebSocket server on a specific port */
    private _startOnPort;
    /** Attach connection/message handlers to the active WebSocket server */
    private _attachWssHandlers;
    /** Relay a command from an external client to the extension, then route the response back */
    private relayToExtension;
    /** Check if the extension is connected */
    get ready(): boolean;
    getStatus(): {
        bridge: boolean;
        extension: boolean;
        port: number;
    };
    /** Send a command to the extension and wait for a response.
     *  Automatically launches Chrome with the extension if not connected. */
    send(command: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
    /** Handle a response from the extension (could be for an MCP tool or an external client relay) */
    private handleExtensionMessage;
    private _lastHeartbeatAt;
    private _watchdogTimer;
    private static readonly WATCHDOG_INTERVAL_MS;
    private static readonly WATCHDOG_MAX_GAP_MS;
    private startHeartbeatWatchdog;
    private stopHeartbeatWatchdog;
    /** Navigate to a URL */
    navigate(url: string, tabId?: number): Promise<{
        url: string;
        title: string;
    }>;
    /**
     * Execute JavaScript in the page.
     *
     * @param code        JS expression to evaluate. The expression's value is returned.
     * @param world       'isolated' (default, CSP-safe, no page-world vars)
     *                  | 'main' (page world, has page vars, fails on CSP-strict sites)
     * @param tabId       Target tab. Defaults to the managed NeoVision tab.
     */
    executeJs(code: string, world?: "isolated" | "main", tabId?: number): Promise<any>;
    /**
     * Inject the NeoVision spatial snapshot and return the spatial map.
     *
     * The extension now loads the snapshot from a bundled file (CSP-safe),
     * so we just pass structured options. The legacy `injectable_source`
     * field is kept for older extension builds that still expect it.
     */
    injectSpatial(options?: {
        verbosity?: string;
        maxDepth?: number;
        includeNonVisible?: boolean;
    }, tabId?: number): Promise<any>;
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
    getWindowGeometry(tabId?: number): Promise<{
        window: {
            left: number;
            top: number;
            width: number;
            height: number;
            state?: string;
            focused?: boolean;
        };
        viewport: {
            width: number;
            height: number;
        };
        chrome_offset: {
            x: number;
            y: number;
        };
        scroll: {
            x: number;
            y: number;
        };
        device_pixel_ratio: number;
    }>;
    /** Click at coordinates */
    click(x: number, y: number, button?: "left" | "right", tabId?: number): Promise<any>;
    /** Type text at coordinates */
    type(x: number, y: number, text: string, clearFirst?: boolean, tabId?: number): Promise<any>;
    /** Scroll at coordinates */
    scroll(deltaX: number, deltaY: number, x?: number, y?: number, tabId?: number): Promise<any>;
    /** Wait for a number of seconds */
    wait(seconds: number): Promise<any>;
    /** Take a screenshot */
    screenshot(tabId?: number): Promise<any>;
    /** Get page info */
    getPageInfo(tabId?: number): Promise<any>;
    /** Get page text content */
    getPageText(tabId?: number): Promise<any>;
    /** Handle extension disconnect: reject pending requests and schedule reconnect.
     *
     * Uses exponential backoff capped at 30s with NO maximum attempt limit.
     * Rationale: MV3 service workers are aggressively recycled by Chrome, which
     * causes the offscreen WebSocket to drop intermittently. Giving up after a
     * fixed number of attempts leaves the daemon in a dead state requiring
     * manual user intervention. Infinite retry with backoff is the only sane
     * default for an always-on local daemon.
     */
    _handleExtensionDisconnect(): void;
    /** Stop the bridge server and any auto-launched Chrome */
    stop(): Promise<void>;
}
