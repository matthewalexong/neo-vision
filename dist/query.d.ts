import type { SpatialMap, Bounds } from "./schema.js";
export interface QueryFilters {
    role?: string;
    tag?: string;
    labelContains?: string;
    region?: Bounds;
    actionableOnly?: boolean;
}
/**
 * Filter a spatial map in-memory without re-snapshotting.
 */
export declare function queryMap(map: SpatialMap, filters: QueryFilters): SpatialMap;
