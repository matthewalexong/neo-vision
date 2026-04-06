import { z } from "zod";
export declare const BrowserMode: z.ZodEnum<["bundled", "stealth", "attach"]>;
export type BrowserMode = z.infer<typeof BrowserMode>;
export declare const SnapshotInput: z.ZodObject<{
    url: z.ZodString;
    viewport_width: z.ZodDefault<z.ZodNumber>;
    viewport_height: z.ZodDefault<z.ZodNumber>;
    zoom: z.ZodDefault<z.ZodNumber>;
    settle_ms: z.ZodDefault<z.ZodNumber>;
    include_non_visible: z.ZodDefault<z.ZodBoolean>;
    max_depth: z.ZodDefault<z.ZodNumber>;
    browser_mode: z.ZodDefault<z.ZodEnum<["bundled", "stealth", "attach"]>>;
    cdp_url: z.ZodOptional<z.ZodString>;
    chrome_path: z.ZodOptional<z.ZodString>;
    verbosity: z.ZodDefault<z.ZodEnum<["actionable", "landmarks", "all"]>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    viewport_width: number;
    viewport_height: number;
    zoom: number;
    settle_ms: number;
    include_non_visible: boolean;
    max_depth: number;
    browser_mode: "bundled" | "stealth" | "attach";
    verbosity: "actionable" | "landmarks" | "all";
    cdp_url?: string | undefined;
    chrome_path?: string | undefined;
}, {
    url: string;
    viewport_width?: number | undefined;
    viewport_height?: number | undefined;
    zoom?: number | undefined;
    settle_ms?: number | undefined;
    include_non_visible?: boolean | undefined;
    max_depth?: number | undefined;
    browser_mode?: "bundled" | "stealth" | "attach" | undefined;
    cdp_url?: string | undefined;
    chrome_path?: string | undefined;
    verbosity?: "actionable" | "landmarks" | "all" | undefined;
}>;
export type SnapshotInput = z.infer<typeof SnapshotInput>;
export declare const PublicSnapshotInput: z.ZodObject<{
    url: z.ZodString;
    viewport_width: z.ZodDefault<z.ZodNumber>;
    viewport_height: z.ZodDefault<z.ZodNumber>;
    zoom: z.ZodDefault<z.ZodNumber>;
    settle_ms: z.ZodDefault<z.ZodNumber>;
    include_non_visible: z.ZodDefault<z.ZodBoolean>;
    max_depth: z.ZodDefault<z.ZodNumber>;
    verbosity: z.ZodDefault<z.ZodEnum<["actionable", "landmarks", "all"]>>;
    max_elements: z.ZodDefault<z.ZodNumber>;
    compact: z.ZodDefault<z.ZodBoolean>;
    output_format: z.ZodDefault<z.ZodEnum<["compact", "agent"]>>;
}, "strip", z.ZodTypeAny, {
    url: string;
    viewport_width: number;
    viewport_height: number;
    zoom: number;
    settle_ms: number;
    include_non_visible: boolean;
    max_depth: number;
    verbosity: "actionable" | "landmarks" | "all";
    max_elements: number;
    compact: boolean;
    output_format: "compact" | "agent";
}, {
    url: string;
    viewport_width?: number | undefined;
    viewport_height?: number | undefined;
    zoom?: number | undefined;
    settle_ms?: number | undefined;
    include_non_visible?: boolean | undefined;
    max_depth?: number | undefined;
    verbosity?: "actionable" | "landmarks" | "all" | undefined;
    max_elements?: number | undefined;
    compact?: boolean | undefined;
    output_format?: "compact" | "agent" | undefined;
}>;
export type PublicSnapshotInput = z.infer<typeof PublicSnapshotInput>;
export declare const ClickInput: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    button: z.ZodDefault<z.ZodEnum<["left", "right", "middle"]>>;
    click_count: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
    button: "left" | "right" | "middle";
    click_count: number;
}, {
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | undefined;
    click_count?: number | undefined;
}>;
export declare const TypeInput: z.ZodObject<{
    text: z.ZodString;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
    clear_first: z.ZodDefault<z.ZodBoolean>;
    press_enter: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    clear_first: boolean;
    press_enter: boolean;
    x?: number | undefined;
    y?: number | undefined;
}, {
    text: string;
    x?: number | undefined;
    y?: number | undefined;
    clear_first?: boolean | undefined;
    press_enter?: boolean | undefined;
}>;
export declare const ScrollInput: z.ZodObject<{
    delta_x: z.ZodDefault<z.ZodNumber>;
    delta_y: z.ZodDefault<z.ZodNumber>;
    x: z.ZodOptional<z.ZodNumber>;
    y: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    delta_x: number;
    delta_y: number;
    x?: number | undefined;
    y?: number | undefined;
}, {
    x?: number | undefined;
    y?: number | undefined;
    delta_x?: number | undefined;
    delta_y?: number | undefined;
}>;
export declare const QueryInput: z.ZodObject<{
    role: z.ZodOptional<z.ZodString>;
    tag: z.ZodOptional<z.ZodString>;
    label_contains: z.ZodOptional<z.ZodString>;
    region: z.ZodOptional<z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        x: number;
        y: number;
        width: number;
        height: number;
    }, {
        x: number;
        y: number;
        width: number;
        height: number;
    }>>;
    actionable_only: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    actionable_only: boolean;
    role?: string | undefined;
    tag?: string | undefined;
    label_contains?: string | undefined;
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | undefined;
}, {
    role?: string | undefined;
    tag?: string | undefined;
    label_contains?: string | undefined;
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | undefined;
    actionable_only?: boolean | undefined;
}>;
export declare const ImportCookiesInput: z.ZodObject<{
    cookies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
        domain: z.ZodString;
        path: z.ZodOptional<z.ZodString>;
        expires: z.ZodOptional<z.ZodNumber>;
        httpOnly: z.ZodOptional<z.ZodBoolean>;
        secure: z.ZodOptional<z.ZodBoolean>;
        sameSite: z.ZodOptional<z.ZodEnum<["Strict", "Lax", "None"]>>;
    }, "strip", z.ZodTypeAny, {
        value: string;
        name: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }, {
        value: string;
        name: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    cookies: {
        value: string;
        name: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }[];
}, {
    cookies: {
        value: string;
        name: string;
        domain: string;
        path?: string | undefined;
        expires?: number | undefined;
        httpOnly?: boolean | undefined;
        secure?: boolean | undefined;
        sameSite?: "Strict" | "Lax" | "None" | undefined;
    }[];
}>;
export declare const ExportCookiesInput: z.ZodObject<{
    domains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    domains?: string[] | undefined;
}, {
    domains?: string[] | undefined;
}>;
export declare const ConnectCDPInput: z.ZodObject<{
    cdp_url: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    cdp_url: string;
}, {
    cdp_url?: string | undefined;
}>;
export declare const DisconnectCDPInput: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Point {
    x: number;
    y: number;
}
export interface ComputedLayout {
    position: string;
    z_index: string;
    display: string;
    overflow: string;
    opacity: string;
    visibility: string;
}
export interface SpatialElement {
    idx: number;
    tag: string;
    id: string | null;
    selector: string;
    parent_idx: number | null;
    role: string | null;
    label: string | null;
    text: string | null;
    bounds: Bounds;
    computed: ComputedLayout;
    actionable: boolean;
    click_center: Point | null;
    input_type: string | null;
    focusable: boolean;
    tab_index: number | null;
}
export interface SpatialMapStats {
    total_elements: number;
    actionable_elements: number;
    focusable_elements: number;
    max_depth: number;
}
export interface SpatialMap {
    url: string;
    timestamp: string;
    viewport: {
        width: number;
        height: number;
    };
    zoom: number;
    scroll: Point;
    page_bounds: {
        width: number;
        height: number;
    };
    elements: SpatialElement[];
    stats: SpatialMapStats;
}
