#!/bin/bash
# Launches a Chrome window with remote debugging enabled, using a dedicated profile.
# This avoids profile lock conflicts with your main Chrome session.
PROFILE_DIR="/tmp/neo-vision-chrome-profile"
mkdir -p "$PROFILE_DIR"
open -a "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check
echo "Chrome debug instance running on port 9222 with profile at $PROFILE_DIR"
echo "Connect with: browser_mode: 'attach', cdp_url: 'http://localhost:9222'"
