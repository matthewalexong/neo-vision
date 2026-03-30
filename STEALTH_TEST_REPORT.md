# NeoVision Stealth Test Report

**Date:** 2026-03-30
**Environment:** macOS, residential IP, Chrome (stealth mode via Playwright)
**NeoVision version:** 0.1.0

## Summary

NeoVision was tested against six websites known for aggressive anti-bot detection. All six were accessed without triggering any bot detection, CAPTCHAs, or challenge pages. On Ticketmaster, a full multi-step interaction (page load, search bar focus, typing, form submission) was completed successfully.

## Results

| Site | Anti-Bot Stack | Elements Rendered | Actionable | Bot Signals | Verdict |
|------|---------------|-------------------|------------|-------------|---------|
| Ticketmaster | PerimeterX / HUMAN | 879 | 777 | 0 | PASS |
| Nike | PerimeterX / HUMAN | 1,309 | 879 | 0 | PASS |
| LinkedIn | Custom + Arkose Labs | 275 | 145 | 0 | PASS |
| Instagram | Meta custom | 67 | 62 | 0 | PASS |
| Amazon | AWS WAF + custom | 1,399 | 1,028 | 0 | PASS |
| Discord | Cloudflare | 234 | 93 | 0 | PASS |

## Detection methodology

Each snapshot result was scanned for bot-detection keywords in element labels and text content: `captcha`, `robot`, `verify`, `blocked`, `access denied`, `bot`, `challenge`, `recaptcha`, `hcaptcha`, `cloudflare`, `distil`, `perimeterx`, `queue-it`, `are you human`, `unusual traffic`, `automated`, `just a moment`, `security check`.

A site was marked PASS only if it returned real page content (navigation, forms, product listings, etc.) with zero matches on any detection keyword.

## Test details

### Ticketmaster (multi-step interaction)

This was the most thorough test, going beyond a simple page load to verify that interactive behavior also passes detection.

**Step 1 — Page load:**
`spatial_snapshot(url="https://www.ticketmaster.com", browser_mode="stealth", settle_ms=5000)`
Result: 879 elements, full homepage with navigation, country selector, search form, event listings, and footer. Page height 6,108px.

**Step 2 — Search bar interaction:**
`spatial_type(text="Drake concert Los Angeles", x=842, y=181, press_enter=true)`
This exercised:
- Bezier mouse movement from a random start position to the search input
- Jittered click target (±3px from element center)
- 80ms hover pause before clicking
- Character-by-character typing with variable 40–120ms delay per keystroke
- Longer pauses between words
- 5% chance of mid-word hesitation pauses (150–350ms)
- Enter key with 200ms pre-press delay

Result: Navigated to `ticketmaster.com/search?q=Drake+concert+Los+Angeles`. 174 elements rendered, including the heading "0 Results for Drake concert Los Angeles" (no events matched, but real search results were served — not a bot wall).

### Nike

`spatial_snapshot(url="https://www.nike.com", browser_mode="stealth", settle_ms=5000)`

Result: 1,309 elements. Full homepage with "Jordan", "Converse", "Find a Store" navigation links. Nike uses the same PerimeterX/HUMAN stack as Ticketmaster but with tighter tuning for sneaker-bot detection.

### LinkedIn

`spatial_snapshot(url="https://www.linkedin.com", browser_mode="stealth", settle_ms=5000)`

Result: 275 elements. Full public homepage with "Sign in", "Jobs", "Learning", "Games" navigation. LinkedIn is known for aggressive fingerprint + session-based bot detection.

### Instagram

`spatial_snapshot(url="https://www.instagram.com", browser_mode="stealth", settle_ms=5000)`

Result: 67 elements. Complete login page with username/password fields (form id `login_form`), "Log In" button, "Log in with Facebook" button, "Create new account" link, Meta logo, and full footer with language selector.

### Amazon

`spatial_snapshot(url="https://www.amazon.com", browser_mode="stealth", settle_ms=5000)`

Result: 1,399 elements. Full homepage with keyboard shortcuts, navigation categories, product listings. Amazon uses a custom detection stack built on AWS WAF.

### Discord

`spatial_snapshot(url="https://discord.com", browser_mode="stealth", settle_ms=5000)`

Result: 234 elements. Full marketing homepage with "Download", "Nitro", "Discover", "Safety", "Blog", "Developers" navigation. Discord sits behind Cloudflare's bot management, which is known for its JavaScript challenge pages ("Checking your browser...").

## Stealth features that made this possible

### Fingerprint evasion (stealth.ts)

These patches run via `addInitScript()` before any page JavaScript executes:

1. **navigator.webdriver** — Removed from both the navigator object and its prototype
2. **window.chrome** — Present with runtime object (missing in headless Chromium)
3. **Permissions API** — Returns consistent notification permission results
4. **Plugin/MIME arrays** — Populated with standard Chrome PDF plugins (headless has 0)
5. **WebGL renderer** — Reports NVIDIA GPU instead of "Google SwiftShader"
6. **navigator.languages** — Set to `['en-US', 'en']`
7. **navigator.platform** — Reports real platform instead of empty string
8. **iframe contentWindow** — Patched to prevent headless leak detection
9. **connection.rtt** — Reports 50ms instead of automation-typical values
10. **toString() detection** — Proxied to return `[native code]` for patched functions

### Human-like behavioral simulation (actions.ts)

These run at the Playwright level during every `spatial_click`, `spatial_type`, and `spatial_scroll` call:

1. **Bezier mouse movement** — Cursor traces a cubic bezier curve from its current position to the target, with randomized control points, ease-in-out timing, and 12–60 intermediate steps scaled by distance
2. **Click target jitter** — Clicks land within a ±3px radius of the element's mathematical center, at a random angle
3. **Hover pause** — 80ms (±jitter) delay between arriving at an element and clicking it
4. **Variable typing speed** — Each character typed with 40–120ms random delay; spaces get an extra 0–60ms pause; 5% of characters trigger a 150–350ms "thinking hesitation"
5. **Incremental scrolling** — Scroll distance is broken into 3–12 wheel ticks with per-tick jitter (±5px), variable inter-tick timing
6. **Mouse position tracking** — Cursor position persists across calls so subsequent movements start from where the last one ended, not from (0,0)

## Limitations and caveats

- **IP reputation matters.** These tests were run from a residential IP. The same fingerprint evasion on a Hetzner/AWS/GCP data center IP will likely fail on Ticketmaster and Nike, because PerimeterX/HUMAN maintains blocklists of hosting provider IP ranges. A residential proxy would be needed for server-side deployment.
- **Login flows not tested.** All tests hit public pages. Login-gated flows may have additional detection (rate limiting, device fingerprinting on the account level, risk-based authentication).
- **Single session.** Tests were run sequentially in a single browser session. Rapid-fire parallel sessions from the same IP may trigger rate-based detection.
- **No JavaScript challenge solving.** If a site serves a JavaScript challenge (like Cloudflare's "Checking your browser..."), NeoVision does not automatically solve it. The stealth patches prevent the challenge from appearing in the first place.
