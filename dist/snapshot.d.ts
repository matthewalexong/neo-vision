import type { Page } from "playwright";
import type { SpatialMap } from "./schema.js";
export interface SnapshotOptions {
    settleMs: number;
    includeNonVisible: boolean;
    maxDepth: number;
    verbosity: "actionable" | "landmarks" | "all";
}
/**
 * Navigate to a URL with a smart fallback chain.
 * Tries networkidle first (best for SPAs), falls back to domcontentloaded
 * (handles sites with persistent connections like analytics/chat widgets).
 */
export declare function navigateWithFallback(page: Page, url: string, timeout?: number): Promise<void>;
/**
 * Takes a spatial snapshot of the current page state.
 * Walks the DOM, extracts geometry + semantics, and returns a SpatialMap.
 */
export declare function takeSnapshot(page: Page, options: SnapshotOptions): Promise<SpatialMap>;
