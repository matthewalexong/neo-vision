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
    constructor(config?: BridgeConfig);
    /**
     * Auto-launch Chrome with the NeoVision Bridge extension loaded.
     * Called automatically when bridge tools are used but no extension is connected.
     * Uses --load-extension to inject the extension without manual setup.
     */
    autoLaunchChrome(): Promise<void>;
    /** Wait for the Chrome extension to connect via WebSocket */
    private waitForExtension;
    /**
     * Ensure the extension is connected, auto-launching Chrome if needed.
     * This is the main entry point for bridge tools — call this before any command.
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
    /** Send a command to the extension and wait for a response.
     *  Automatically launches Chrome with the extension if not connected. */
    send(command: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
    /** Handle a response from the extension (could be for an MCP tool or an external client relay) */
    private handleExtensionMessage;
    /** Navigate to a URL */
    navigate(url: string): Promise<{
        url: string;
        title: string;
    }>;
    /** Execute JavaScript in the page context */
    executeJs(code: string, tabId?: number): Promise<any>;
    /** Inject the NeoVision spatial snapshot and return the spatial map */
    injectSpatial(options?: {
        verbosity?: string;
        maxDepth?: number;
        includeNonVisible?: boolean;
    }, tabId?: number): Promise<any>;
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
    /** Reload the Chrome extension (self-heal mechanism).
     *  Sends reload_extension command — the extension reloads itself and reconnects.
     *  Used when the extension's WebSocket connection to the bridge is stale. */
    reloadExtension(): Promise<{
        reloading: boolean;
    }>;
    /** Check if the bridge and extension are both connected. */
    getStatus(): {
        bridge: boolean;
        extension: boolean;
        port: number;
    };
    /** Stop the bridge server and any auto-launched Chrome */
    stop(): Promise<void>;
}
