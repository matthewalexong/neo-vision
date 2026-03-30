import type { Page, BrowserContext } from "playwright";

/**
 * Stealth layer for anti-bot evasion.
 *
 * When running in "stealth" mode (real Chrome) or "bundled" mode (Playwright Chromium),
 * these patches make the browser appear indistinguishable from a human-operated session.
 *
 * Covers the major detection vectors:
 * 1. navigator.webdriver flag
 * 2. Chrome runtime object presence
 * 3. Permissions API inconsistencies
 * 4. Plugin & mimeType enumeration
 * 5. WebGL renderer/vendor fingerprinting
 * 6. Headless-mode giveaways (languages, platform)
 * 7. iframe contentWindow detection
 * 8. CSS animation injection for determinism
 * 9. Human-like timing jitter for actions
 */

// ─── Init Scripts (run before every page load) ──────────────────

/**
 * Core stealth patches injected via addInitScript().
 * These run in the browser context before any page JavaScript.
 */
export const STEALTH_PATCHES = `
(() => {
  // 1. Remove navigator.webdriver flag (primary bot signal)
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // Also delete it from the prototype
  try {
    const proto = Object.getPrototypeOf(navigator);
    if (proto && 'webdriver' in proto) {
      delete proto.webdriver;
    }
  } catch {}

  // 2. Ensure window.chrome exists (missing in headless Chromium)
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
    };
  }

  // 3. Fix Permissions API (headless returns inconsistent results)
  if (navigator.permissions) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(desc) {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return originalQuery(desc);
    };
  }

  // 4. Spoof plugins array (headless has 0 plugins)
  if (navigator.plugins.length === 0) {
    const pluginData = [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' },
    ];

    const mimeData = [
      { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'application/pdf', suffixes: 'pdf', description: '' },
    ];

    const makeMime = (m) => {
      const obj = Object.create(MimeType.prototype);
      Object.defineProperties(obj, {
        type:        { get: () => m.type },
        suffixes:    { get: () => m.suffixes },
        description: { get: () => m.description },
        enabledPlugin: { get: () => null },
      });
      return obj;
    };

    const makePlugin = (p) => {
      const obj = Object.create(Plugin.prototype);
      Object.defineProperties(obj, {
        name:        { get: () => p.name },
        description: { get: () => p.description },
        filename:    { get: () => p.filename },
        length:      { get: () => 0 },
      });
      return obj;
    };

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = pluginData.map(makePlugin);
        arr.length = pluginData.length;
        arr.item = (i) => arr[i] || null;
        arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
        arr.refresh = () => {};
        arr[Symbol.iterator] = function* () { for (const p of arr) yield p; };
        return arr;
      },
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = mimeData.map(makeMime);
        arr.length = mimeData.length;
        arr.item = (i) => arr[i] || null;
        arr.namedItem = (n) => arr.find((m) => m.type === n) || null;
        arr[Symbol.iterator] = function* () { for (const m of arr) yield m; };
        return arr;
      },
    });
  }

  // 5. Patch WebGL renderer/vendor (headless returns "Google SwiftShader")
  const getParamProto = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return getParamProto.call(this, param);
  };

  const getParam2Proto = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return getParam2Proto.call(this, param);
  };

  // 6. Ensure navigator.languages is populated
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  }

  // 7. Ensure navigator.platform looks real
  if (navigator.platform === '' || navigator.platform === 'Linux x86_64') {
    // Most Chrome users are on Windows or Mac
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });
  }

  // 8. Fix iframe contentWindow access (headless leaks)
  try {
    const origGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (origGetter && origGetter.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function() {
          const win = origGetter.get.call(this);
          if (win) {
            try {
              // Accessing cross-origin iframe should throw, not return null
              win.self;
            } catch {
              return win;
            }
          }
          return win;
        },
      });
    }
  } catch {}

  // 9. Lie about connection count (automation tools open many)
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', {
      get: () => 50,
    });
  }

  // 10. Prevent detection via toString() checks
  // Some sites check if toString() returns "function webdriver() { [native code] }"
  const cleanToString = (fn, name) => {
    const handler = {
      apply: (target, thisArg, args) => {
        if (thisArg === fn) {
          return \`function \${name}() { [native code] }\`;
        }
        return target.apply(thisArg, args);
      },
    };
    fn.toString = new Proxy(fn.toString, handler);
  };
  // Apply to commonly checked functions
  try { cleanToString(navigator.permissions.query, 'query'); } catch {}
})();
`;

/**
 * CSS that disables all animations and transitions for deterministic snapshots.
 */
export const DETERMINISTIC_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
`;

// ─── Human-like Timing ──────────────────────────────────────────

/**
 * Adds natural jitter to timing so actions don't happen at machine precision.
 * Returns a delay in ms that looks human.
 */
export function humanDelay(baseMs: number, jitterFactor: number = 0.3): number {
  const jitter = baseMs * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(50, Math.round(baseMs + jitter));
}

/**
 * Sleep with human-like jitter.
 */
export function humanSleep(page: Page, baseMs: number): Promise<void> {
  return page.waitForTimeout(humanDelay(baseMs));
}

/**
 * Human-like typing delay per character (varies between 40-120ms).
 */
export function typingDelay(): number {
  return Math.round(40 + Math.random() * 80);
}

// ─── Stealth Application ────────────────────────────────────────

/**
 * Apply all stealth patches to a browser context.
 * Call this after creating the context but before navigating.
 */
export async function applyStealthToContext(context: BrowserContext): Promise<void> {
  // Inject stealth patches before every page load
  await context.addInitScript(STEALTH_PATCHES);

  // Inject deterministic CSS
  await context.addInitScript(`(() => {
    const style = document.createElement('style');
    style.id = 'neo-vision-deterministic';
    style.textContent = ${JSON.stringify(DETERMINISTIC_CSS)};
    if (document.documentElement) {
      document.documentElement.appendChild(style);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.appendChild(style);
      });
    }
  })()`);
}

/**
 * Apply stealth patches to an already-open page (for attach mode
 * where we can't use addInitScript on the context).
 */
export async function applyStealthToPage(page: Page): Promise<void> {
  await page.evaluate(STEALTH_PATCHES);
  await page.evaluate(`(() => {
    if (!document.getElementById('neo-vision-deterministic')) {
      const style = document.createElement('style');
      style.id = 'neo-vision-deterministic';
      style.textContent = ${JSON.stringify(DETERMINISTIC_CSS)};
      document.documentElement.appendChild(style);
    }
  })()`);
}

// ─── Stealth Detection Check ────────────────────────────────────

/**
 * Run a self-check to see if stealth is working.
 * Returns an object with detection vectors and whether they pass.
 * Useful for debugging and for the demo script.
 */
export async function stealthCheck(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(`(() => {
    const results = {};
    results['navigator.webdriver is undefined'] = navigator.webdriver === undefined;
    results['window.chrome exists'] = !!window.chrome;
    results['chrome.runtime exists'] = !!(window.chrome && window.chrome.runtime);
    results['plugins.length > 0'] = navigator.plugins.length > 0;
    results['languages has values'] = navigator.languages && navigator.languages.length > 0;
    results['platform is set'] = navigator.platform !== '' && navigator.platform !== 'Linux x86_64';

    // WebGL check
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          results['WebGL renderer not SwiftShader'] = !renderer.includes('SwiftShader');
        }
      }
    } catch {
      results['WebGL renderer not SwiftShader'] = true;
    }

    return results;
  })()`);
}
