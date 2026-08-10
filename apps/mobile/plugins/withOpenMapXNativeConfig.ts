import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExpoConfig } from "expo/config";
import type { ConfigPlugin } from "expo/config-plugins";
import {
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
} from "expo/config-plugins";
// Explicit `.ts` specifiers: Expo transpiles only the plugin entry file, so
// Node resolves these imports and needs the real extension.
import type { MobileBuildConfig } from "../config/mobileConfig.ts";
import { readMobileConfig } from "../config/mobileConfig.ts";
import {
  type AndroidManifestLike,
  applyAndroidApplicationSecurity,
  applyAndroidPermissions,
  applyAppBoundDomains,
  applyAppTransportSecurity,
  applyAssociatedDomains,
  applyBackgroundModes,
  applyLocationServiceType,
  applyUrlSchemes,
  buildNetworkSecurityConfigXml,
  FORBIDDEN_IOS_ENTITLEMENTS,
  type InfoPlistLike,
  type NativeConfigInput,
  removeUnusedUsageDescriptions,
  stripIosOnlyStringResources,
  UNUSED_IOS_USAGE_DESCRIPTION_KEYS,
} from "./nativeConfigTransforms.ts";

/**
 * Derives the plugin's inputs from the same validated build configuration the
 * rest of the app uses, so the generated native policy can never disagree with
 * the compiled origins.
 */
export function nativeConfigInputFrom(mobile: Readonly<MobileBuildConfig>): NativeConfigInput {
  const web = new URL(mobile.webOrigin);
  const api = new URL(mobile.apiOrigin);
  return {
    release: mobile.release,
    webHost: web.hostname,
    apiHost: api.hostname,
    usesCleartextOrigin: web.protocol === "http:" || api.protocol === "http:",
    hasAppleTeamId: Boolean(mobile.appleTeamId),
    scheme: mobile.scheme,
  };
}

/**
 * Applies the OpenMapX-specific native settings that Expo's own plugins do not
 * express: App-Bound Domains, the exact background-mode set, associated
 * domains, transport policy, and the Android location foreground-service type.
 *
 * Every mod is a pure transform over the document it receives, so a second
 * prebuild — or a second application of this plugin — produces identical output.
 */
export const withOpenMapXNativeConfig: ConfigPlugin = (config) => {
  const input = nativeConfigInputFrom(readMobileConfig(process.env));

  let next: ExpoConfig = withInfoPlist(config, (plistConfig) => {
    const plist = plistConfig.modResults as InfoPlistLike;
    const updated = applyUrlSchemes(
      applyAppTransportSecurity(
        removeUnusedUsageDescriptions(applyBackgroundModes(applyAppBoundDomains(plist, input))),
        input,
      ),
      input.scheme,
    );
    for (const key of UNUSED_IOS_USAGE_DESCRIPTION_KEYS) delete plistConfig.modResults[key];
    Object.assign(plistConfig.modResults, updated);
    return plistConfig;
  });

  next = withEntitlementsPlist(next, (entitlementsConfig) => {
    const updated = applyAssociatedDomains(entitlementsConfig.modResults, input);
    // Assigning rather than replacing keeps Expo's own reference intact, so the
    // keys the transform dropped need explicit deletion.
    for (const key of FORBIDDEN_IOS_ENTITLEMENTS) delete entitlementsConfig.modResults[key];
    if (!("com.apple.developer.associated-domains" in updated)) {
      delete entitlementsConfig.modResults["com.apple.developer.associated-domains"];
    }
    Object.assign(entitlementsConfig.modResults, updated);
    return entitlementsConfig;
  });

  next = withAndroidManifest(next, (manifestConfig) => {
    const manifest = manifestConfig.modResults as unknown as AndroidManifestLike;
    const updated = applyAndroidApplicationSecurity(
      applyLocationServiceType(applyAndroidPermissions(manifest)),
      input,
    );
    manifestConfig.modResults = updated as unknown as typeof manifestConfig.modResults;
    return manifestConfig;
  });

  next = withDangerousMod(next, [
    "android",
    (danger) => {
      const target = join(
        danger.modRequest.platformProjectRoot,
        "app/src/main/res/xml/network_security_config.xml",
      );
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buildNetworkSecurityConfigXml(input), "utf8");

      // Expo's `locales` field is platform-agnostic and writes the iOS usage
      // descriptions into Android string resources too, which fails
      // `lintVitalRelease` with `ExtraTranslation`. Remove them here, after that
      // writer has run.
      const resourcesRoot = join(danger.modRequest.platformProjectRoot, "app/src/main/res");
      if (existsSync(resourcesRoot)) {
        for (const entry of readdirSync(resourcesRoot)) {
          if (!entry.startsWith("values-")) continue;
          const strings = join(resourcesRoot, entry, "strings.xml");
          if (!existsSync(strings)) continue;
          const stripped = stripIosOnlyStringResources(readFileSync(strings, "utf8"));
          if (stripped !== null) {
            writeFileSync(strings, stripped, "utf8");
            continue;
          }
          rmSync(strings, { force: true });
          // An empty locale resource directory serves no purpose either.
          const localeDirectory = join(resourcesRoot, entry);
          if (readdirSync(localeDirectory).length === 0) {
            rmSync(localeDirectory, { recursive: true, force: true });
          }
        }
      }
      return danger;
    },
  ]);

  return next;
};

export default withOpenMapXNativeConfig;
