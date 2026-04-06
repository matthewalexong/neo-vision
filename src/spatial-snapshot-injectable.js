/**
 * NeoVision Spatial Snapshot — Injectable Edition
 *
 * A single self-contained function that maps the entire visible DOM into
 * structured spatial data: element coordinates, ARIA roles, accessible
 * labels, actionability flags, and click targets.
 *
 * Runs in ANY browser context:
 *   - Claude in Chrome's javascript_tool
 *   - Chrome extension content scripts
 *   - Playwright page.evaluate()
 *   - Browser DevTools console
 *   - Bookmarklets
 *
 * Returns a JSON-serializable SpatialMap object.
 *
 * Usage:
 *   const map = neoVisionSnapshot();              // defaults
 *   const map = neoVisionSnapshot({ verbosity: "all", maxDepth: 100 });
 */
function neoVisionSnapshot(opts) {
  opts = opts || {};
  var maxDepth = opts.maxDepth || 50;
  var includeNonVisible = opts.includeNonVisible || false;
  var verbosity = opts.verbosity || "actionable"; // "actionable" | "landmarks" | "all"

  // ─── Constants ──────────────────────────────────────────────────

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

  // ─── Phase 1: Walk the DOM ──────────────────────────────────────

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

    // Extract direct text (not from children)
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

  // ─── Phase 2: Resolve into SpatialElements ──────────────────────

  var elements = [];
  for (var idx = 0; idx < rawElements.length; idx++) {
    var raw = rawElements[idx];

    // Role resolution
    var role = raw.role || IMPLICIT_ROLES[raw.tag] || null;

    // Accessible label
    var label = raw.ariaLabel || null;
    if (!label && raw.textContent && raw.textContent.length <= 100) label = raw.textContent;
    if (!label && raw.title) label = raw.title;
    if (!label && raw.placeholder) label = raw.placeholder;

    // Actionability
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

  // ─── Phase 3: Filter noise ──────────────────────────────────────

  // Build parent text lookup for dedup
  var parentTextMap = {};
  for (var p = 0; p < elements.length; p++) {
    if (elements[p].text) parentTextMap[elements[p].idx] = elements[p].text;
  }

  elements = elements.filter(function(el) {
    // Always keep actionable elements
    if (el.actionable) return true;
    // Keep elements with text
    if (el.text && el.text.trim().length > 0) return true;
    // Keep elements with labels
    if (el.label && el.label.trim().length > 0) return true;
    // Keep elements with roles
    if (el.role) return true;
    // Remove 1x1 tracking pixels
    if (el.bounds.width <= 1 && el.bounds.height <= 1) return false;
    // Remove decorative SVG elements
    if (SVG_DECORATIVE[el.tag]) return false;
    // Remove empty wrapper divs/spans
    if ((el.tag === "div" || el.tag === "span") && !el.text && !el.label && !el.role) return false;
    // Remove off-screen elements
    if (el.bounds.x < -100 || el.bounds.y < -100) return false;
    return true;
  });

  // ─── Phase 4: Verbosity filter ──────────────────────────────────

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
  // "all" = no filtering

  // ─── Phase 5: Re-index ──────────────────────────────────────────

  var oldToNew = {};
  for (var n = 0; n < elements.length; n++) {
    oldToNew[elements[n].idx] = n;
  }
  elements = elements.map(function(el, newIdx) {
    return {
      idx: newIdx,
      tag: el.tag,
      role: el.role,
      label: el.label ? (el.label.length > 80 ? el.label.substring(0, 80) + "\u2026" : el.label) : null,
      text: el.text ? (el.text.length > 80 ? el.text.substring(0, 80) + "\u2026" : el.text) : null,
      bounds: el.bounds,
      actionable: el.actionable,
      click_center: el.click_center,
      focusable: el.focusable,
      parent_idx: el.parent_idx !== null ? (oldToNew[el.parent_idx] !== undefined ? oldToNew[el.parent_idx] : null) : null
    };
  });

  // ─── Phase 6: Assemble SpatialMap ───────────────────────────────

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

// If running in Node/module context, export. Otherwise it's already global.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { neoVisionSnapshot: neoVisionSnapshot };
}
