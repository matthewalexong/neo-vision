# NeoVision Changelog

## Unreleased — anti-bot hardening + CSP fixes

### Critical fixes

- **`spatial_snapshot` works on CSP-strict sites.** Was failing silently on x.com, GitHub, banks, and any site with a strict `script-src` directive. Root cause: the extension was injecting the snapshot script via `<script>.textContent = ...` then appending to the DOM, which CSP blocks. Fix: bundled the snapshot as `extension/spatial-snapshot.js` and switched to the two-call `chrome.scripting.executeScript({files: [...]})` pattern — extension-bundled files bypass page CSP.

- **`spatial_execute_js` works on CSP-strict sites by default.** Defaults to `world: 'isolated'` (the extension's content-script context, no CSP applied, eval/Function work freely). DOM access is full; the only thing you lose is page-defined window globals. Pass `world: 'main'` for the legacy MAIN-world behavior (full page access, but breaks on CSP-strict sites).

### New: real OS-level mouse and keyboard

The previous `spatial_click` and `spatial_type` dispatched synthetic `MouseEvent` / `KeyboardEvent` via JavaScript — `event.isTrusted = false`, the single most common anti-bot tell. Now they default to **real OS-level CGEvents via cliclick** (`brew install cliclick`).

What changed in behavior:
- The cursor visibly moves to the target with eased animation (3–6 waypoints, 200–400ms total)
- Brief post-arrival pause (50–200ms) before the click
- ±3px coordinate jitter (humans don't click exact mathematical centers)
- Per-keystroke delays (60–180ms with occasional 300–900ms thinking pauses on word boundaries)
- `event.isTrusted` is `true`
- Chrome is auto-focused via osascript before each click (throttled to once per 5s)

Opt-outs:
- `stealth: false` — keep OS-level dispatch but skip animation/jitter (instant teleport-and-click)
- `synthetic: true` — fall back to the legacy in-page MouseEvent/KeyboardEvent dispatch (anti-bot detectable, breaks on CSP-strict sites — only for iframes / hidden elements that can't take real input)

If cliclick is missing, the tool returns a helpful error pointing at `brew install cliclick` rather than silently downgrading.

### New tool: `spatial_get_window_geometry`

Returns Chrome's screen position, chrome-bar height (for converting page coords → screen coords), current scroll offset, and devicePixelRatio. Used internally by the OS-level click/type. Exposed as a tool for debugging coordinate translation issues.

### Internal architecture

- New extension command: `get_window_geometry` in `extension/background.js` (uses `chrome.windows.get` + a small MAIN-world call for `devicePixelRatio`)
- New daemon endpoints: `/api/window_geometry`, `/api/click_os`, `/api/type_os` in `src/http-api.ts`
- New module: `src/os-input.ts` — cliclick wrapper, `pageToScreen()` helper, `ensureChromeFocused()`
- Schema additions: `stealth` (default true) and `synthetic` (default false) on `ClickInput` and `TypeInput`; `world` (default 'isolated') on `spatial_execute_js`

### Caveats

- DevTools open at the bottom of the Chrome window throws off the chrome-bar height calculation — cursor lands inside DevTools instead of the page. Close DevTools or dock them to the side.
- The user must grant Accessibility permission to whatever launches cliclick (System Settings → Privacy & Security → Accessibility) — same permission cliclick already needed.
- Chrome must be on the same physical monitor it was on when the snapshot was taken. The auto-focus call brings Chrome forward but doesn't prevent the user from dragging it to another display mid-run.
