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
    navigationExtension: Record<string, unknown> | null;
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
    openingDocumentsInPlace: boolean | null;
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
  return [...source.matchAll(pattern)].flatMap(
    ([, value]) => value?.trim().replace(/^"|"$/g, "") ?? [],
  );
}

function gradleProperties(source: string): Record<string, string> {
  const wanted = ["android.minSdkVersion", "android.compileSdkVersion", "android.targetSdkVersion"];
  const result: Record<string, string> = {};
  const lines = source.split(/\r?\n/);
  for (const key of wanted) {
    const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
    if (line !== undefined) result[key] = line.slice(key.length + 1).trim();
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
      navigationExtension: generated.navigationExtension ?? null,
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
      openingDocumentsInPlace:
        typeof plist.LSSupportsOpeningDocumentsInPlace === "boolean"
          ? plist.LSSupportsOpeningDocumentsInPlace
          : null,
      // These keys expose app documents, unlike opening a user-selected file.
      sharingKeys: sortedUnique(
        Object.keys(plist).filter(
          (key) => key === "UIFileSharingEnabled" || key === "UISupportsDocumentBrowser",
        ),
      ),
    },
    android: {
      permissions: sortedUnique(
        permissionNodes
          .filter((node) => node.$["tools:node"] !== "remove")
          .flatMap((node) => node.$["android:name"] ?? []),
      ),
      removedPermissions: sortedUnique(
        permissionNodes
          .filter((node) => node.$["tools:node"] === "remove")
          .flatMap((node) => node.$["android:name"] ?? []),
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
          .flatMap((node) => {
            const name = node.$["android:name"];
            return name?.startsWith("expo.modules.updates")
              ? [[name, node.$["android:value"] ?? ""] as const]
              : [];
          })
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      locationServiceForegroundType: generated.locationServiceForegroundType ?? null,
      cleartextPermittedDomains: sortedUnique(
        [...generated.networkSecurityConfig.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].flatMap(
          ([, domain]) => domain?.trim() ?? [],
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
