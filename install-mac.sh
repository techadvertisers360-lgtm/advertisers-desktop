#!/bin/bash
# Advertisers360 Agent — one-line macOS installer.
#
#   curl -fsSL https://raw.githubusercontent.com/techadvertisers360-lgtm/advertisers-desktop/main/install-mac.sh | bash
#
# Why this exists: the agent isn't signed with an Apple Developer ID yet, so
# a .dmg downloaded in a BROWSER gets the "quarantine" flag and macOS refuses
# to open it ("unidentified developer"). Files fetched with curl don't get
# that flag, so installing this way opens normally. Once the build is
# signed + notarized (see .github/workflows/build-mac-agent.yml), the plain
# .dmg download works too and this script is just a convenience.
set -euo pipefail

APP_NAME="Advertisers360 Agent"
DMG_URL="https://github.com/techadvertisers360-lgtm/advertisers-desktop/releases/latest/download/Advertiser360Agent-Mac.dmg"

echo "==> Downloading ${APP_NAME}..."
TMP_DIR="$(mktemp -d)"
trap 'hdiutil detach "${MOUNT_DIR:-/nonexistent}" -quiet >/dev/null 2>&1 || true; rm -rf "$TMP_DIR"' EXIT
curl -fL --progress-bar -o "$TMP_DIR/agent.dmg" "$DMG_URL"

echo "==> Installing..."
MOUNT_DIR="$(hdiutil attach -nobrowse -noautoopen -readonly "$TMP_DIR/agent.dmg" | grep -o '/Volumes/.*' | head -1)"
if [ -z "$MOUNT_DIR" ] || [ ! -d "$MOUNT_DIR/$APP_NAME.app" ]; then
  echo "Could not open the installer image." >&2
  exit 1
fi

# Close a running copy so it can be replaced (it restarts below).
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
pkill -f "$APP_NAME.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 1

# /Applications needs an admin account; fall back to ~/Applications.
DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
rm -rf "$DEST_DIR/$APP_NAME.app"
cp -R "$MOUNT_DIR/$APP_NAME.app" "$DEST_DIR/"

# Belt and braces: clear any quarantine flag and give the app a local
# ad-hoc signature so it launches on both Intel and Apple Silicon Macs.
xattr -dr com.apple.quarantine "$DEST_DIR/$APP_NAME.app" >/dev/null 2>&1 || true
codesign --force --deep --sign - "$DEST_DIR/$APP_NAME.app" >/dev/null 2>&1 || true

echo "==> Starting ${APP_NAME}..."
open "$DEST_DIR/$APP_NAME.app"
echo "Done. The agent is installed in $DEST_DIR and will start automatically from now on."
