import ExpoModulesCore
import Foundation
import UIKit

private final class HostDocumentCancellation {
  private let lock = NSLock()
  private var cancelled = false, action: (() -> Void)?
  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
  func install(_ action: (() -> Void)?) {
    lock.lock(); let cancel = cancelled; if !cancel { self.action = action }; lock.unlock()
    if cancel { action?() }
  }
  func cancel() {
    lock.lock(); guard !cancelled else { lock.unlock(); return }
    cancelled = true; let action = self.action; self.action = nil; lock.unlock(); action?()
  }
}
private final class HostDocumentResult {
  private let lock = NSLock()
  private var value: Result<IntakeEntry, Error>?
  func set(_ value: Result<IntakeEntry, Error>) { lock.lock(); self.value = value; lock.unlock() }
  func get() -> Result<IntakeEntry, Error> { lock.lock(); defer { lock.unlock() }; return value ?? .failure(IntakeFailure.unreadable) }
}

public final class IntakeAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private static let queue = DispatchQueue(label: "org.openmapx.intake.documents", qos: .userInitiated)
  public func application(_ application: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    guard url.isFileURL else { return false }
    let openInPlace = options[.openInPlace] as? Bool ?? false
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return false }
    let inbox = documents.appendingPathComponent("Inbox", isDirectory: true)
    let deadline = ProcessInfo.processInfo.systemUptime + 10
    let cancellation = HostDocumentCancellation()
    let lifetime = IntakeBackgroundLease(invalid: UIBackgroundTaskIdentifier.invalid,
      begin: { expiration in application.beginBackgroundTask(withName: "OpenMapX document intake", expirationHandler: expiration) },
      end: { id in DispatchQueue.main.async { application.endBackgroundTask(id) } })
    lifetime.begin { cancellation.cancel() }
    Self.queue.async {
      defer { cancellation.install(nil); lifetime.end() }
      guard !cancellation.isCancelled else { return }
      do {
        let store = try IntakeContainer.store(writer: "host")
        let register: (NSFileCoordinator) -> Void = { coordinator in cancellation.install { coordinator.cancel() } }
        let result: Result<IntakeEntry, Error>
        if openInPlace {
          let job = IntakeExternalDocument(url: url, store: store,
            privateRoots: [URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), try IntakeContainer.root()],
            timeout: max(0, deadline - ProcessInfo.processInfo.systemUptime))
          let completed = DispatchSemaphore(value: 0), outcome = HostDocumentResult()
          cancellation.install { job.cancel() }
          job.start { result in outcome.set(result); completed.signal() }
          // Only this dedicated worker waits. The coordinator uses its own
          // serial operation queue, and the overall deadline cancels its wait.
          if completed.wait(timeout: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime)) == .timedOut { job.cancel() }
          result = outcome.get()
        } else {
          result = Result { try store.captureDocument(url, osInbox: inbox, openInPlace: false,
            deadline: deadline, cancelled: { cancellation.isCancelled }, onCoordinator: register) }
        }
        cancellation.install(nil)
        guard !cancellation.isCancelled else { return }
        if case .failure(let error) = result {
          try? store.recordError((error as? IntakeFailure)?.rawValue ?? "unreadable",
            cancelled: { cancellation.isCancelled }, onCoordinator: register)
        }
        if !cancellation.isCancelled { NotificationCenter.default.post(name: IntakeContainer.changed, object: nil) }
      } catch { /* No group authority: never fall back to the app's private files. */ }
    }
    return true
  }
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // Only abandoned OS copies are reaped; never delete a provider's original.
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
