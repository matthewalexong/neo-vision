import type { Page } from "playwright";
import type { SpatialMap, SpatialElement, Bounds, ComputedLayout } from "./schema.js";

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
export async function navigateWithFallback(
  page: Page,
  url: string,
  timeout: number = 30000
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If networkidle timed out, retry with domcontentloaded
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } else {
      throw err;
    }
  }
}

// Tags that are inherently actionable
const ACTIONABLE_TAGS = new Set([
  "a", "button", "input", "select", "textarea", "summary", "details",
]);

// Roles that indicate actionability
const ACTIONABLE_ROLES = new Set([
  "button", "link", "menuitem", "tab", "checkbox", "radio",
  "switch", "slider", "combobox", "textbox", "searchbox",
  "spinbutton", "option", "menuitemcheckbox", "menuitemradio",
]);

// Landmark roles (included in "landmarks" verbosity)
const LANDMARK_ROLES = new Set([
  "banner", "navigation", "main", "complementary", "contentinfo",
  "search", "form", "region", "heading", "img", "list", "listitem",
  "table", "row", "cell", "columnheader", "rowheader",
]);

// Implicit ARIA role mapping for common tags
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  input: "textbox",  // simplified; actual role depends on type
  select: "combobox",
  textarea: "textbox",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  table: "table",
  tr: "row",
  td: "cell",
  th: "columnheader",
  ul: "list",
  ol: "list",
  li: "listitem",
  img: "img",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};

/**
 * Raw element data extracted from the page via evaluate()
 */
interface RawElement {
  tag: string;
  id: string | null;
  className: string;
  bounds: Bounds;
  role: string | null;
  ariaLabel: string | null;
  ariaLabelledBy: string | null;
  title: string | null;
  placeholder: string | null;
  textContent: string | null;
  inputType: string | null;
  tabIndex: number;
  hasOnClick: boolean;
  isContentEditable: boolean;
  isDraggable: boolean;
  computedPosition: string;
  computedZIndex: string;
  computedDisplay: string;
  computedOverflow: string;
  computedOpacity: string;
  computedVisibility: string;
  computedCursor: string;
  depth: number;
  parentIndex: number;
}

/**
 * Takes a spatial snapshot of the current page state.
 * Walks the DOM, extracts geometry + semantics, and returns a SpatialMap.
 */
export async function takeSnapshot(
  page: Page,
  options: SnapshotOptions
): Promise<SpatialMap> {
  // Wait for the page to settle — handle redirects gracefully
  if (options.settleMs > 0) {
    await page.waitForTimeout(options.settleMs);
  }

  // Wait for any pending navigations/redirects to finish
  // Retry loop: if evaluate fails due to navigation, wait and retry
  let retries = 3;
  while (retries > 0) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
      await page.waitForTimeout(500);
      // Test if page is stable by running a trivial evaluate
      await page.evaluate(`1+1`);
      break; // Page is stable
    } catch {
      retries--;
      if (retries === 0) throw new Error("Page keeps navigating — unable to take stable snapshot. The page may require authentication or is stuck in a redirect loop.");
      await page.waitForTimeout(2000); // Wait for redirect to land
    }
  }

  const url = page.url();

  // Scroll to top so getBoundingClientRect() returns absolute page coordinates
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.waitForTimeout(100);

  // Get viewport and scroll info
  interface PageInfo {
    scrollX: number;
    scrollY: number;
    pageWidth: number;
    pageHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  }
  const pageInfo = await page.evaluate(`(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }))()`) as PageInfo;

  // Walk the DOM and extract raw element data
  // NOTE: We use a string-based evaluate to avoid tsx/esbuild __name transforms
  const domWalkerScript = `((opts) => {
    var results = [];
    var skipTags = { script:1, style:1, noscript:1, template:1, link:1, meta:1 };

    var walk = function(el, depth, parentIdx) {
      if (depth > opts.maxDepth) return;
      var tag = el.tagName.toLowerCase();
      if (skipTags[tag]) return;

      var rect = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);

      if (!opts.includeNonVisible) {
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0" ||
            (rect.width === 0 && rect.height === 0)) {
          for (var i = 0; i < el.children.length; i++) {
            walk(el.children[i], depth + 1, parentIdx);
          }
          return;
        }
      }

      var currentIndex = results.length;
      var ariaLabel = el.getAttribute("aria-label");
      var ariaLabelledBy = el.getAttribute("aria-labelledby");
      var title = el.getAttribute("title");
      var placeholder = el.getAttribute("placeholder");

      var textContent = null;
      var nodes = el.childNodes;
      var directParts = [];
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].nodeType === 3) {
          var t = (nodes[j].textContent || "").trim();
          if (t) directParts.push(t);
        }
      }
      var directText = directParts.join(" ");
      if (directText) {
        textContent = directText.substring(0, 200);
      } else if (el.textContent) {
        var trimmed = el.textContent.trim();
        textContent = trimmed ? trimmed.substring(0, 200) : null;
      }

      var cn = el.className;
      results.push({
        tag: tag,
        id: el.id || null,
        className: (cn && typeof cn === "string") ? cn : "",
        bounds: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height)
        },
        role: el.getAttribute("role"),
        ariaLabel: ariaLabel, ariaLabelledBy: ariaLabelledBy,
        title: title, placeholder: placeholder,
        textContent: textContent,
        inputType: tag === "input" ? el.type : null,
        tabIndex: el.tabIndex,
        hasOnClick: el.hasAttribute("onclick"),
        isContentEditable: el.isContentEditable && tag !== "body" && tag !== "html",
        isDraggable: el.draggable && tag !== "img",
        computedPosition: cs.position, computedZIndex: cs.zIndex,
        computedDisplay: cs.display, computedOverflow: cs.overflow,
        computedOpacity: cs.opacity, computedVisibility: cs.visibility,
        computedCursor: cs.cursor,
        depth: depth, parentIndex: parentIdx
      });

      for (var k = 0; k < el.children.length; k++) {
        walk(el.children[k], depth + 1, currentIndex);
      }
    };

    walk(document.documentElement, 0, -1);
    return results;
  })(${JSON.stringify({ maxDepth: options.maxDepth, includeNonVisible: options.includeNonVisible })})`;

  const rawElements: RawElement[] = await page.evaluate(domWalkerScript);

  // Resolve raw elements into SpatialElements
  let elements: SpatialElement[] = rawElements.map((raw, idx) => {
    // Determine role
    const role = raw.role || IMPLICIT_ROLES[raw.tag] || null;

    // Compute accessible name
    let label: string | null = null;
    if (raw.ariaLabel) {
      label = raw.ariaLabel;
    } else if (raw.ariaLabelledBy) {
      // Would need to resolve referenced element — simplified here
      label = raw.ariaLabelledBy;
    } else if (raw.textContent && raw.textContent.length <= 100) {
      label = raw.textContent;
    } else if (raw.title) {
      label = raw.title;
    } else if (raw.placeholder) {
      label = raw.placeholder;
    }

    // Determine actionability
    const isActionableTag = ACTIONABLE_TAGS.has(raw.tag);
    const isActionableRole = role ? ACTIONABLE_ROLES.has(role) : false;
    const isActionableAttr =
      raw.hasOnClick ||
      raw.tabIndex >= 0 ||
      raw.isContentEditable ||
      raw.isDraggable;
    const isActionableCursor = raw.computedCursor === "pointer";
    const actionable = isActionableTag || isActionableRole || isActionableAttr || isActionableCursor;

    // Determine focusability
    const focusable = raw.tabIndex >= 0 || isActionableTag;

    // Build unique CSS selector
    let selector: string;
    if (raw.id) {
      selector = `${raw.tag}#${raw.id}`;
    } else if (raw.className) {
      const classes = raw.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      selector = classes ? `${raw.tag}.${classes}` : raw.tag;
    } else {
      selector = raw.tag;
    }

    const computed: ComputedLayout = {
      position: raw.computedPosition,
      z_index: raw.computedZIndex,
      display: raw.computedDisplay,
      overflow: raw.computedOverflow,
      opacity: raw.computedOpacity,
    };

    return {
      idx,
      tag: raw.tag,
      id: raw.id,
      selector,
      parent_idx: raw.parentIndex === -1 ? null : raw.parentIndex,
      role,
      label,
      text: raw.textContent,
      bounds: raw.bounds,
      computed,
      actionable,
      click_center: actionable
        ? {
            x: Math.round(raw.bounds.x + raw.bounds.width / 2),
            y: Math.round(raw.bounds.y + raw.bounds.height / 2),
          }
        : null,
      input_type: raw.inputType,
      focusable,
      tab_index: focusable ? raw.tabIndex : null,
    };
  });

  // Filter out off-screen elements (accessibility skips, negative-positioned UI)
  // Elements with x < -100 or y < -100 are invisible UI (skip-links, off-canvas menus)
  elements = elements.filter(
    (el) => el.bounds.x >= -100 && el.bounds.y >= -100
  );

  // Filter out decorative/noise elements that provide zero value to any agent task:
  // - 1x1 pixel tracking elements with no label and no text
  // - Decorative SVG sub-elements (path, g, circle, ellipse, line, polyline, polygon, rect)
  //   that have no label, no text, and aren't meaningfully actionable
  // - Elements with completely empty/null text AND label AND no role AND not actionable
  elements = elements.filter((el) => {
    // Keep if actionable (might be a real button/icon the agent needs to click)
    if (el.actionable) return true;
    // Keep if it has meaningful text content
    if (el.text && el.text.trim().length > 0) return true;
    // Keep if it has an accessible label
    if (el.label && el.label.trim().length > 0) return true;
    // Keep if it has a semantic role
    if (el.role) return true;
    // Remove 1x1 pixel tracking pixels
    if (el.bounds.width <= 1 && el.bounds.height <= 1) return false;
    // Remove decorative SVG sub-elements with no semantic content
    if (el.tag === "path" || el.tag === "g" || el.tag === "circle" ||
        el.tag === "ellipse" || el.tag === "line" || el.tag === "polyline" ||
        el.tag === "polygon") {
      return false;
    }
    // Keep everything else
    return true;
  });

  // Filter based on verbosity
  if (options.verbosity === "actionable") {
    elements = elements.filter(
      (el) =>
        el.actionable ||
        (el.role && LANDMARK_ROLES.has(el.role)) // keep landmarks for spatial context
    );
  } else if (options.verbosity === "landmarks") {
    elements = elements.filter(
      (el) =>
        el.actionable ||
        (el.role && LANDMARK_ROLES.has(el.role)) ||
        el.tag === "section" ||
        el.tag === "article" ||
        el.tag === "div" && el.id // named divs are likely landmarks
    );
  }
  // "all" = no filtering

  // Re-index after filtering
  const oldToNew = new Map<number, number>();
  elements.forEach((el, newIdx) => {
    oldToNew.set(el.idx, newIdx);
  });
  elements = elements.map((el, newIdx) => ({
    ...el,
    idx: newIdx,
    parent_idx: el.parent_idx !== null ? (oldToNew.get(el.parent_idx) ?? null) : null,
  }));

  // Compute stats
  let maxDepth = 0;
  for (const raw of rawElements) {
    if (raw.depth > maxDepth) maxDepth = raw.depth;
  }

  const stats = {
    total_elements: elements.length,
    actionable_elements: elements.filter((e) => e.actionable).length,
    focusable_elements: elements.filter((e) => e.focusable).length,
    max_depth: maxDepth,
  };

  return {
    url,
    timestamp: new Date().toISOString(),
    viewport: { width: pageInfo.viewportWidth, height: pageInfo.viewportHeight },
    zoom: 1.0, // from config, but page.evaluate can't access it
    scroll: { x: pageInfo.scrollX, y: pageInfo.scrollY },
    page_bounds: { width: pageInfo.pageWidth, height: pageInfo.pageHeight },
    elements,
    stats,
  };
}
