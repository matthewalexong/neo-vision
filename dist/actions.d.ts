import type { Page } from "playwright";
import type { SpatialMap } from "./schema.js";
import { type SnapshotOptions } from "./snapshot.js";
/**
 * Click at a coordinate with human-like mouse movement, jitter,
 * and variable timing.  Returns an updated spatial map.
 */
export declare function click(page: Page, x: number, y: number, button: "left" | "right" | "middle" | undefined, clickCount: number | undefined, snapshotOptions: SnapshotOptions): Promise<SpatialMap>;
/**
 * Type text with human-like per-character delay variation,
 * optional click-to-focus with bezier movement.
 */
export declare function type(page: Page, text: string, options: {
    x?: number;
    y?: number;
    clearFirst?: boolean;
    pressEnter?: boolean;
}, snapshotOptions: SnapshotOptions): Promise<SpatialMap>;
/**
 * Scroll with human-like incremental steps instead of a single
 * instant jump.  Humans scroll in discrete wheel ticks with
 * variable timing.
 */
export declare function scroll(page: Page, deltaX?: number, deltaY?: number, x?: number, y?: number, snapshotOptions?: SnapshotOptions): Promise<SpatialMap>;
