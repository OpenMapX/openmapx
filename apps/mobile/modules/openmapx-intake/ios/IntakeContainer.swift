import Foundation

/// This group contains only the intake inbox, never credentials or navigation storage.
enum IntakeContainer {
  static func root() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenMapXIntakeAppGroup") as? String,
      group.hasPrefix("group."), group.hasSuffix(".intake"),
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw IntakeFailure.unavailable }
    return root
  }
  static func store(writer: String) throws -> IntakeInbox {
    try IntakeInbox(root: root().appendingPathComponent("Inbox", isDirectory: true), writer: writer)
  }
  static let changed = Notification.Name("OpenMapXIntakeChanged")
}
