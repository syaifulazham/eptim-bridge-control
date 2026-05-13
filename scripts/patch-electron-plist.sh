#!/usr/bin/env bash
# Patches the dev Electron binary's Info.plist so macOS 10.15+ shows the
# Local Network permission dialog when the app uses UDP.
#
# Two keys are patched:
#   CFBundleIdentifier        → com.eptim.bridge-control
#     Without this, TCC sees every Electron dev app under the shared
#     com.github.Electron ID; a prior TCC decision for that ID (from any
#     Electron app ever installed) silently applies and no dialog appears.
#   NSLocalNetworkUsageDescription
#     The usage string macOS shows in the permission dialog and System Settings.
#
# Re-signs with an ad-hoc signature afterwards.
# Run automatically via npm postinstall; safe to run manually too.

set -euo pipefail

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
APP="node_modules/electron/dist/Electron.app"

if [ ! -f "$PLIST" ]; then
  echo "[patch-plist] $PLIST not found — skipping (non-macOS or electron not installed)"
  exit 0
fi

PATCHED=0

# 1. Patch bundle identifier
BUNDLE_ID_KEY="CFBundleIdentifier"
TARGET_BUNDLE_ID="com.eptim.bridge-control"
CURRENT_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :${BUNDLE_ID_KEY}" "$PLIST" 2>/dev/null || true)

if [ "$CURRENT_BUNDLE_ID" = "$TARGET_BUNDLE_ID" ]; then
  echo "[patch-plist] $BUNDLE_ID_KEY already set to $TARGET_BUNDLE_ID"
else
  /usr/libexec/PlistBuddy -c "Set :${BUNDLE_ID_KEY} ${TARGET_BUNDLE_ID}" "$PLIST"
  echo "[patch-plist] Set $BUNDLE_ID_KEY → $TARGET_BUNDLE_ID (was: $CURRENT_BUNDLE_ID)"
  PATCHED=1
fi

# 2. Patch local network usage description
LN_KEY="NSLocalNetworkUsageDescription"
LN_VALUE="Eptim Bridge Control needs local network access to communicate with the LiteBee Wing drone over WiFi."

if /usr/libexec/PlistBuddy -c "Print :${LN_KEY}" "$PLIST" &>/dev/null; then
  echo "[patch-plist] $LN_KEY already present"
else
  /usr/libexec/PlistBuddy -c "Add :${LN_KEY} string ${LN_VALUE}" "$PLIST"
  echo "[patch-plist] Added $LN_KEY"
  PATCHED=1
fi

# 3. Re-sign only if we changed something
if [ "$PATCHED" = "1" ]; then
  codesign --force --deep --sign - "$APP" 2>/dev/null \
    && echo "[patch-plist] Re-signed $APP (ad-hoc)" \
    || echo "[patch-plist] codesign failed — you may need to sign manually"
else
  echo "[patch-plist] Nothing changed — skipping re-sign"
fi
