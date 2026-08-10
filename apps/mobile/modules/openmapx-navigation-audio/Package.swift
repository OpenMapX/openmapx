// swift-tools-version:5.9
import PackageDescription

/// Host-side test package for the module's decision logic.
///
/// It compiles only `NavigationAudioPolicy.swift`, which imports nothing beyond
/// Foundation. The module class that touches AVFoundation and ExpoModulesCore
/// is built by CocoaPods inside the generated Xcode project and is deliberately
/// out of scope here — that project is disposable build output and must not own
/// committed test targets.
///
/// Run with: `swift test --package-path apps/mobile/modules/openmapx-navigation-audio`
let package = Package(
  name: "NavigationAudioPolicy",
  platforms: [.macOS(.v13)],
  targets: [
    .target(
      name: "NavigationAudioPolicy",
      path: "ios",
      exclude: ["OpenMapXNavigationAudioModule.swift", "OpenMapXNavigationAudio.podspec", "Tests"],
      sources: ["NavigationAudioPolicy.swift"]
    ),
    .testTarget(
      name: "NavigationAudioPolicyTests",
      dependencies: ["NavigationAudioPolicy"],
      path: "ios/Tests"
    ),
  ]
)
