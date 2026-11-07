import Foundation
import MachO
import React
import UIKit

/**
 * Native device-integrity + screen-capture checks for the key screens (see src/core/device-security.ts).
 *
 * - isCompromised: jailbreak indicators + a debugger/trace check. Either means the OS can no longer
 *   keep the in-memory key from a local attacker, so the JS layer refuses to unlock.
 * - isScreenCaptured + the two events: so the recovery-phrase screen can hide the phrase while the
 *   screen is being recorded/mirrored, and warn after a screenshot.
 *
 * Add this file AND DeviceSecurity.m to the Bitty target in Xcode, then rebuild. No bridging header
 * is required (the .m registers this class with React via RCT_EXTERN_MODULE).
 */
@objc(DeviceSecurity)
class DeviceSecurity: RCTEventEmitter {
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { return true }

  override func supportedEvents() -> [String]! {
    return ["screenCaptureChanged", "screenshotTaken"]
  }

  override func startObserving() {
    hasListeners = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(onCaptureChanged),
      name: UIScreen.capturedDidChangeNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(onScreenshot),
      name: UIApplication.userDidTakeScreenshotNotification, object: nil)
  }

  override func stopObserving() {
    hasListeners = false
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func onCaptureChanged() {
    guard hasListeners else { return }
    sendEvent(withName: "screenCaptureChanged", body: ["captured": UIScreen.main.isCaptured])
  }

  @objc private func onScreenshot() {
    guard hasListeners else { return }
    sendEvent(withName: "screenshotTaken", body: nil)
  }

  @objc(isScreenCaptured:rejecter:)
  func isScreenCaptured(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter _: @escaping RCTPromiseRejectBlock) {
    resolve(UIScreen.main.isCaptured)
  }

  @objc(isCompromised:rejecter:)
  func isCompromised(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter _: @escaping RCTPromiseRejectBlock) {
    resolve(DeviceSecurity.jailbroken() || DeviceSecurity.debugged())
  }

  // MARK: - detection

  private static func jailbroken() -> Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    // 1. Tell-tale files a jailbreak drops outside the sandbox.
    let paths = [
      "/Applications/Cydia.app", "/Applications/Sileo.app",
      "/Library/MobileSubstrate/MobileSubstrate.dylib",
      "/bin/bash", "/bin/sh", "/usr/sbin/sshd", "/usr/bin/ssh",
      "/etc/apt", "/private/var/lib/apt/", "/var/jb",
    ]
    for p in paths where FileManager.default.fileExists(atPath: p) { return true }

    // 2. A sandboxed app cannot write outside its container; a jailbreak lifts that.
    let probe = "/private/.bitty_jb_probe_\(UUID().uuidString)"
    if (try? "x".write(toFile: probe, atomically: true, encoding: .utf8)) != nil {
      try? FileManager.default.removeItem(atPath: probe)
      return true
    }

    // 3. Tweak injectors loaded into the process image list.
    for i in 0..<_dyld_image_count() {
      guard let raw = _dyld_get_image_name(i) else { continue }
      let name = String(cString: raw)
      if name.contains("MobileSubstrate") || name.contains("Substitute")
        || name.contains("libhooker") || name.contains("TweakInject") {
        return true
      }
    }
    return false
    #endif
  }

  /** True if a debugger/tracer is attached (P_TRACED) — instrumentation that can read process memory. */
  private static func debugged() -> Bool {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    if sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) != 0 { return false }
    return (info.kp_proc.p_flag & P_TRACED) != 0
  }
}
