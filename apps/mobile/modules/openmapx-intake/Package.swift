// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "IntakeInbox", platforms: [.macOS(.v13)], targets: [
  .target(name: "IntakeInbox", path: "ios", exclude: ["Tests", "Share", "IntakeContainer.swift", "IntakeAppDelegateSubscriber.swift", "OpenMapXIntakeModule.swift", "OpenMapXIntake.podspec", "PrivacyInfo.xcprivacy"], sources: ["IntakePolicy.swift", "IntakeInbox.swift", "ShareSelection.swift", "IntakeExternalDocument.swift"]),
  .testTarget(name: "IntakeInboxTests", dependencies: ["IntakeInbox"], path: "ios/Tests")
])
