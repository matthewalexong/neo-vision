/**
 * Filter a spatial map in-memory without re-snapshotting.
 */
export function queryMap(map, filters) {
    let elements = [...map.elements];
    if (filters.role) {
        const r = filters.role.toLowerCase();
        elements = elements.filter((el) => el.role?.toLowerCase() === r);
    }
    if (filters.tag) {
        const t = filters.tag.toLowerCase();
        elements = elements.filter((el) => el.tag === t);
    }
    if (filters.labelContains) {
        const search = filters.labelContains.toLowerCase();
        elements = elements.filter((el) => (el.label && el.label.toLowerCase().includes(search)) ||
            (el.text && el.text.toLowerCase().includes(search)));
    }
    if (filters.region) {
        const r = filters.region;
        elements = elements.filter((el) => {
            const b = el.bounds;
            return (b.x >= r.x &&
                b.y >= r.y &&
                b.x + b.width <= r.x + r.width &&
                b.y + b.height <= r.y + r.height);
        });
    }
    if (filters.actionableOnly) {
        elements = elements.filter((el) => el.actionable);
    }
    // Re-index
    elements = elements.map((el, idx) => ({ ...el, idx }));
    return {
        ...map,
        elements,
        stats: {
            total_elements: elements.length,
            actionable_elements: elements.filter((e) => e.actionable).length,
            focusable_elements: elements.filter((e) => e.focusable).length,
            max_depth: map.stats.max_depth,
        },
    };
}
//# sourceMappingURL=query.js.map