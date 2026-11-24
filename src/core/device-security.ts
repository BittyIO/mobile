import {useEffect, useState} from 'react';
import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

/**
 * Device-integrity + screen-capture checks for the key-handling screens.
 *
 * The private key is used in software (the mnemonic enters JS memory at sign time), so a jailbroken
 * or debugged device — or a screen being recorded while the recovery phrase is on screen — can lift
 * it. These guards shrink that window: refuse to unlock on a compromised device and hide the phrase
 * while the screen is captured.
 *
 * The jailbreak/debugger and screen-capture checks need the native module in
 * `ios/Bitty/DeviceSecurity.{swift,m}` — add both files to the Bitty target in Xcode and rebuild.
 * Until then every native call DEGRADES SAFELY (compromise → false, capture → false), so the JS runs
 * unchanged.
 *
 * Android: the same module lives in `android/app/src/main/java/com/bitty/DeviceSecurityModule.kt`
 * (root/debugger checks, Android 14+ screenshot and 15+ recording events) and adds `setSecure`, which
 * sets FLAG_SECURE so the OS blanks the window in screenshots, recordings and the recents thumbnail.
 */

type DeviceSecurityNative = {
  isCompromised(): Promise<boolean>;
  isScreenCaptured(): Promise<boolean>;
  /** Android only: FLAG_SECURE on the window (blocks screenshots/recording of the app). */
  setSecure?(on: boolean): Promise<boolean>;
};

const Native = (NativeModules as {DeviceSecurity?: DeviceSecurityNative})
  .DeviceSecurity;

/** True once the native module is built into the app (jailbreak + capture detection are live). */
export const deviceSecurityNativeReady = !!Native;

/**
 * Whether this device looks jailbroken or a debugger/instrumentation is attached — either means the
 * OS can no longer protect the key. 'unavailable' when the check cannot run: the native module is
 * missing from the build (a packaging or registration failure) or it threw. That is said out loud
 * (see LockScreen) rather than read as "not compromised", so a broken build does not silently turn
 * the protection off.
 */
export type DeviceSecurityState = 'ok' | 'compromised' | 'unavailable';

export async function deviceSecurityState(): Promise<DeviceSecurityState> {
  if (!Native) return 'unavailable';
  try {
    return (await Native.isCompromised()) ? 'compromised' : 'ok';
  } catch {
    return 'unavailable';
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

/** Android: block screenshots/recording of the window while `on` (FLAG_SECURE). No-op on iOS. */
export async function setScreenSecure(on: boolean): Promise<void> {
  if (Platform.OS !== 'android' || !Native?.setSecure) return;
  try {
    await Native.setSecure(on);
  } catch {
    // best effort — the capture/screenshot listeners still hide the phrase
  }
}

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
    void setScreenSecure(true);
    return () => {
      live = false;
      void setScreenSecure(false);
      offCapture();
      offShot();
    };
  }, []);
  return {captured, screenshotCount};
}
