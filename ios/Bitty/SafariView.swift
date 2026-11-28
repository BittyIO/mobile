import Foundation
import React
import SafariServices
import UIKit

/**
 * Opens a page in an in-app Safari sheet (SFSafariViewController), for sites whose Cloudflare
 * "verifying you are human" check never passes in a WebView (Tronscan). It is Safari's own engine
 * and network stack, so the check passes, and the user stays in the app (src/core/open-link.ts).
 */
@objc(SafariView)
class SafariView: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { return true }

  @objc(open:resolver:rejecter:)
  func open(_ url: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
        reject("bad_url", "Not a web address", nil)
        return
      }
      guard let top = SafariView.topController() else {
        reject("no_view", "No view to present from", nil)
        return
      }
      let vc = SFSafariViewController(url: u)
      vc.dismissButtonStyle = .close
      vc.modalPresentationStyle = .pageSheet
      top.present(vc, animated: true)
      resolve(true)
    }
  }

  private static func topController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
      ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
    while let p = top?.presentedViewController { top = p }
    return top
  }
}
