import { z } from "zod";
export declare const PublicSnapshotInput: z.ZodObject<{
    url: z.ZodOptional<z.ZodString>;
    viewport_width: z.ZodDefault<z.ZodNumber>;
    viewport_height: z.ZodDefault<z.ZodNumber>;
    settle_ms: z.ZodDefault<z.ZodNumber>;
    include_non_visible: z.ZodDefault<z.ZodBoolean>;
    max_depth: z.ZodDefault<z.ZodNumber>;
    verbosity: z.ZodDefault<z.ZodEnum<["actionable", "landmarks", "all"]>>;
    max_elements: z.ZodDefault<z.ZodNumber>;
    compact: z.ZodDefault<z.ZodBoolean>;
    output_format: z.ZodDefault<z.ZodEnum<["compact", "agent"]>>;
}, "strip", z.ZodTypeAny, {
    verbosity: "actionable" | "landmarks" | "all";
    viewport_width: number;
    viewport_height: number;
    settle_ms: number;
    include_non_visible: boolean;
    max_depth: number;
    max_elements: number;
    compact: boolean;
    output_format: "compact" | "agent";
    url?: string | undefined;
}, {
    url?: string | undefined;
    verbosity?: "actionable" | "landmarks" | "all" | undefined;
    viewport_width?: number | undefined;
    viewport_height?: number | undefined;
    settle_ms?: number | undefined;
    include_non_visible?: boolean | undefined;
    max_depth?: number | undefined;
    max_elements?: number | undefined;
    compact?: boolean | undefined;
    output_format?: "compact" | "agent" | undefined;
}>;
export type PublicSnapshotInput = z.infer<typeof PublicSnapshotInput>;
export declare const ClickInput: z.ZodObject<{
    x: z.ZodNumber;
    y: z.ZodNumber;
    button: z.ZodDefault<z.ZodEnum<["left", "right"]>>;
}, "strip", z.ZodTypeAny, {
    x: number;
    y: number;
    button: "left" | "right";
}, {
    x: number;
    y: number;
    button?: "left" | "right" | undefined;
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
