import ExpoModulesCore
import Foundation
import UIKit

public final class IntakeAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private static let queue = DispatchQueue(label: "org.openmapx.intake.documents", qos: .userInitiated)
  public func application(_ application: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    guard url.isFileURL else { return false }
    let openInPlace = options[.openInPlace] as? Bool ?? false
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return false }
    let inbox = documents.appendingPathComponent("Inbox", isDirectory: true)
    // Background assertion protects short file-coordination commits against suspension.
    let task = application.beginBackgroundTask(withName: "OpenMapX document intake")
    Self.queue.async {
      do {
        let store = try IntakeContainer.store(writer: "host")
        do { _ = try store.captureDocument(url, osInbox: inbox, openInPlace: openInPlace) }
        catch { try? store.recordError((error as? IntakeFailure)?.rawValue ?? "unreadable") }
        NotificationCenter.default.post(name: IntakeContainer.changed, object: nil)
      } catch { /* No group authority: never fall back to the app's private files. */ }
      DispatchQueue.main.async { application.endBackgroundTask(task) }
    }
    return true
  }
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // Expo's scene delegate forwards cold URL contexts through application(open:options:).
    // Reap abandoned OS copies only after the inbox TTL; never race a fresh cold Open In.
    Self.queue.async {
      guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
      let inbox = documents.appendingPathComponent("Inbox")
      for file in (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey, .isSymbolicLinkKey])) ?? [] {
        guard let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey, .isSymbolicLinkKey]), values.isRegularFile == true, values.isSymbolicLink != true,
          let date = values.contentModificationDate, Date().timeIntervalSince(date) > 86400 else { continue }
        try? FileManager.default.removeItem(at: file)
      }
    }
    return true
  }
}
