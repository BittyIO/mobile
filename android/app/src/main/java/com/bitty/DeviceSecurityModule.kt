package com.bitty

import android.app.Activity
import android.os.Build
import android.os.Debug
import android.view.WindowManager
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.util.function.Consumer

/**
 * Android counterpart of ios/Bitty/DeviceSecurity.swift (see src/core/device-security.ts). Same JS surface:
 *
 * - isCompromised: root indicators + an attached debugger. Either means the OS can no longer keep the
 *   in-memory key from a local attacker, so the JS layer refuses to unlock.
 * - isScreenCaptured + "screenCaptureChanged" (Android 15+ screen-recording callback) and
 *   "screenshotTaken" (Android 14+ screenshot callback).
 * - setSecure (Android only): FLAG_SECURE on the window — the OS then blanks the app in screenshots,
 *   recordings, casts and the recents thumbnail. Stronger than iOS can offer, so the recovery-phrase
 *   screen turns it on while mounted.
 */
class DeviceSecurityModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), LifecycleEventListener {

  override fun getName() = "DeviceSecurity"

  private var listeners = 0
  private var captured = false
  private var registeredOn: Activity? = null
  private var shotCallback: Any? = null // Activity.ScreenCaptureCallback (API 34+)
  private var recordCallback: Consumer<Int>? = null // API 35+

  init {
    ctx.addLifecycleEventListener(this)
  }

  // ---- NativeEventEmitter plumbing ----

  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") event: String) {
    listeners++
    UiThreadUtil.runOnUiThread { register() }
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    listeners = maxOf(0, listeners - count.toInt())
    if (listeners == 0) UiThreadUtil.runOnUiThread { unregister() }
  }

  private fun emit(name: String, body: WritableMap?) {
    if (listeners == 0 || !ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, body)
  }

  // Callbacks are tied to an Activity; re-register across pause/resume so they follow the live one.
  override fun onHostResume() { if (listeners > 0) register() }
  override fun onHostPause() { unregister() }
  override fun onHostDestroy() { unregister() }

  private fun register() {
    val activity = ctx.currentActivity ?: return
    if (registeredOn === activity) return
    unregister()
    registeredOn = activity
    if (Build.VERSION.SDK_INT >= 34) {
      val cb = Activity.ScreenCaptureCallback { emit("screenshotTaken", null) }
      activity.registerScreenCaptureCallback(activity.mainExecutor, cb)
      shotCallback = cb
    }
    if (Build.VERSION.SDK_INT >= 35) {
      val cb = Consumer<Int> { state ->
        val now = state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE
        if (now != captured) {
          captured = now
          emit("screenCaptureChanged", Arguments.createMap().apply { putBoolean("captured", now) })
        }
      }
      val initial = activity.windowManager.addScreenRecordingCallback(activity.mainExecutor, cb)
      captured = initial == WindowManager.SCREEN_RECORDING_STATE_VISIBLE
      recordCallback = cb
    }
  }

  private fun unregister() {
    val activity = registeredOn ?: return
    if (Build.VERSION.SDK_INT >= 34) {
      (shotCallback as? Activity.ScreenCaptureCallback)?.let {
        runCatching { activity.unregisterScreenCaptureCallback(it) }
      }
    }
    if (Build.VERSION.SDK_INT >= 35) {
      recordCallback?.let { runCatching { activity.windowManager.removeScreenRecordingCallback(it) } }
    }
    shotCallback = null
    recordCallback = null
    registeredOn = null
  }

  // ---- JS API ----

  @ReactMethod
  fun isScreenCaptured(promise: Promise) {
    promise.resolve(captured)
  }

  @ReactMethod
  fun isCompromised(promise: Promise) {
    promise.resolve(rooted() || Debug.isDebuggerConnected() || Debug.waitingForDebugger())
  }

  @ReactMethod
  fun setSecure(on: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val window = ctx.currentActivity?.window
      if (window == null) {
        promise.resolve(false)
        return@runOnUiThread
      }
      if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      promise.resolve(true)
    }
  }

  // ---- detection ----

  private fun rooted(): Boolean {
    // Emulators ship su / test-keys images; mirror the iOS simulator exemption.
    if (isEmulator()) return false

    // 1. su / Magisk / Superuser binaries and apps.
    val paths = listOf(
      "/system/bin/su", "/system/xbin/su", "/sbin/su", "/su/bin/su", "/system/bin/.ext/su",
      "/system/sd/xbin/su", "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su",
      "/system/app/Superuser.apk", "/system/app/SuperSU.apk", "/sbin/.magisk", "/data/adb/magisk",
      "/cache/.disable_magisk", "/dev/.magisk.unblock",
    )
    if (paths.any { File(it).exists() }) return true

    // 2. A release-signed OS is built with release-keys; test-keys means a custom/unsigned ROM.
    if (Build.TAGS?.contains("test-keys") == true) return true

    // 3. Hooking frameworks loaded into this process.
    val maps = runCatching { File("/proc/self/maps").readText() }.getOrDefault("")
    if (listOf("frida", "xposed", "lsposed", "substrate", "riru", "zygisk").any { maps.contains(it, true) }) {
      return true
    }
    return false
  }

  private fun isEmulator(): Boolean =
      Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
          Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK built for") ||
          Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") ||
          Build.PRODUCT.contains("sdk")
}
