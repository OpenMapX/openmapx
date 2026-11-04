import ExpoModulesCore
import Foundation
import UIKit

public final class OpenMapXIntakeModule: Module {
  private var observer: NSObjectProtocol?
  private func result(_ work: () throws -> [String: Any]) -> [String: Any] {
    var task = UIBackgroundTaskIdentifier.invalid
    let start = { task = UIApplication.shared.beginBackgroundTask(withName: "OpenMapX inbox") }
    if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
    defer { DispatchQueue.main.async { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } } }
    do { return try work() } catch { return ["errorCode": (error as? IntakeFailure)?.rawValue ?? "unavailable"] }
  }
  public func definition() -> ModuleDefinition {
    Name("OpenMapXIntake")
    Events("onInboxChanged")
    OnCreate {
      self.observer = NotificationCenter.default.addObserver(forName: IntakeContainer.changed, object: nil, queue: nil) { [weak self] _ in self?.sendEvent("onInboxChanged", [:]) }
    }
    OnDestroy { if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }; self.observer = nil }
    OnAppEntersForeground { self.sendEvent("onInboxChanged", [:]) }
    AsyncFunction("isAvailableAsync") { (try? IntakeContainer.store(writer: "host")) != nil }
    AsyncFunction("listAsync") { self.result { ["items": try IntakeContainer.store(writer: "host").list().map(\.dictionary)] } }
    AsyncFunction("readChunkAsync") { (id: String, offset: Int) in self.result { try IntakeContainer.store(writer: "host").read(id, offset: offset).dictionary } }
    AsyncFunction("completeAsync") { (id: String) in self.result { try IntakeContainer.store(writer: "host").complete(id); return ["ok": true] } }
  }
}
