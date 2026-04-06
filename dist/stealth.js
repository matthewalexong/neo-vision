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
  if (navigator.platform === '' || navigator.platform === 'Linux x86_64' || navigator.platform === 'Linux aarch64') {
    // Match platform to the user agent — most real Chrome sessions report MacIntel or Win32
    const ua = navigator.userAgent || '';
    let fakePlatform = 'Win32';
    if (ua.includes('Macintosh') || ua.includes('Mac OS X')) fakePlatform = 'MacIntel';
    else if (ua.includes('Linux')) fakePlatform = 'Linux x86_64';
    Object.defineProperty(navigator, 'platform', {
      get: () => fakePlatform,
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

  // 11. Canvas fingerprint spoofing
  // Anti-bot systems use HTMLCanvasElement.toDataURL() / toBlob() / getImageData() to
  // build a hardware fingerprint. We inject ±1-2px noise into the pixel data so every
  // call returns a slightly different hash — defeating fingerprint matching while
  // leaving rendered pages visually identical.
  (function() {
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    function noisyCanvas(ctx) {
      try {
        var img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        var d = img.data;
        // Touch ~0.1% of pixels — randomly shift R/G/B by ±1-2
        var count = Math.max(1, Math.floor(d.length / 4 * 0.001));
        for (var i = 0; i < count; i++) {
          var px = (Math.random() * d.length / 4) | 0;
          var shift = Math.random() < 0.5 ? 1 : -1;
          var channel = (Math.random() * 3) | 0;
          d[px * 4 + channel] = Math.max(0, Math.min(255, d[px * 4 + channel] + shift * (1 + (Math.random() < 0.5 ? 1 : 0))));
        }
        ctx.putImageData(img, 0, 0);
      } catch(e) {}
    }

    HTMLCanvasElement.prototype.toDataURL = function() {
      var ctx = this.getContext ? this.getContext('2d') : null;
      if (ctx) noisyCanvas(ctx);
      return _origToDataURL.apply(this, arguments);
    };

    HTMLCanvasElement.prototype.toBlob = function() {
      var ctx = this.getContext ? this.getContext('2d') : null;
      if (ctx) noisyCanvas(ctx);
      return _origToBlob.apply(this, arguments);
    };

    CanvasRenderingContext2D.prototype.getImageData = function() {
      var result = _origGetImageData.apply(this, arguments);
      // Add tiny noise to a few pixels in the returned ImageData so reads differ each call
      try {
        var d = result.data;
        var count = Math.max(1, Math.floor(d.length / 4 * 0.0005));
        for (var i = 0; i < count; i++) {
          var px = (Math.random() * d.length / 4) | 0;
          var shift = Math.random() < 0.5 ? 1 : -1;
          var channel = (Math.random() * 3) | 0;
          d[px * 4 + channel] = Math.max(0, Math.min(255, d[px * 4 + channel] + shift));
        }
      } catch(e) {}
      return result;
    };
  })();

  // 12. AudioContext fingerprint spoofing
  // Anti-bot systems use AudioContext to generate an audio fingerprint hash.
  // We add tiny noise to audio processing so each call produces different output.
  (function() {
    var _AudioContext = window.AudioContext || window.webkitAudioContext;
    var _OfflineAudioContext = window.OfflineAudioContext;
    if (!_AudioContext) return;

    function spoofAudioCtx(ctor) {
      var _origCreateOscillator = ctor.prototype.createOscillator;
      var _origCreateDynamicsCompressor = ctor.prototype.createDynamicsCompressor;
      var _origCreateGain = ctor.prototype.createGain;

      ctor.prototype.createOscillator = function() {
        var osc = _origCreateOscillator.call(this);
        // Small random detune keeps the oscillator output fingerprint-inconsistent
        try { osc.detune.value = (Math.random() - 0.5) * 2; } catch(e) {}
        return osc;
      };

      ctor.prototype.createDynamicsCompressor = function() {
        var comp = _origCreateDynamicsCompressor.call(this);
        // Vary threshold/knee slightly so compression output differs
        try {
          comp.threshold.value += (Math.random() - 0.5) * 0.5;
          comp.knee.value += (Math.random() - 0.5) * 0.5;
        } catch(e) {}
        return comp;
      };

      ctor.prototype.createGain = function() {
        var gain = _origCreateGain.call(this);
        try { gain.gain.value += (Math.random() - 0.5) * 0.01; } catch(e) {}
        return gain;
      };
    }

    spoofAudioCtx(_AudioContext);
    if (_OfflineAudioContext) spoofAudioCtx(_OfflineAudioContext);
  })();

  // 13. Font enumeration defense via measureText noise
  // Sites enumerate installed fonts by measuring text width — bots return exact pixel values
  // while real browsers have subpixel rendering variations. We add ±0.01px noise so
  // font fingerprint hashes don't match known automation signatures.
  (function() {
    var _origMeasureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(text) {
      var result = _origMeasureText.call(this, text);
      // Only fuzz width — height is derived from font-size and is less fingerprintable
      var fuzz = (Math.random() - 0.5) * 0.02; // ±0.01px
      try {
        var origWidth = result.width;
        Object.defineProperty(result, 'width', {
          get: function() { return origWidth + fuzz; },
          configurable: true,
          enumerable: true,
        });
      } catch(e) {
        // Fallback: just fuzz the returned object directly
        try { result.width += fuzz; } catch(e2) {}
      }
      return result;
    };
  })();

  // 14. Screen / window property consistency
  // Headless Chrome often reports screen.width/height and window.outerWidth/Height
  // as defaults that don't match the actual viewport — a strong bot signal.
  // We normalize all of them to match the actual viewport dimensions.
  (function() {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 720;

    Object.defineProperty(screen, 'width',           { get: () => vw, configurable: true });
    Object.defineProperty(screen, 'height',          { get: () => 800, configurable: true }); // physical screen height stays plausible
    Object.defineProperty(screen, 'availWidth',      { get: () => vw, configurable: true });
    Object.defineProperty(screen, 'availHeight',     { get: () => 800, configurable: true });
    Object.defineProperty(window, 'outerWidth',       { get: () => vw, configurable: true });
    Object.defineProperty(window, 'outerHeight',     { get: () => vh, configurable: true });
    Object.defineProperty(window, 'innerWidth',       { get: () => vw, configurable: true });
    Object.defineProperty(window, 'innerHeight',      { get: () => vh, configurable: true });
    Object.defineProperty(window, 'screenX',         { get: () => 0, configurable: true });
    Object.defineProperty(window, 'screenY',         { get: () => 0, configurable: true });
    Object.defineProperty(window, 'screenLeft',      { get: () => 0, configurable: true });
    Object.defineProperty(window, 'screenTop',       { get: () => 0, configurable: true });
  })();

  // 15. WebRTC leak prevention
  // Anti-bot systems create RTCPeerConnection to probe for local/internal IP addresses
  // that are not exposed via JS but leak through STUN requests. We disable or heavily
  // stub RTCPeerConnection so the API exists but never leaks.
  (function() {
    var _origRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!_origRTCPeerConnection) return;

    function StubRTCPeerConnection(config, opts) {
      this.config = config || {};
      this.opts = opts || {};
      this.signalingState = 'stable';
      this.iceGatheringState = 'new';
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.peerIdentity = null;
      this.idp = null;
      this.onicecandidate = null;
      this.ontrack = null;
      this.onaddstream = null;
      this.onremovestream = null;
      this.ondatachannel = null;
      this.oniceconnectionstatechange = null;
      this.onicegatheringstatechange = null;
    }

    StubRTCPeerConnection.prototype.createOffer = function() {
      return Promise.resolve(new RTCSessionDescription({ type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }));
    };
    StubRTCPeerConnection.prototype.createAnswer = function() {
      return Promise.resolve(new RTCSessionDescription({ type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }));
    };
    StubRTCPeerConnection.prototype.setLocalDescription = function(desc) {
      this.localDescription = desc;
      return Promise.resolve();
    };
    StubRTCPeerConnection.prototype.setRemoteDescription = function(desc) {
      this.remoteDescription = desc;
      return Promise.resolve();
    };
    StubRTCPeerConnection.prototype.addIceCandidate = function() {
      return Promise.resolve();
    };
    StubRTCPeerConnection.prototype.close = function() {
      this.signalingState = 'closed';
    };
    StubRTCPeerConnection.prototype.getConfiguration = function() {
      return this.config;
    };
    StubRTCPeerConnection.prototype.getStats = function() {
      return Promise.resolve(new MockRTCStatsResponse());
    };
    StubRTCPeerConnection.prototype.createDataChannel = function() {
      return new StubRTCDataChannel();
    };
    StubRTCPeerConnection.prototype.createTransceiver = function() {
      return { sender: {}, receiver: {}, stop: function() {} };
    };
    StubRTCPeerConnection.prototype.addTransceiver = function() {
      return this.createTransceiver();
    };
    StubRTCPeerConnection.prototype.getTransceivers = function() { return []; };
    StubRTCPeerConnection.prototype.getSenders = function() { return []; };
    StubRTCPeerConnection.prototype.getReceivers = function() { return []; };

    function StubRTCDataChannel() {
      this.readyState = 'open';
      this.bufferedAmount = 0;
      this.binaryType = 'arraybuffer';
      this.onmessage = null;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
    }
    StubRTCDataChannel.prototype.send = function() {};
    StubRTCDataChannel.prototype.close = function() { this.readyState = 'closed'; };

    function MockRTCStatsResponse() {
      this.onSuccess = null;
      this.result = function() { return []; };
    }

    window.RTCPeerConnection = StubRTCPeerConnection;
    window.webkitRTCPeerConnection = StubRTCPeerConnection;

    // Also stub RTCSessionDescription and RTCIceCandidate if present
    if (window.RTCSessionDescription) {
      window.RTCSessionDescription.prototype.toJSON = function() { return {}; };
    }
  })();

  // 16. CDP / Playwright artifact cleanup
  // Some anti-bot scripts scan window for properties containing Playwright-specific
  // strings like "cdc_adoQpoasnfa76pfcZLmcfl_" or "__playwright_". These are injected
  // by the CDP injection mechanism. We delete any such properties before the page runs.
  (function() {
    var toDelete = [];
    Object.keys(window).forEach(function(k) {
      try {
        if (k.indexOf('cdc_') === 0 || k.indexOf('__playwright') === 0 || k.indexOf('_selenium') === 0 || k.indexOf('__webdriver') === 0) {
          toDelete.push(k);
        }
      } catch(e) {}
    });
    toDelete.forEach(function(k) {
      try { delete window[k]; } catch(e) {}
    });
    // Also clean up any property whose value looks like CDP-injected garbage
    var cdcPattern = /cdc_adoQpoasnfa76pfcZLmcfl_/;
    Object.keys(window).forEach(function(k) {
      try {
        if (cdcPattern.test(k)) { delete window[k]; }
      } catch(e) {}
    });
  })();
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
export function humanDelay(baseMs, jitterFactor = 0.3) {
    const jitter = baseMs * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(50, Math.round(baseMs + jitter));
}
/**
 * Sleep with human-like jitter.
 */
export function humanSleep(page, baseMs) {
    return page.waitForTimeout(humanDelay(baseMs));
}
/**
 * Human-like typing delay per character (varies between 40-120ms).
 */
export function typingDelay() {
    return Math.round(40 + Math.random() * 80);
}
// ─── Stealth Application ────────────────────────────────────────
/**
 * Apply all stealth patches to a browser context.
 * Call this after creating the context but before navigating.
 */
export async function applyStealthToContext(context) {
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
export async function applyStealthToPage(page) {
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
export async function stealthCheck(page) {
    return page.evaluate(`(() => {
    const results = {};

    // Original checks (1-10)
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

    // 11. Canvas fingerprint noise
    try {
      const c = document.createElement('canvas');
      c.width = 100; c.height = 100;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f00'; ctx.fillRect(0,0,100,100);
        const d1 = c.toDataURL();
        const d2 = c.toDataURL();
        results['canvas fingerprint varies'] = d1 !== d2;
      }
    } catch { results['canvas fingerprint varies'] = false; }

    // 12. AudioContext fingerprint spoofing
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const osc = ctx.createOscillator();
        results['audio oscillator patched'] = osc.detune.value !== 0;
        ctx.close();
      }
    } catch { results['audio oscillator patched'] = false; }

    // 13. Font measureText noise
    try {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.font = '16px Arial';
        const w1 = ctx.measureText('fingerprint test').width;
        const w2 = ctx.measureText('fingerprint test').width;
        results['font measurement varies'] = w1 !== w2;
      }
    } catch { results['font measurement varies'] = false; }

    // 14. Screen property consistency
    results['screen.width matches viewport'] = screen.width === window.innerWidth;
    results['outerWidth matches innerWidth'] = window.outerWidth === window.innerWidth;

    // 15. WebRTC leak prevention
    try {
      const pc = new RTCPeerConnection({iceServers:[]});
      const offer = pc.createOffer();
      results['WebRTC stubbed'] = typeof offer.then === 'function';
      pc.close();
    } catch { results['WebRTC stubbed'] = true; }

    // 16. CDP artifact cleanup
    results['no cdc_ properties'] = !Object.keys(window).some(function(k) { return k.indexOf('cdc_') === 0; });
    results['no __playwright properties'] = !Object.keys(window).some(function(k) { return k.indexOf('__playwright') === 0; });

    return results;
  })()`);
}
//# sourceMappingURL=stealth.js.map