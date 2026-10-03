import {useEffect, useState} from 'react';
import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

/**
 * Device-integrity + screen-capture checks for the key-handling screens.
 *
 * The private key is used in software (the mnemonic enters JS memory at sign time), so a jailbroken
 * or debugged device — or a screen being recorded while the recovery phrase is on screen — can lift
 * it. These guards shrink that window: refuse to unlock on a compromised device, warn on an out-of-
 * date iOS missing an actively-exploited fix, and hide the phrase while the screen is captured.
 *
 * The jailbreak/debugger and screen-capture checks need the native module in
 * `ios/Bitty/DeviceSecurity.{swift,m}` — add both files to the Bitty target in Xcode and rebuild.
 * Until then every native call DEGRADES SAFELY (compromise → false, capture → false), so the JS runs
 * unchanged; only the iOS-version check (pure JS) is live before the native module is wired in.
 */

type DeviceSecurityNative = {
  isCompromised(): Promise<boolean>;
  isScreenCaptured(): Promise<boolean>;
};

const Native = (NativeModules as {DeviceSecurity?: DeviceSecurityNative})
  .DeviceSecurity;

/** True once the native module is built into the app (jailbreak + capture detection are live). */
export const deviceSecurityNativeReady = !!Native;

/**
 * iOS floor: the first build carrying the fix for the actively-exploited CoreGraphics RCE
 * (CVE-2026-86950, used in targeted spyware chains), patched in iOS 26.7.1 and iOS 27. Below this a
 * device may be missing it. Bump this as new actively-exploited fixes ship. This drives a WARNING,
 * not a block — blocking an old-iOS user out of their vault could strand funds.
 */
export const MIN_SAFE_IOS = '26.7.1';

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type IosVersionRisk = {ok: boolean; version: string; floor: string};

/** Whether the running iOS is at or above {@link MIN_SAFE_IOS}. Pure JS — live without the native module. */
export function iosVersionRisk(): IosVersionRisk {
  const version = String(Platform.Version);
  if (Platform.OS !== 'ios') return {ok: true, version, floor: MIN_SAFE_IOS};
  return {ok: cmpVersion(version, MIN_SAFE_IOS) >= 0, version, floor: MIN_SAFE_IOS};
}

/**
 * Whether this device looks jailbroken or a debugger/instrumentation is attached — either means the
 * OS can no longer protect the key. Returns false ("can't tell") until the native module is built in.
 */
export async function deviceCompromised(): Promise<boolean> {
  if (!Native) return false;
  try {
    return await Native.isCompromised();
  } catch {
    return false;
  }
}

/** Whether the screen is being mirrored/recorded right now (screen recording, AirPlay, QuickTime). */
export async function isScreenCaptured(): Promise<boolean> {
  if (!Native) return false;
  try {
    return await Native.isScreenCaptured();
  } catch {
    return false;
  }
}

const emitter = Native
  ? new NativeEventEmitter(NativeModules.DeviceSecurity as never)
  : null;

/** Subscribe to screen capture (recording/mirroring) starting or stopping. Returns an unsubscribe fn. */
export function onScreenCaptureChange(cb: (captured: boolean) => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('screenCaptureChanged', (e: {captured?: boolean}) =>
    cb(!!e?.captured),
  );
  return () => sub.remove();
}

/** Subscribe to "the user took a screenshot". Returns an unsubscribe fn. */
export function onScreenshot(cb: () => void): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener('screenshotTaken', () => cb());
  return () => sub.remove();
}

export type RevealGuard = {
  /** The screen is being recorded/mirrored now — hide any secret from the frame. */
  captured: boolean;
  /** A screenshot was taken while this guard was mounted — warn and re-hide the secret. */
  screenshotCount: number;
};

/**
 * Guard state for a screen that shows a secret (the recovery phrase). `captured` is true whenever the
 * screen is being recorded, so the caller can swap the secret for a placeholder; `screenshotCount`
 * ticks up on each screenshot so the caller can hide the secret and warn. Inert (never trips) until
 * the native module is built in — true screenshot PREVENTION needs the native layer.
 */
export function useRevealGuard(): RevealGuard {
  const [captured, setCaptured] = useState(false);
  const [screenshotCount, setScreenshotCount] = useState(0);
  useEffect(() => {
    let live = true;
    void isScreenCaptured().then((c) => {
      if (live) setCaptured(c);
    });
    const offCapture = onScreenCaptureChange((c) => setCaptured(c));
    const offShot = onScreenshot(() => setScreenshotCount((n) => n + 1));
    return () => {
      live = false;
      offCapture();
      offShot();
    };
  }, []);
  return {captured, screenshotCount};
}
