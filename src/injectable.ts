/**
 * NeoVision Injectable Spatial Snapshot
 *
 * Provides the self-contained browser-side JavaScript that maps the
 * visible DOM into structured spatial data.  This module is the bridge
 * between NeoVision's server-side TypeScript and ANY browser context:
 *
 *   - Claude in Chrome's javascript_tool  (hybrid mode — the main use case)
 *   - Chrome extension content scripts
 *   - Playwright page.evaluate()
 *   - DevTools console / bookmarklets
 *
 * Three exports cover every integration pattern:
 *
 *   1. `INJECTABLE_SOURCE`  — The raw JS source string.  Inject it once
 *      into a page, then call `neoVisionSnapshot()` as many times as
 *      you like.  Best for long-lived sessions where you want to
 *      snapshot → act → re-snapshot without re-injecting.
 *
 *   2. `getInjectableScript(opts)` — Returns a single JS expression
 *      that defines the function AND immediately invokes it, returning
 *      the SpatialMap.  Best for one-shot injection (e.g., Chrome
 *      extension `executeScript`, Claude in Chrome `javascript_tool`).
 *
 *   3. `InjectableSpatialMap` / `InjectableSpatialElement` — TypeScript
 *      types for the object returned by the injectable.  These are
 *      intentionally lighter than the Playwright-side SpatialElement
 *      (no selector, no ComputedLayout) because browser-side extraction
 *      keeps things minimal for fast serialization.
 */

// ─── Types returned by the injectable JS ─────────────────────────

export interface InjectableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InjectablePoint {
  x: number;
  y: number;
}

export interface InjectableSpatialElement {
  idx: number;
  tag: string;
  role: string | null;
  label: string | null;
  text: string | null;
  bounds: InjectableBounds;
  actionable: boolean;
  click_center: InjectablePoint | null;
  focusable: boolean;
  parent_idx: number | null;
}

export interface InjectableSpatialMap {
  url: string;
  timestamp: string;
  viewport: { width: number; height: number };
  scroll: InjectablePoint;
  page_bounds: { width: number; height: number };
  elements: InjectableSpatialElement[];
  stats: {
    total_elements: number;
    actionable_elements: number;
    focusable_elements: number;
  };
}

export interface InjectableOptions {
  /** Max DOM depth to traverse. Default: 50 */
  maxDepth?: number;
  /** Include display:none / visibility:hidden elements. Default: false */
  includeNonVisible?: boolean;
  /** Element filter: "actionable" (default), "landmarks", "all" */
  verbosity?: "actionable" | "landmarks" | "all";
}

// ─── The injectable source ────────────────────────────────────────
//
// This is a string literal containing the complete, self-contained JS
// function.  It uses ES5-compatible syntax so it runs in any browser
// context without transpilation.
//
// The source is kept as a template literal for readability.  At build
// time it's just a string — no dynamic evaluation.

export const INJECTABLE_SOURCE = `
function neoVisionSnapshot(opts) {
  opts = opts || {};
  var maxDepth = opts.maxDepth || 50;
  var includeNonVisible = opts.includeNonVisible || false;
  var verbosity = opts.verbosity || "actionable";

  var ACTIONABLE_TAGS = {
    a:1, button:1, input:1, select:1, textarea:1, summary:1, details:1
  };

  var ACTIONABLE_ROLES = {
    button:1, link:1, menuitem:1, tab:1, checkbox:1, radio:1,
    switch:1, slider:1, combobox:1, textbox:1, searchbox:1,
    spinbutton:1, option:1, menuitemcheckbox:1, menuitemradio:1
  };

  var LANDMARK_ROLES = {
    banner:1, navigation:1, main:1, complementary:1, contentinfo:1,
    search:1, form:1, region:1, heading:1, img:1, list:1, listitem:1,
    table:1, row:1, cell:1, columnheader:1, rowheader:1
  };

  var IMPLICIT_ROLES = {
    a:"link", button:"button", input:"textbox", select:"combobox",
    textarea:"textbox", nav:"navigation", main:"main", header:"banner",
    footer:"contentinfo", aside:"complementary", form:"form",
    table:"table", tr:"row", td:"cell", th:"columnheader",
    ul:"list", ol:"list", li:"listitem", img:"img",
    h1:"heading", h2:"heading", h3:"heading",
    h4:"heading", h5:"heading", h6:"heading"
  };

  var SKIP_TAGS = { script:1, style:1, noscript:1, template:1, link:1, meta:1 };
  var SVG_DECORATIVE = { path:1, g:1, circle:1, ellipse:1, line:1, polyline:1, polygon:1 };

  var rawElements = [];

  function walk(el, depth, parentIdx) {
    if (depth > maxDepth) return;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (SKIP_TAGS[tag]) return;

    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);

    if (!includeNonVisible) {
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0" ||
          (rect.width === 0 && rect.height === 0)) {
        for (var i = 0; i < el.children.length; i++) {
          walk(el.children[i], depth + 1, parentIdx);
        }
        return;
      }
    }

    var currentIndex = rawElements.length;
    var ariaLabel = el.getAttribute("aria-label");
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

    rawElements.push({
      tag: tag,
      id: el.id || null,
      className: (el.className && typeof el.className === "string") ? el.className : "",
      bounds: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      role: el.getAttribute("role"),
      ariaLabel: ariaLabel,
      title: title,
      placeholder: placeholder,
      textContent: textContent,
      inputType: tag === "input" ? el.type : null,
      tabIndex: el.tabIndex,
      hasOnClick: el.hasAttribute("onclick"),
      isContentEditable: el.isContentEditable && tag !== "body" && tag !== "html",
      isDraggable: el.draggable && tag !== "img",
      computedCursor: cs.cursor,
      computedOpacity: cs.opacity,
      computedVisibility: cs.visibility,
      computedDisplay: cs.display,
      depth: depth,
      parentIndex: parentIdx
    });

    for (var k = 0; k < el.children.length; k++) {
      walk(el.children[k], depth + 1, currentIndex);
    }
  }

  walk(document.documentElement, 0, -1);

  var elements = [];
  for (var idx = 0; idx < rawElements.length; idx++) {
    var raw = rawElements[idx];
    var role = raw.role || IMPLICIT_ROLES[raw.tag] || null;
    var label = raw.ariaLabel || null;
    if (!label && raw.textContent && raw.textContent.length <= 100) label = raw.textContent;
    if (!label && raw.title) label = raw.title;
    if (!label && raw.placeholder) label = raw.placeholder;

    var isActionableTag = !!ACTIONABLE_TAGS[raw.tag];
    var isActionableRole = role ? !!ACTIONABLE_ROLES[role] : false;
    var isActionableAttr = raw.hasOnClick || raw.tabIndex >= 0 || raw.isContentEditable || raw.isDraggable;
    var isActionableCursor = raw.computedCursor === "pointer";
    var actionable = isActionableTag || isActionableRole || isActionableAttr || isActionableCursor;
    var focusable = raw.tabIndex >= 0 || isActionableTag;

    elements.push({
      idx: idx,
      tag: raw.tag,
      role: role,
      label: label,
      text: raw.textContent,
      bounds: raw.bounds,
      actionable: actionable,
      click_center: actionable ? {
        x: Math.round(raw.bounds.x + raw.bounds.width / 2),
        y: Math.round(raw.bounds.y + raw.bounds.height / 2)
      } : null,
      focusable: focusable,
      parent_idx: raw.parentIndex === -1 ? null : raw.parentIndex,
      depth: raw.depth
    });
  }

  var parentTextMap = {};
  for (var p = 0; p < elements.length; p++) {
    if (elements[p].text) parentTextMap[elements[p].idx] = elements[p].text;
  }

  elements = elements.filter(function(el) {
    if (el.actionable) return true;
    if (el.text && el.text.trim().length > 0) return true;
    if (el.label && el.label.trim().length > 0) return true;
    if (el.role) return true;
    if (el.bounds.width <= 1 && el.bounds.height <= 1) return false;
    if (SVG_DECORATIVE[el.tag]) return false;
    if ((el.tag === "div" || el.tag === "span") && !el.text && !el.label && !el.role) return false;
    if (el.bounds.x < -100 || el.bounds.y < -100) return false;
    return true;
  });

  if (verbosity === "actionable") {
    elements = elements.filter(function(el) {
      return el.actionable || (el.role && LANDMARK_ROLES[el.role]);
    });
  } else if (verbosity === "landmarks") {
    elements = elements.filter(function(el) {
      return el.actionable || (el.role && LANDMARK_ROLES[el.role]) ||
             el.tag === "section" || el.tag === "article" ||
             (el.tag === "div" && el.id);
    });
  }

  var oldToNew = {};
  for (var n = 0; n < elements.length; n++) {
    oldToNew[elements[n].idx] = n;
  }
  elements = elements.map(function(el, newIdx) {
    return {
      idx: newIdx,
      tag: el.tag,
      role: el.role,
      label: el.label ? (el.label.length > 80 ? el.label.substring(0, 80) + "\\u2026" : el.label) : null,
      text: el.text ? (el.text.length > 80 ? el.text.substring(0, 80) + "\\u2026" : el.text) : null,
      bounds: el.bounds,
      actionable: el.actionable,
      click_center: el.click_center,
      focusable: el.focusable,
      parent_idx: el.parent_idx !== null ? (oldToNew[el.parent_idx] !== undefined ? oldToNew[el.parent_idx] : null) : null
    };
  });

  return {
    url: window.location.href,
    timestamp: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    page_bounds: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    },
    elements: elements,
    stats: {
      total_elements: elements.length,
      actionable_elements: elements.filter(function(e) { return e.actionable; }).length,
      focusable_elements: elements.filter(function(e) { return e.focusable; }).length
    }
  };
}
`.trim();

// ─── Convenience: one-shot injectable script ──────────────────────

/**
 * Returns a single JS expression that defines neoVisionSnapshot AND
 * immediately invokes it with the given options.
 *
 * Usage with Claude in Chrome's javascript_tool:
 *   const script = getInjectableScript({ verbosity: "actionable" });
 *   // Paste/send `script` to javascript_tool — returns the SpatialMap JSON
 *
 * Usage with Playwright:
 *   const map = await page.evaluate(getInjectableScript({ verbosity: "all" }));
 *
 * Usage with Chrome extension:
 *   chrome.scripting.executeScript({
 *     target: { tabId },
 *     func: new Function(getInjectableScript()),
 *   });
 */
export function getInjectableScript(opts?: InjectableOptions): string {
  const optsJson = JSON.stringify(opts || {});
  return `(function() {\n${INJECTABLE_SOURCE}\nreturn neoVisionSnapshot(${optsJson});\n})()`;
}

/**
 * Returns the injectable source wrapped as a self-invoking function
 * that installs `neoVisionSnapshot` on `window` for repeated use.
 *
 * After injecting this once, call `neoVisionSnapshot()` or
 * `neoVisionSnapshot({ verbosity: "all" })` as many times as needed.
 */
export function getInjectableInstaller(): string {
  return `(function() {\n${INJECTABLE_SOURCE}\nwindow.neoVisionSnapshot = neoVisionSnapshot;\nreturn "neoVisionSnapshot installed";\n})()`;
}
