// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "NavigationSurfacePolicy", products: [.library(name: "NavigationSurfacePolicy", targets: ["NavigationSurfacePolicy"])], targets: [
  .target(name: "NavigationSurfacePolicy", path: "ios", exclude: ["Widget", "Tests", "OpenMapXNavigationSurfacesModule.swift", "NavigationActivityAttributes.swift", "OpenMapXNavigationSurfaces.podspec", "PrivacyInfo.xcprivacy"], sources: ["SurfacePayload.swift"]),
  .testTarget(name: "NavigationSurfacePolicyTests", dependencies: ["NavigationSurfacePolicy"], path: "ios/Tests")
])
