#!/usr/bin/env bash
#
# Build the signed Android App Bundle (.aab) to upload to Google Play.
#
# Play takes an App Bundle, not an APK, signed with the app's UPLOAD key: android/keystore.properties
# plus the keystore file it names, both gitignored and kept only on the machine that releases. This
# checks everything that machine needs before the long Gradle build starts, rather than failing
# halfway through it, then builds, verifies the signature, and prints where the bundle is.
#
#   scripts/android-play-release.sh
#
# The version is package.json's ("1.0.7" → versionName 1.0.7, versionCode 10007), the same as iOS.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

# ── Source ────────────────────────────────────────────────────────────────────────────────────────
BRANCH=$(git branch --show-current)
echo "==> Branch: $BRANCH ($(git rev-parse --short HEAD))"
case "$BRANCH" in
  release/*) ;;
  *) echo "warning: not on a release/* branch — the store build is normally cut from one." >&2 ;;
esac
[ -z "$(git status --porcelain)" ] || fail "uncommitted changes: commit or stash them so the bundle matches the branch."
git fetch -q origin "$BRANCH" 2>/dev/null && {
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] ||
    fail "this branch differs from origin/$BRANCH: pull (or push) first."
}

# ── Toolchain ─────────────────────────────────────────────────────────────────────────────────────
# JDK 17: the one on PATH, else Android Studio's bundled JBR.
if ! java -version 2>&1 | grep -q 'version "17'; then
  JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  if [ -x "$JBR/bin/java" ]; then
    export JAVA_HOME="$JBR"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
fi
java -version 2>&1 | grep -qE 'version "(17|21)' || fail "JDK 17 not found: install Android Studio (bundled JBR) or Zulu 17."
echo "==> Java: $(java -version 2>&1 | head -1)"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME/platforms/android-36" ] || fail "Android SDK 36 not found under $ANDROID_HOME: install it in Android Studio → SDK Manager (or set ANDROID_HOME)."
[ -d "$ANDROID_HOME/build-tools/36.0.0" ] || fail "build-tools 36.0.0 missing: Android Studio → SDK Manager → SDK Tools."
[ -d "$ANDROID_HOME/ndk/27.1.12297006" ] || fail "NDK 27.1.12297006 missing: Android Studio → SDK Manager → SDK Tools → NDK (Side by side)."
command -v node >/dev/null || fail "node not found (>= 20): Gradle runs it to bundle the JS."
echo "==> Node: $(node -v), Android SDK: $ANDROID_HOME"

# ── Upload key ────────────────────────────────────────────────────────────────────────────────────
PROPS=android/keystore.properties
[ -f "$PROPS" ] || fail "$PROPS missing. It holds storeFile, storePassword, keyAlias, keyPassword for the Play upload key (see README → Android)."
STORE_FILE=$(grep -E '^storeFile=' "$PROPS" | cut -d= -f2-)
[ -n "$STORE_FILE" ] && [ -f "android/$STORE_FILE" ] || fail "the keystore $PROPS names (android/$STORE_FILE) is not there."

# ── Build ─────────────────────────────────────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")
CODE=$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+c")
echo "==> Installing JS dependencies"
npm ci
echo "==> Building bundleRelease $VERSION (versionCode $CODE)"
(cd android && ./gradlew --no-daemon clean bundleRelease)

AAB=android/app/build/outputs/bundle/release/app-release.aab
[ -f "$AAB" ] || fail "the build finished but $AAB is not there."
OUT="android/app/build/outputs/bundle/release/bitty-$VERSION-$CODE.aab"
cp "$AAB" "$OUT"

# Signed with the upload key, not the debug one: Play refuses a debug-signed bundle, and says so only
# after the upload. The certificate's SHA-256 is what Play Console shows as the upload key.
jarsigner -verify "$OUT" >/dev/null || fail "$OUT is not signed."
CERT=$(keytool -printcert -jarfile "$OUT" 2>/dev/null)
echo "$CERT" | grep -q "CN=Android Debug" && fail "$OUT is signed with the DEBUG key: check $PROPS."
echo "==> Signed by: $(echo "$CERT" | grep -m1 'Owner:' | sed 's/^ *Owner: //')"
echo "    SHA-256:  $(echo "$CERT" | grep -m1 'SHA256:' | sed 's/^ *SHA256: //')"

echo
echo "Done: $OUT"
echo "Upload it in Play Console → Bitty → Test and release → Production (or a testing track) → Create new release."
