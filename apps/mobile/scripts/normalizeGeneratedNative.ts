import { createHash } from "node:crypto";
import type { GeneratedNativeSurface } from "./generatedNativeChecks.ts";

/**
 * Reduces the generated native projects to the values that actually constitute
 * policy, so two clean regenerations can be compared meaningfully.
 *
 * Generated projects are full of legitimate churn — Xcode object UUIDs, file
 * ordering, absolute paths, timestamps. Comparing them byte-for-byte would fail
 * constantly and teach everyone to ignore the check. Comparing *nothing* would
 * let a permission or an entitlement drift in silently. This normaliser is the
 * line between those: identifiers, permissions, domains, service types,
 * background modes and transport policy are compared; everything else is noise.
 */

export interface NormalizedNativeSurface {
  ios: {
    bundleIdentifiers: string[];
    deploymentTargets: string[];
    appBoundDomains: string[];
    backgroundModes: string[];
    urlSchemes: string[];
    usageDescriptionKeys: string[];
    entitlementKeys: string[];
    associatedDomains: string[];
    allowsArbitraryLoads: unknown;
    exceptionDomains: string[];
    dataProtection: unknown;
    sharingKeys: string[];
  };
  android: {
    permissions: string[];
    removedPermissions: string[];
    applicationFlags: Record<string, string>;
    metaData: Record<string, string>;
    locationServiceForegroundType: string | null;
    cleartextPermittedDomains: string[];
    baseCleartextPermitted: boolean;
    sdkVersions: Record<string, string>;
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function matchAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1].trim().replace(/^"|"$/g, ""));
}

function gradleProperties(source: string): Record<string, string> {
  const wanted = ["android.minSdkVersion", "android.compileSdkVersion", "android.targetSdkVersion"];
  const result: Record<string, string> = {};
  for (const key of wanted) {
    const match = source.match(new RegExp(`^${key.replace(/\./g, "\\.")}=(.*)$`, "m"));
    if (match) result[key] = match[1].trim();
  }
  return result;
}

export function normalizeGeneratedNativeSurface(
  generated: GeneratedNativeSurface,
): NormalizedNativeSurface {
  const plist = generated.infoPlist;
  const transport = (plist.NSAppTransportSecurity ?? {}) as Record<string, unknown>;
  const urlTypes = (plist.CFBundleURLTypes ?? []) as Array<{ CFBundleURLSchemes?: string[] }>;

  const manifest = generated.androidManifest.manifest;
  const permissionNodes = manifest["uses-permission"] ?? [];
  const application = manifest.application?.[0];
  const metaDataNodes = (application?.["meta-data"] ?? []) as Array<{ $: Record<string, string> }>;

  return {
    ios: {
      bundleIdentifiers: sortedUnique(
        matchAll(generated.pbxproj, /PRODUCT_BUNDLE_IDENTIFIER = ("?[^";\n]+"?);/g),
      ),
      deploymentTargets: sortedUnique(
        matchAll(generated.pbxproj, /IPHONEOS_DEPLOYMENT_TARGET = ([^;\n]+);/g),
      ),
      appBoundDomains: sortedUnique((plist.WKAppBoundDomains as string[]) ?? []),
      // Background modes are sorted: their order carries no meaning, but their
      // membership is the whole point.
      backgroundModes: sortedUnique((plist.UIBackgroundModes as string[]) ?? []),
      urlSchemes: sortedUnique(urlTypes.flatMap((entry) => entry.CFBundleURLSchemes ?? [])),
      usageDescriptionKeys: sortedUnique(
        Object.keys(plist).filter((key) => key.endsWith("UsageDescription")),
      ),
      entitlementKeys: sortedUnique(Object.keys(generated.entitlements)),
      associatedDomains: sortedUnique(
        (generated.entitlements["com.apple.developer.associated-domains"] as string[]) ?? [],
      ),
      allowsArbitraryLoads: transport.NSAllowsArbitraryLoads ?? null,
      exceptionDomains: sortedUnique(
        Object.keys((transport.NSExceptionDomains ?? {}) as Record<string, unknown>),
      ),
      dataProtection: plist.NSFileProtectionKey ?? null,
      // Present only if something regressed; tracked so it would change the hash.
      sharingKeys: sortedUnique(
        Object.keys(plist).filter(
          (key) => key === "UIFileSharingEnabled" || key === "LSSupportsOpeningDocumentsInPlace",
        ),
      ),
    },
    android: {
      permissions: sortedUnique(
        permissionNodes
          .filter((node) => node.$["tools:node"] !== "remove")
          .map((node) => node.$["android:name"]),
      ),
      removedPermissions: sortedUnique(
        permissionNodes
          .filter((node) => node.$["tools:node"] === "remove")
          .map((node) => node.$["android:name"]),
      ),
      applicationFlags: Object.fromEntries(
        Object.entries(application?.$ ?? {})
          .filter(([key]) =>
            [
              "android:usesCleartextTraffic",
              "android:allowBackup",
              "android:networkSecurityConfig",
              "android:debuggable",
              "android:dataExtractionRules",
              "android:fullBackupContent",
            ].includes(key),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      metaData: Object.fromEntries(
        metaDataNodes
          .map((node) => [node.$["android:name"], node.$["android:value"] ?? ""] as const)
          .filter(([name]) => name.startsWith("expo.modules.updates"))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      locationServiceForegroundType: generated.locationServiceForegroundType ?? null,
      cleartextPermittedDomains: sortedUnique(
        [...generated.networkSecurityConfig.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map(
          (match) => match[1].trim(),
        ),
      ),
      baseCleartextPermitted: /<base-config cleartextTrafficPermitted="true"/.test(
        generated.networkSecurityConfig,
      ),
      sdkVersions: gradleProperties(generated.gradleProperties),
    },
  };
}

/** Stable hash of the normalized surface, used to compare two generations. */
export function hashNormalizedSurface(surface: NormalizedNativeSurface): string {
  return createHash("sha256").update(JSON.stringify(surface)).digest("hex");
}
