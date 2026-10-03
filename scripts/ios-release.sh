#!/usr/bin/env bash
#
# Build, install and launch the Release app on a connected iPhone.
#
# `react-native run-ios --mode Release` cannot do this here: to put a build on a PHYSICAL device
# the CLI shells out to `ios-deploy`, a Homebrew package this machine does not have — and the run
# fails at the install step after reporting exit code 0, which reads as success. Xcode itself
# stopped needing that tool at iOS 17; `devicectl` ships with Xcode and talks to the device
# directly, so this goes the same way Xcode's own Run button does and adds no dependency.
#
# Release bundles the JS into the app: Metro is not involved, there is no dev menu or fast refresh,
# and a change under src/ needs a rebuild to appear.
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME=Bitty
BUNDLE_ID=io.bitty.vault
DERIVED=ios/build/release
APP="$DERIVED/Build/Products/Release-iphoneos/$SCHEME.app"

# The first connected device. Read from the JSON rather than the table, whose columns move.
DEVICES=$(mktemp)
trap 'rm -f "$DEVICES"' EXIT
xcrun devicectl list devices --json-output "$DEVICES" >/dev/null
UDID=$(python3 -c '
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    if d.get("connectionProperties", {}).get("tunnelState") != "unavailable":
        print(d["hardwareProperties"]["udid"])
        break
' "$DEVICES")

if [ -z "$UDID" ]; then
  echo "No connected iPhone. Plug one in (or trust it), then run this again." >&2
  exit 1
fi

echo "==> Building $SCHEME (Release) for $UDID"
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" -configuration Release \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" build

echo "==> Installing"
xcrun devicectl device install app --device "$UDID" "$APP"

echo "==> Launching"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID"
