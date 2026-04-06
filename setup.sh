#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# NeoVision Bridge — Setup Script
#
# Sets up the NeoVision Chrome extension + MCP bridge so any
# AI agent (Hermes, Claude Code, LangChain, etc.) can control
# a real Chrome browser via MCP tools.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/matthewalexong/neo-vision/main/setup.sh | bash
#   — or —
#   git clone https://github.com/matthewalexong/neo-vision && cd neo-vision && ./setup.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║         NeoVision Bridge — Setup                 ║${NC}"
echo -e "${CYAN}${BOLD}║  See the web the way Neo sees the Matrix.        ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Prereqs ──────────────────────────────────────────────────

echo -e "${BOLD}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found.${NC} Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗ Node.js $NODE_VERSION found, but 18+ is required.${NC}"
  exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ npm not found.${NC}"
  exit 1
fi
echo -e "${GREEN}✓${NC} npm $(npm -v)"

# Check Chrome (macOS, Linux, Windows/WSL)
CHROME_FOUND=false
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [ -d "/Applications/Google Chrome.app" ]; then
    CHROME_FOUND=true
    echo -e "${GREEN}✓${NC} Google Chrome (macOS)"
  fi
elif command -v google-chrome &> /dev/null || command -v google-chrome-stable &> /dev/null; then
  CHROME_FOUND=true
  echo -e "${GREEN}✓${NC} Google Chrome (Linux)"
fi

if [ "$CHROME_FOUND" = false ]; then
  echo -e "${YELLOW}⚠ Chrome not detected.${NC} You'll need Chrome to load the extension."
fi

echo ""

# ─── Determine install mode ──────────────────────────────────

# Are we running from inside the neo-vision repo?
IN_REPO=false
if [ -f "package.json" ] && grep -q '"neo-vision"' package.json 2>/dev/null; then
  IN_REPO=true
fi

# ─── Install neo-vision ──────────────────────────────────────

if [ "$IN_REPO" = true ]; then
  echo -e "${BOLD}Installing from local repo...${NC}"
  npm install
  npm run build
  NEOVISION_DIR="$(pwd)"
  echo -e "${GREEN}✓${NC} Built from source"
else
  echo -e "${BOLD}Installing neo-vision from npm...${NC}"
  npm install -g neo-vision
  NEOVISION_DIR="$(npm root -g)/neo-vision"
  echo -e "${GREEN}✓${NC} Installed neo-vision globally"
fi

echo ""

# ─── Copy extension to user-friendly location ────────────────

EXTENSION_SRC="$NEOVISION_DIR/extension"
EXTENSION_DEST="$HOME/NeoVision-Bridge-Extension"

if [ ! -d "$EXTENSION_SRC" ]; then
  echo -e "${RED}✗ Extension folder not found at $EXTENSION_SRC${NC}"
  echo "  This shouldn't happen. Try reinstalling neo-vision."
  exit 1
fi

if [ -d "$EXTENSION_DEST" ]; then
  echo -e "${YELLOW}⚠ $EXTENSION_DEST already exists. Updating...${NC}"
  rm -rf "$EXTENSION_DEST"
fi

cp -r "$EXTENSION_SRC" "$EXTENSION_DEST"
echo -e "${GREEN}✓${NC} Extension copied to ${BOLD}$EXTENSION_DEST${NC}"
echo ""

# ─── Detect AI agent framework ──────────────────────────────

echo -e "${BOLD}Configuring MCP server...${NC}"

HERMES_CONFIG="$HOME/.hermes/config.yaml"
CLAUDE_CODE_CONFIG="$HOME/.claude/claude_desktop_config.json"
CONFIGURED=false

# Hermes
if [ -f "$HERMES_CONFIG" ]; then
  echo -e "  Found ${CYAN}Hermes${NC} config at $HERMES_CONFIG"

  if grep -q "neo-vision" "$HERMES_CONFIG" 2>/dev/null; then
    # Check if --bridge flag already present
    if grep -A5 "neo-vision" "$HERMES_CONFIG" | grep -q "\-\-bridge"; then
      echo -e "  ${GREEN}✓${NC} NeoVision already configured with --bridge flag"
    else
      echo -e "  ${YELLOW}⚠${NC} NeoVision found but missing --bridge flag."
      echo -e "  Add ${BOLD}--bridge${NC} to the args in your Hermes config:"
      echo ""
      echo -e "    ${CYAN}mcp_servers:"
      echo -e "      neo-vision:"
      echo -e "        command: neo-vision"
      echo -e "        args:"
      echo -e "        - --bridge${NC}"
      echo ""
    fi
  else
    echo -e "  To add NeoVision to Hermes, add this to $HERMES_CONFIG:"
    echo ""
    echo -e "    ${CYAN}mcp_servers:"
    echo -e "      neo-vision:"
    echo -e "        command: neo-vision"
    echo -e "        args:"
    echo -e "        - --bridge"
    echo -e "        timeout: 120"
    echo -e "        connect_timeout: 30${NC}"
    echo ""
  fi
  CONFIGURED=true
fi

# Claude Code / Claude Desktop
if [ -f "$CLAUDE_CODE_CONFIG" ]; then
  echo -e "  Found ${CYAN}Claude Desktop${NC} config at $CLAUDE_CODE_CONFIG"
  if grep -q "neo-vision" "$CLAUDE_CODE_CONFIG" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} NeoVision already in Claude Desktop config"
  else
    echo -e "  To add NeoVision to Claude Desktop, add this to mcpServers:"
    echo ""
    echo -e "    ${CYAN}\"neo-vision\": {"
    echo -e "      \"command\": \"neo-vision\","
    echo -e "      \"args\": [\"--bridge\"]"
    echo -e "    }${NC}"
    echo ""
  fi
  CONFIGURED=true
fi

if [ "$CONFIGURED" = false ]; then
  echo -e "  No known agent framework detected."
  echo -e "  Start the bridge server manually with:"
  echo ""
  echo -e "    ${CYAN}neo-vision --bridge${NC}"
  echo ""
  echo -e "  Or use the programmatic API:"
  echo ""
  echo -e "    ${CYAN}import { ChromeBridge } from 'neo-vision';"
  echo -e "    const bridge = new ChromeBridge();"
  echo -e "    await bridge.start();${NC}"
  echo ""
fi

# ─── Chrome extension loading instructions ────────────────────

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD} FINAL STEP: Load the Chrome extension${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  1. Open Chrome and go to ${BOLD}chrome://extensions${NC}"
echo -e "  2. Enable ${BOLD}Developer mode${NC} (toggle in top-right)"
echo -e "  3. Click ${BOLD}\"Load unpacked\"${NC}"
echo -e "  4. Select: ${BOLD}$EXTENSION_DEST${NC}"
echo ""
echo -e "  The extension icon will show a ${RED}red OFF${NC} badge until"
echo -e "  your AI agent starts the MCP server with ${BOLD}--bridge${NC}."
echo -e "  Once connected, the badge turns ${GREEN}green ON${NC}."
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${NC} 🎉"
echo ""
echo -e "Quick test:"
echo -e "  ${CYAN}neo-vision --bridge${NC}    # start the bridge server"
echo -e "  Then click ${BOLD}Connect${NC} in the extension popup."
echo ""
echo -e "Docs: ${CYAN}https://github.com/matthewalexong/neo-vision#bridge${NC}"
echo ""
