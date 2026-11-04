import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plistModule from "@expo/plist";
import {
  type ConfigPlugin,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} from "expo/config-plugins";
import {
  intakeDocumentTypes,
  intakeImportedTypes,
  intakeShareInfo,
  shareBuildSettings,
  TARGET,
} from "../config/nativeIntakeConfig.ts";

export {
  intakeAndroidFilters,
  intakeDocumentTypes,
  intakeImportedTypes,
  intakeShareInfo,
  shareBuildSettings,
} from "../config/nativeIntakeConfig.ts";

const plist = ((plistModule as { default?: unknown }).default ?? plistModule) as {
  build(value: unknown): string;
};
const withNativeIntake: ConfigPlugin = (config) => {
  const appId = config.ios?.bundleIdentifier;
  if (!appId) throw new Error("native intake requires a bundle identifier");
  const group = `group.${appId}.intake`;
  let next = withInfoPlist(config, (mod) => {
    Object.assign(mod.modResults, {
      CFBundleDocumentTypes: intakeDocumentTypes(),
      UTImportedTypeDeclarations: intakeImportedTypes(),
      LSSupportsOpeningDocumentsInPlace: false,
      OpenMapXIntakeAppGroup: group,
    });
    return mod;
  });
  next = withEntitlementsPlist(next, (mod) => {
    mod.modResults["com.apple.security.application-groups"] = [group];
    return mod;
  });
  next = withXcodeProject(next, (mod) => {
    const project = mod.modResults,
      folder = join(mod.modRequest.platformProjectRoot, TARGET);
    mkdirSync(folder, { recursive: true });
    const committed = join(mod.modRequest.projectRoot, "modules/openmapx-intake/ios");
    const sources = [
      "IntakePolicy.swift",
      "IntakeInbox.swift",
      "IntakeContainer.swift",
      "ShareViewController.swift",
    ];
    for (const source of sources)
      copyFileSync(
        join(committed, source === "ShareViewController.swift" ? "Share" : "", source),
        join(folder, source),
      );
    copyFileSync(
      join(committed, "Share/PrivacyInfo.xcprivacy"),
      join(folder, "PrivacyInfo.xcprivacy"),
    );
    writeFileSync(join(folder, "Info.plist"), plist.build(intakeShareInfo(appId)));
    writeFileSync(
      join(folder, "ShareExtension.entitlements"),
      plist.build({ "com.apple.security.application-groups": [group] }),
    );
    const targets = project.pbxNativeTargetSection() as Record<
      string,
      { name?: string; buildConfigurationList: string }
    >;
    const existing = Object.entries(targets).find(
      ([, t]) => t && typeof t === "object" && t.name?.replaceAll('"', "") === TARGET,
    );
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(TARGET, "app_extension", TARGET, `${appId}.ShareExtension`);
    if (!existing) {
      project.addBuildPhase(
        sources.map((s) => `${TARGET}/${s}`),
        "PBXSourcesBuildPhase",
        "Sources",
        target.uuid,
      );
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
      project.addBuildPhase(
        [`${TARGET}/PrivacyInfo.xcprivacy`],
        "PBXResourcesBuildPhase",
        "Resources",
        target.uuid,
      );
    }
    const configs = project.pbxXCBuildConfigurationSection() as Record<
      string,
      { name: string; buildSettings: Record<string, unknown> }
    >;
    const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
    for (const entry of list.buildConfigurations) {
      const extension = configs[entry.value];
      const host = Object.values(configs).find(
        (c) =>
          c &&
          typeof c === "object" &&
          c.name === extension.name &&
          String(c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER).replaceAll('"', "") === appId,
      );
      extension.buildSettings = shareBuildSettings(
        {
          ...host?.buildSettings,
          MARKETING_VERSION: config.version ?? host?.buildSettings?.MARKETING_VERSION,
          CURRENT_PROJECT_VERSION:
            config.ios?.buildNumber ?? host?.buildSettings?.CURRENT_PROJECT_VERSION ?? "1",
        },
        appId,
      );
    }
    return mod;
  });
  return next;
};
export default withNativeIntake;
