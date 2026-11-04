import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigPlugin, withInfoPlist, withXcodeProject } from "expo/config-plugins";

const TARGET = "OpenMapXNavigationSurface";
const SOURCES = [
  "SurfacePayload.swift",
  "NavigationActivityAttributes.swift",
  "NavigationWidget.swift",
];
export function widgetBuildSettings(
  host: Record<string, unknown>,
  appId: string,
): Record<string, unknown> {
  return {
    PRODUCT_BUNDLE_IDENTIFIER: `"${appId}.NavigationSurface"`,
    PRODUCT_NAME: `"${TARGET}"`,
    INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
    IPHONEOS_DEPLOYMENT_TARGET: "16.4",
    CURRENT_PROJECT_VERSION: host.CURRENT_PROJECT_VERSION ?? "1",
    MARKETING_VERSION: host.MARKETING_VERSION ?? "1.0.0",
    ...(host.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: host.DEVELOPMENT_TEAM } : {}),
    CODE_SIGN_STYLE: "Automatic",
    SWIFT_VERSION: "5.0",
    SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
    APPLICATION_EXTENSION_API_ONLY: "YES",
    SKIP_INSTALL: "YES",
    TARGETED_DEVICE_FAMILY: '"1"',
    LD_RUNPATH_SEARCH_PATHS:
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    GENERATE_INFOPLIST_FILE: "NO",
  };
}
export function widgetInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>OpenMapX Navigation</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSSupportsLiveActivities</key><true/>
<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
</dict></plist>\n`;
}
/** All extension sources remain committed under modules/, never edited in ios/. */
const withNavigationSurfaces: ConfigPlugin = (config) => {
  let next = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    return mod;
  });
  next = withXcodeProject(next, (mod) => {
    const project = mod.modResults;
    const iosRoot = mod.modRequest.platformProjectRoot;
    const folder = join(iosRoot, TARGET);
    mkdirSync(folder, { recursive: true });
    const committed = join(mod.modRequest.projectRoot, "modules/openmapx-navigation-surfaces/ios");
    for (const file of SOURCES)
      copyFileSync(
        join(committed, file === "NavigationWidget.swift" ? "Widget" : "", file),
        join(folder, file),
      );
    writeFileSync(join(folder, "Info.plist"), widgetInfoPlist());
    const targets = project.pbxNativeTargetSection() as Record<
      string,
      { name?: string; buildConfigurationList: string }
    >;
    const existing = Object.entries(targets).find(
      ([, t]) => t && typeof t === "object" && t.name?.replaceAll('"', "") === TARGET,
    );
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(
          TARGET,
          "app_extension",
          TARGET,
          `${config.ios?.bundleIdentifier}.NavigationSurface`,
        );
    const uuid = target.uuid;
    if (!existing) {
      project.addBuildPhase(
        SOURCES.map((s) => `${TARGET}/${s}`),
        "PBXSourcesBuildPhase",
        "Sources",
        uuid,
      );
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", uuid);
      project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", uuid);
    }
    const configs = project.pbxXCBuildConfigurationSection() as Record<
      string,
      { name: string; buildSettings: Record<string, unknown> }
    >;
    const hostId = config.ios?.bundleIdentifier;
    if (!hostId) throw new Error("navigation surface requires an iOS bundle identifier");
    // Match configuration names so Debug/Release inherit the same host versions/team.
    const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
    for (const entry of list.buildConfigurations) {
      const extensionConfig = configs[entry.value];
      const host = Object.values(configs).find(
        (c) =>
          c &&
          typeof c === "object" &&
          c.name === extensionConfig.name &&
          String(c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER).replaceAll('"', "") === hostId,
      );
      extensionConfig.buildSettings = widgetBuildSettings(
        {
          ...host?.buildSettings,
          MARKETING_VERSION: config.version ?? host?.buildSettings?.MARKETING_VERSION,
          CURRENT_PROJECT_VERSION:
            config.ios?.buildNumber ?? host?.buildSettings?.CURRENT_PROJECT_VERSION ?? "1",
        },
        hostId,
      );
    }
    return mod;
  });
  return next;
};
export default withNavigationSurfaces;
