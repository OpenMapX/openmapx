/**
 * Pure transforms behind `withOpenMapXNativeConfig`.
 *
 * Keeping the logic separate from the Expo mod wrappers makes each rule
 * directly testable and lets the idempotency contract ("applying twice produces
 * the same document") be asserted without running a real prebuild.
 */

export interface NativeConfigInput {
  release: boolean;
  /** Host of the compiled web origin, e.g. `openmapx.com`. */
  webHost: string;
  /** Host of the compiled API origin; usually identical to `webHost`. */
  apiHost: string;
  /** True when either compiled origin uses plain HTTP (development only). */
  usesCleartextOrigin: boolean;
  hasAppleTeamId: boolean;
  /** The single custom URL scheme this build registers. */
  scheme: string;
}

export const LOCATION_FOREGROUND_SERVICE_TYPE = "location";

/** The Android services Expo generates for background location delivery. */
export const EXPO_LOCATION_SERVICE_NAMES = ["expo.modules.location.services.LocationTaskService"];

export const REQUIRED_ANDROID_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_LOCATION",
  "android.permission.POST_NOTIFICATIONS",
] as const;

/* ---------------------------------------------------------------- iOS ---- */

export interface InfoPlistLike {
  WKAppBoundDomains?: string[];
  UIBackgroundModes?: string[];
  NSAppTransportSecurity?: Record<string, unknown>;
  CFBundleURLTypes?: Array<{ CFBundleURLSchemes?: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Usage descriptions bundled Expo modules add speculatively but this app never
 * triggers. `NSLocationAlwaysUsageDescription` is the pre-iOS-11 spelling, and
 * OpenMapX requests no motion authorisation — declaring either would advertise
 * a protected resource the binary does not use.
 */
export const UNUSED_IOS_USAGE_DESCRIPTION_KEYS = [
  "NSLocationAlwaysUsageDescription",
  "NSMotionUsageDescription",
] as const;

/** Push entitlements: this release has no remote notification capability at all. */
export const FORBIDDEN_IOS_ENTITLEMENTS = ["aps-environment"] as const;

export function removeUnusedUsageDescriptions(plist: InfoPlistLike): InfoPlistLike {
  const next = { ...plist };
  for (const key of UNUSED_IOS_USAGE_DESCRIPTION_KEYS) delete next[key];
  return next;
}

/**
 * Expo registers the bundle identifier as a second custom URL scheme. Only the
 * compiled scheme is part of the reviewed surface, so the extra entry is
 * dropped and an empty `CFBundleURLTypes` is removed rather than left behind.
 */
export function applyUrlSchemes(plist: InfoPlistLike, scheme: string): InfoPlistLike {
  const types = (plist.CFBundleURLTypes ?? [])
    .map((entry) => ({
      ...entry,
      CFBundleURLSchemes: (entry.CFBundleURLSchemes ?? []).filter((value) => value === scheme),
    }))
    .filter((entry) => (entry.CFBundleURLSchemes?.length ?? 0) > 0);
  const hasScheme = types.some((entry) => entry.CFBundleURLSchemes?.includes(scheme));
  return {
    ...plist,
    CFBundleURLTypes: hasScheme ? types : [...types, { CFBundleURLSchemes: [scheme] }],
  };
}

/**
 * WebKit App-Bound Domains. Exactly the compiled web host — no wildcard, no
 * subdomain, no second entry — so the product WebView cannot be navigated to
 * another origin even if a page tries.
 */
export function applyAppBoundDomains(
  plist: InfoPlistLike,
  input: NativeConfigInput,
): InfoPlistLike {
  return { ...plist, WKAppBoundDomains: [input.webHost] };
}

/**
 * Location is the only background mode this release declares. An unused or
 * unproven `audio` mode is an App Review liability, so it is stripped rather
 * than merged.
 */
export function applyBackgroundModes(plist: InfoPlistLike): InfoPlistLike {
  return { ...plist, UIBackgroundModes: ["location"] };
}

/**
 * App Transport Security. Release builds forbid arbitrary loads outright.
 * A development build that compiled an `http://` origin gets one narrow
 * exception for exactly that host.
 */
export function applyAppTransportSecurity(
  plist: InfoPlistLike,
  input: NativeConfigInput,
): InfoPlistLike {
  if (input.release || !input.usesCleartextOrigin) {
    return { ...plist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } };
  }
  const hosts = [...new Set([input.webHost, input.apiHost])].sort();
  return {
    ...plist,
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: false,
      NSExceptionDomains: Object.fromEntries(
        hosts.map((host) => [host, { NSExceptionAllowsInsecureHTTPLoads: true }]),
      ),
    },
  };
}

/**
 * Associated domains. `webcredentials` already existed for passkeys, so it is
 * preserved and `applinks` is added alongside it. Entries are deduplicated and
 * sorted so a second application produces an identical array.
 */
export function applyAssociatedDomains(
  entitlements: Record<string, unknown>,
  input: NativeConfigInput,
): Record<string, unknown> {
  const base = { ...entitlements };
  // Associated Domains is the only additional capability this app enables.
  // `expo-notifications` adds a push entitlement by default; there is no remote
  // notification path here, so it is removed rather than provisioned.
  for (const key of FORBIDDEN_IOS_ENTITLEMENTS) delete base[key];

  const existing = Array.isArray(base["com.apple.developer.associated-domains"])
    ? (base["com.apple.developer.associated-domains"] as string[])
    : [];
  if (!input.hasAppleTeamId) {
    // Without a real Team ID an associated-domains entitlement cannot be
    // provisioned; shipping a placeholder would fail verification silently.
    delete base["com.apple.developer.associated-domains"];
    return base;
  }
  const merged = [
    ...new Set([...existing, `applinks:${input.webHost}`, `webcredentials:${input.webHost}`]),
  ];
  return { ...base, "com.apple.developer.associated-domains": merged.sort() };
}

/* ------------------------------------------------------------ Android ---- */

interface ManifestElement {
  $: Record<string, string>;
  [key: string]: unknown;
}

export interface AndroidManifestLike {
  manifest: {
    $: Record<string, string>;
    "uses-permission"?: ManifestElement[];
    "uses-permission-sdk-23"?: ManifestElement[];
    application?: Array<ManifestElement & { service?: ManifestElement[] }>;
    [key: string]: unknown;
  };
}

/**
 * Adds the location and foreground-service permissions this app needs while
 * preserving whatever other modules already declared. Re-running never creates
 * a duplicate `<uses-permission>` node.
 */
export function applyAndroidPermissions(manifest: AndroidManifestLike): AndroidManifestLike {
  const existing = manifest.manifest["uses-permission"] ?? [];
  const present = new Set(existing.map((node) => node.$["android:name"]));
  const additions = REQUIRED_ANDROID_PERMISSIONS.filter((name) => !present.has(name)).map(
    (name) => ({
      $: { "android:name": name },
    }),
  );
  if (additions.length === 0) return manifest;
  return {
    ...manifest,
    manifest: { ...manifest.manifest, "uses-permission": [...existing, ...additions] },
  };
}

/**
 * Marks Expo's generated location service as a `location` foreground service,
 * which Android 14+ requires. Only that service is touched: a blanket rewrite
 * would silently grant the type to any future service.
 */
export function applyLocationServiceType(manifest: AndroidManifestLike): AndroidManifestLike {
  const applications = manifest.manifest.application;
  if (!applications) return manifest;
  return {
    ...manifest,
    manifest: {
      ...manifest.manifest,
      application: applications.map((application) => {
        const services = application.service;
        if (!services) return application;
        return {
          ...application,
          service: services.map((service) =>
            EXPO_LOCATION_SERVICE_NAMES.includes(service.$["android:name"])
              ? {
                  ...service,
                  $: {
                    ...service.$,
                    "android:foregroundServiceType": LOCATION_FOREGROUND_SERVICE_TYPE,
                  },
                }
              : service,
          ),
        };
      }),
    },
  };
}

/**
 * Transport and storage hardening on the `<application>` node. Release builds
 * refuse cleartext outright and opt out of Android backup so an active
 * navigation session's SQLite file is never copied off the device.
 */
export function applyAndroidApplicationSecurity(
  manifest: AndroidManifestLike,
  input: NativeConfigInput,
): AndroidManifestLike {
  const applications = manifest.manifest.application;
  if (!applications) return manifest;
  const allowCleartext = !input.release && input.usesCleartextOrigin;
  return {
    ...manifest,
    manifest: {
      ...manifest.manifest,
      application: applications.map((application) => ({
        ...application,
        $: {
          ...application.$,
          "android:usesCleartextTraffic": allowCleartext ? "true" : "false",
          "android:allowBackup": "false",
          "android:networkSecurityConfig": "@xml/network_security_config",
        },
      })),
    },
  };
}

/**
 * Keys that only mean something in an iOS `Info.plist`.
 *
 * Expo's `locales` field is platform-agnostic, so it writes these usage
 * descriptions into Android `values-b+<locale>/strings.xml` as well. Android
 * lint fails a release build over them (`ExtraTranslation`) — correctly, since a
 * translated string with no default-locale entry crashes when looked up on any
 * other locale. They are stripped rather than given a default, because a default
 * would mean shipping two meaningless Android strings.
 */
export const IOS_ONLY_STRING_RESOURCE_KEYS = [
  "NSLocationWhenInUseUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSLocationAlwaysUsageDescription",
  "NSMotionUsageDescription",
  "CFBundleDisplayName",
] as const;

/**
 * Removes iOS-only entries from an Android string resource file.
 *
 * Returns `null` when nothing worth keeping remains, which tells the caller to
 * delete the file instead of leaving an empty `<resources/>` behind.
 */
export function stripIosOnlyStringResources(xml: string): string | null {
  let next = xml;
  for (const key of IOS_ONLY_STRING_RESOURCE_KEYS) {
    next = next.replace(
      new RegExp(`^[^\\S\\n]*<string name="${key}"[^>]*>[\\s\\S]*?</string>[^\\S\\n]*\\n?`, "gm"),
      "",
    );
  }
  return /<string\b/.test(next) ? next : null;
}

/**
 * Network security configuration. Release denies cleartext for every domain;
 * a development build permits it only for the explicitly compiled host.
 */
export function buildNetworkSecurityConfigXml(input: NativeConfigInput): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<network-security-config>",
    '  <base-config cleartextTrafficPermitted="false">',
    "    <trust-anchors>",
    '      <certificates src="system" />',
    "    </trust-anchors>",
    "  </base-config>",
  ];
  if (!input.release && input.usesCleartextOrigin) {
    for (const host of [...new Set([input.webHost, input.apiHost])].sort()) {
      lines.push(
        '  <domain-config cleartextTrafficPermitted="true">',
        `    <domain includeSubdomains="false">${host}</domain>`,
        "  </domain-config>",
      );
    }
  }
  lines.push("</network-security-config>", "");
  return lines.join("\n");
}
