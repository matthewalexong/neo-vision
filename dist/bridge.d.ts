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
    constructor(config?: BridgeConfig);
    /** Start the WebSocket server */
    start(): Promise<void>;
    /** Relay a command from an external client to the extension, then route the response back */
    private relayToExtension;
    /** Check if the extension is connected */
    get ready(): boolean;
    /** Send a command to the extension and wait for a response */
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
    /** Stop the bridge server */
    stop(): Promise<void>;
}
