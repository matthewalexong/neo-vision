#!/usr/bin/env tsx

/**
 * Demo: NeoVision in action
 *
 * Usage:
 *   npx tsx src/demo.ts [url]                   # Snapshot a page
 *   npx tsx src/demo.ts --stealth-check          # Run stealth self-test
 *   npx tsx src/demo.ts --mode stealth [url]     # Use real Chrome
 *   npx tsx src/demo.ts --mode attach --cdp http://localhost:9222 [url]
 *
 * Default URL: https://news.ycombinator.com
 */

import { SpatialBrowser } from "./index.js";
import type { BrowserMode } from "./schema.js";

// Parse args
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (key === "stealth-check") {
      flags[key] = "true";
    } else {
      flags[key] = args[++i] || "true";
    }
  } else {
    positional.push(args[i]);
  }
}

const mode = (flags.mode as BrowserMode) || "bundled";
const cdpUrl = flags.cdp;
const url = positional[0] || "https://news.ycombinator.com";
const stealthCheckMode = flags["stealth-check"] === "true";

async function main() {
  const browser = new SpatialBrowser({
    mode,
    cdpUrl,
    stealth: true,
  });

  try {
    if (stealthCheckMode) {
      console.log("Running stealth self-check...\n");

      // Navigate to a blank page to run checks
      await browser.snapshot("about:blank");
      const results = await browser.checkStealth();

      let allPassed = true;
      for (const [test, passed] of Object.entries(results)) {
        const icon = passed ? "✓" : "✗";
        const color = passed ? "\x1b[32m" : "\x1b[31m";
        console.log(`  ${color}${icon}\x1b[0m ${test}`);
        if (!passed) allPassed = false;
      }

      console.log(allPassed ? "\n✓ All stealth checks passed" : "\n✗ Some checks failed — review above");
      process.exit(allPassed ? 0 : 1);
    }

    console.error(`Mode: ${mode}`);
    console.error(`Navigating to ${url}...`);

    const start = Date.now();
    const map = await browser.snapshot(url);
    const elapsed = Date.now() - start;

    // Print the spatial map to stdout
    console.log(JSON.stringify(map, null, 2));

    // Print summary to stderr
    console.error(`\n─── Snapshot Summary ───`);
    console.error(`URL:        ${map.url}`);
    console.error(`Viewport:   ${map.viewport.width}x${map.viewport.height}`);
    console.error(`Page size:  ${map.page_bounds.width}x${map.page_bounds.height}`);
    console.error(`Elements:   ${map.stats.total_elements}`);
    console.error(`Actionable: ${map.stats.actionable_elements}`);
    console.error(`Focusable:  ${map.stats.focusable_elements}`);
    console.error(`Max depth:  ${map.stats.max_depth}`);
    console.error(`Time:       ${elapsed}ms`);
    console.error(`JSON size:  ${(JSON.stringify(map).length / 1024).toFixed(1)} KB`);

    // Show some interesting elements
    const links = map.elements.filter(e => e.role === "link" && e.actionable);
    const buttons = map.elements.filter(e => e.role === "button" && e.actionable);
    const inputs = map.elements.filter(e => e.tag === "input" || e.role === "textbox" || e.role === "searchbox");

    console.error(`\n─── Interactive Elements ───`);
    console.error(`Links:   ${links.length}`);
    console.error(`Buttons: ${buttons.length}`);
    console.error(`Inputs:  ${inputs.length}`);

    if (links.length > 0) {
      console.error(`\nFirst 5 links:`);
      for (const link of links.slice(0, 5)) {
        const label = link.label?.slice(0, 60) || "(no label)";
        console.error(`  → ${label} @ (${link.click_center?.x}, ${link.click_center?.y})`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
