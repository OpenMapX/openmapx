import ActivityKit
import ExpoModulesCore
import UIKit

private actor SurfaceQueue {
  static let shared = SurfaceQueue()
  private var tail = Task { false }
  func run(_ operation: @escaping @Sendable () async -> Bool) async -> Bool {
    let previous = tail
    let next = Task { _ = await previous.value; return await operation() }
    tail = next
    return await next.value
  }
}
@MainActor private final class SurfaceActivities {
  static let shared = SurfaceActivities()
  private let defaults = UserDefaults.standard
  private let prefix = "OpenMapX.NavigationSurface."
  private var owner: String? { defaults.string(forKey: prefix + "owner") }
  private var revision: Int64 { Int64(defaults.integer(forKey: prefix + "revision")) }
  func update(_ raw: String, scheme: String, foreground: Bool) async -> Bool {
    guard let model = try? SurfacePayload.decode(raw), scheme.range(of: "^[a-z][a-z0-9+.-]{0,100}$", options: .regularExpression) != nil,
      model.expiresAtMs > Date().timeIntervalSince1970 * 1000,
      SurfacePolicy.accepts(owner: owner, revision: revision, incoming: model)
    else { return false }
    let attrs = NavigationActivityAttributes(sessionId: model.sessionId, scheme: scheme, locale: model.locale)
    guard let staticBytes = try? JSONEncoder().encode(attrs), let dynamicBytes = try? JSONEncoder().encode(model), staticBytes.count + dynamicBytes.count < 4000 else { return false }
    if defaults.string(forKey: prefix + "dismissed") == model.sessionId { return true }
    let all = Activity<NavigationActivityAttributes>.activities
    for other in all where other.attributes.sessionId != model.sessionId {
      await other.end(nil, dismissalPolicy: .immediate)
    }
    let matching = all.filter { $0.attributes.sessionId == model.sessionId && $0.activityState != .ended && $0.activityState != .dismissed }
    for duplicate in matching.dropFirst() { await duplicate.end(nil, dismissalPolicy: .immediate) }
    let content = ActivityContent(state: model, staleDate: Date(timeIntervalSince1970: model.staleAtMs / 1000))
    if model.status == "arrived" {
      // Arrival is reversible in transit; an undo may create another activity.
      defaults.removeObject(forKey: prefix + "owner")
      defaults.removeObject(forKey: prefix + "activityId")
      if let activity = matching.first { await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60))) }
      return true
    }
    if let activity = matching.first {
      await activity.update(content)
      defaults.set(model.sessionId, forKey: prefix + "owner")
      defaults.set(model.revision, forKey: prefix + "revision")
      return true
    }
    let now = Date().timeIntervalSince1970
    // No running activity after a previously successful start usually means a
    // dismissal while we were suspended. Only the system's 8h lifespan allows
    // a foreground recreation without another explicit navigation start.
    if owner == model.sessionId && now - defaults.double(forKey: prefix + "started") < 8 * 3600 {
      defaults.set(model.sessionId, forKey: prefix + "dismissed")
      return true
    }
    guard foreground, UIApplication.shared.applicationState == .active, ActivityAuthorizationInfo().areActivitiesEnabled else { return false }
    do {
      let activity = try Activity.request(attributes: attrs, content: content, pushType: nil)
      defaults.set(model.sessionId, forKey: prefix + "owner")
      defaults.set(model.revision, forKey: prefix + "revision")
      defaults.set(now, forKey: prefix + "started")
      defaults.set(activity.id, forKey: prefix + "activityId")
      Task { @MainActor in
        for await state in activity.activityStateUpdates {
          if state == .dismissed && self.owner == model.sessionId && self.defaults.string(forKey: self.prefix + "activityId") == activity.id {
            self.defaults.set(model.sessionId, forKey: self.prefix + "dismissed")
          }
        }
      }
      return true
    } catch { return false }
  }
  func clear(_ expected: String?) async -> Bool {
    guard SurfacePolicy.canClear(owner: owner, expected: expected) else { return true }
    defaults.removeObject(forKey: prefix + "owner")
    defaults.removeObject(forKey: prefix + "revision")
    defaults.removeObject(forKey: prefix + "activityId")
    for activity in Activity<NavigationActivityAttributes>.activities where expected == nil || activity.attributes.sessionId == expected {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    return true
  }
}
public final class OpenMapXNavigationSurfacesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenMapXNavigationSurfaces")
    AsyncFunction("updateAsync") { (raw: String, scheme: String, foreground: Bool) async -> Bool in
      await SurfaceQueue.shared.run { await SurfaceActivities.shared.update(raw, scheme: scheme, foreground: foreground) }
    }
    AsyncFunction("clearAsync") { (expected: String?) async in
      _ = await SurfaceQueue.shared.run { await SurfaceActivities.shared.clear(expected) }
    }
  }
}
