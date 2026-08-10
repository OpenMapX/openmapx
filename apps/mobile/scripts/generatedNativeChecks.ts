/**
 * Policy checks over the *generated* native projects.
 *
 * These are pure functions over already-parsed documents so the rules can be
 * unit-tested against hostile fixtures without running a prebuild. The CLI
 * wrapper (`assert-generated-native.mts`) does the file reading.
 *
 * The contract is deliberately closed: an unexpected permission, entitlement,
 * background mode or cleartext allowance is a failure, not a warning. A clean
 * regeneration that no longer matches the committed configuration means someone
 * hand-edited build output, which is the exact failure mode CNG must prevent.
 */
import type { AndroidManifestLike } from "../plugins/nativeConfigTransforms.ts";
import {
  FORBIDDEN_IOS_ENTITLEMENTS,
  REQUIRED_ANDROID_PERMISSIONS,
  UNUSED_IOS_USAGE_DESCRIPTION_KEYS,
} from "../plugins/nativeConfigTransforms.ts";

export interface ExpectedNativeSurface {
  release: boolean;
  appId: string;
  scheme: string;
  webHost: string;
  usesCleartextOrigin: boolean;
  hasAppleTeamId: boolean;
  iosDeploymentTarget: string;
  androidMinSdk: number;
  androidCompileSdk: number;
  androidTargetSdk: number;
}

export interface GeneratedNativeSurface {
  infoPlist: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  /** Raw `project.pbxproj` text. */
  pbxproj: string;
  /** Parsed `ios/Podfile.properties.json`. */
  podfileProperties: Record<string, string>;
  androidManifest: AndroidManifestLike;
  networkSecurityConfig: string;
  /** Raw `android/gradle.properties` text. */
  gradleProperties: string;
  /**
   * `android:foregroundServiceType` of Expo's location service as declared by
   * whichever manifest wins the merge — the app's own, or the library's.
   */
  locationServiceForegroundType: string | undefined;
}

/** Permissions that must never reach a generated manifest without removal. */
export const FORBIDDEN_ANDROID_PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.CAMERA",
  "android.permission.READ_CONTACTS",
  "android.permission.READ_CALENDAR",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_SMS",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.USE_EXACT_ALARM",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.QUERY_ALL_PACKAGES",
  "android.permission.BIND_ACCESSIBILITY_SERVICE",
  "com.google.android.gms.permission.AD_ID",
  "com.google.android.c2dm.permission.RECEIVE",
] as const;

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function gradleProperty(properties: string, key: string): string | undefined {
  const match = properties.match(new RegExp(`^${key.replace(/\./g, "\\.")}=(.*)$`, "m"));
  return match?.[1]?.trim();
}

function checkIos(
  generated: GeneratedNativeSurface,
  expected: ExpectedNativeSurface,
  fail: (message: string) => void,
): void {
  const { infoPlist, entitlements } = generated;

  const bundleIds = [
    ...new Set(
      [...generated.pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";\n]+)"?;/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (bundleIds.length !== 1) {
    fail(`expected exactly one iOS bundle identifier, found ${bundleIds.length}`);
  } else if (bundleIds[0] !== expected.appId) {
    fail(`iOS bundle identifier is ${bundleIds[0]}, expected ${expected.appId}`);
  }

  const deploymentTargets = [
    ...new Set(
      [...generated.pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;\n]+);/g)].map((m) =>
        m[1].trim(),
      ),
    ),
  ];
  if (!deploymentTargets.includes(expected.iosDeploymentTarget)) {
    fail(
      `iOS deployment target ${deploymentTargets.join("/") || "(none)"} does not include ${expected.iosDeploymentTarget}`,
    );
  }
  if (generated.podfileProperties["ios.deploymentTarget"] !== expected.iosDeploymentTarget) {
    fail("Podfile deployment target disagrees with the configured minimum iOS version");
  }

  const appBound = asStringArray(infoPlist.WKAppBoundDomains);
  if (!appBound) fail("WKAppBoundDomains is missing or not a string array");
  else if (appBound.length !== 1 || appBound[0] !== expected.webHost) {
    fail(`WKAppBoundDomains must be exactly [${expected.webHost}], found [${appBound.join(", ")}]`);
  } else if (appBound.some((domain) => domain.includes("*"))) {
    fail("WKAppBoundDomains must not contain a wildcard");
  }

  const backgroundModes = asStringArray(infoPlist.UIBackgroundModes) ?? [];
  if (backgroundModes.length !== 1 || backgroundModes[0] !== "location") {
    fail(`UIBackgroundModes must be exactly ["location"], found [${backgroundModes.join(", ")}]`);
  }
  if (backgroundModes.includes("audio")) {
    fail("the audio background mode is not declared by this release");
  }

  for (const key of [
    "NSLocationWhenInUseUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
  ]) {
    const value = infoPlist[key];
    if (typeof value !== "string" || value.trim().length < 40) {
      fail(`${key} is missing or too short to be a real purpose string`);
    } else if (value.includes("$(PRODUCT_NAME)") || /allow .* to access/i.test(value)) {
      fail(`${key} still contains the generated placeholder text`);
    }
  }
  for (const key of UNUSED_IOS_USAGE_DESCRIPTION_KEYS) {
    if (key in infoPlist) fail(`${key} declares a protected resource this app never requests`);
  }

  const transport = infoPlist.NSAppTransportSecurity as Record<string, unknown> | undefined;
  if (transport?.NSAllowsArbitraryLoads !== false) {
    fail("NSAppTransportSecurity must set NSAllowsArbitraryLoads to false");
  }
  if (expected.release && transport && "NSExceptionDomains" in transport) {
    fail("a release build must declare no App Transport Security exception domains");
  }

  const urlTypes = (infoPlist.CFBundleURLTypes ?? []) as Array<{ CFBundleURLSchemes?: string[] }>;
  const schemes = urlTypes.flatMap((entry) => entry.CFBundleURLSchemes ?? []);
  if (schemes.length !== 1 || schemes[0] !== expected.scheme) {
    fail(`CFBundleURLSchemes must be exactly [${expected.scheme}], found [${schemes.join(", ")}]`);
  }

  for (const key of FORBIDDEN_IOS_ENTITLEMENTS) {
    if (key in entitlements) fail(`entitlement ${key} enables a capability this app does not use`);
  }

  const associated = asStringArray(entitlements["com.apple.developer.associated-domains"]);
  if (expected.hasAppleTeamId) {
    const wanted = [`applinks:${expected.webHost}`, `webcredentials:${expected.webHost}`];
    if (!associated || associated.length !== wanted.length) {
      fail("associated domains must contain exactly applinks and webcredentials for the web host");
    } else {
      for (const domain of wanted) {
        if (!associated.includes(domain)) fail(`associated domains is missing ${domain}`);
      }
      if (associated.some((domain) => domain.includes("*"))) {
        fail("associated domains must not contain a wildcard");
      }
    }
  } else if (associated) {
    fail("a build without a real Apple Team ID must not declare associated domains");
  }
}

function checkAndroid(
  generated: GeneratedNativeSurface,
  expected: ExpectedNativeSurface,
  fail: (message: string) => void,
): void {
  const manifest = generated.androidManifest.manifest;
  const permissionNodes = manifest["uses-permission"] ?? [];

  const counts = new Map<string, number>();
  for (const node of permissionNodes) {
    const name = node.$["android:name"];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) fail(`permission ${name} is declared ${count} times`);
  }
  for (const permission of REQUIRED_ANDROID_PERMISSIONS) {
    if (!counts.has(permission)) fail(`required permission ${permission} is missing`);
  }
  for (const node of permissionNodes) {
    const name = node.$["android:name"];
    const removed = node.$["tools:node"] === "remove";
    if (
      (FORBIDDEN_ANDROID_PERMISSIONS as readonly string[]).includes(name) &&
      !removed &&
      !(REQUIRED_ANDROID_PERMISSIONS as readonly string[]).includes(name)
    ) {
      fail(`permission ${name} must not be requested by this app`);
    }
  }

  const applications = manifest.application ?? [];
  if (applications.length !== 1) {
    fail(`expected exactly one <application> node, found ${applications.length}`);
  }
  for (const application of applications) {
    const cleartext = application.$["android:usesCleartextTraffic"];
    const expectCleartext = !expected.release && expected.usesCleartextOrigin;
    if (cleartext !== String(expectCleartext)) {
      fail(`android:usesCleartextTraffic is ${cleartext}, expected ${expectCleartext}`);
    }
    if (application.$["android:allowBackup"] !== "false") {
      fail("android:allowBackup must be false so an active session is never backed up");
    }
    if (application.$["android:networkSecurityConfig"] !== "@xml/network_security_config") {
      fail("the application must reference the generated network security config");
    }
    if (application.$["android:debuggable"] === "true") {
      fail("a generated manifest must not force android:debuggable");
    }
    const metaData = (application["meta-data"] ?? []) as Array<{ $: Record<string, string> }>;
    const updatesEnabled = metaData.find(
      (node) => node.$["android:name"] === "expo.modules.updates.ENABLED",
    );
    if (updatesEnabled && updatesEnabled.$["android:value"] !== "false") {
      fail("expo-updates must stay disabled: this app ships no OTA native bundle");
    }
    for (const node of metaData) {
      if (
        /EAS|eas\.projectId|expo\.modules\.updates\.EXPO_UPDATE_URL/.test(node.$["android:name"])
      ) {
        fail(`unexpected update-service metadata ${node.$["android:name"]}`);
      }
    }
  }

  if (generated.locationServiceForegroundType !== "location") {
    fail(
      `Expo's location service must declare android:foregroundServiceType="location", found ${
        generated.locationServiceForegroundType ?? "(none)"
      }`,
    );
  }

  if (!/<base-config cleartextTrafficPermitted="false">/.test(generated.networkSecurityConfig)) {
    fail("the network security config must deny cleartext by default");
  }
  if (
    expected.release &&
    /cleartextTrafficPermitted="true"/.test(generated.networkSecurityConfig)
  ) {
    fail("a release network security config must permit no cleartext domain");
  }

  const gradleChecks: Array<[string, string]> = [
    ["android.minSdkVersion", String(expected.androidMinSdk)],
    ["android.compileSdkVersion", String(expected.androidCompileSdk)],
    ["android.targetSdkVersion", String(expected.androidTargetSdk)],
  ];
  for (const [key, want] of gradleChecks) {
    const actual = gradleProperty(generated.gradleProperties, key);
    if (actual !== want) fail(`${key} is ${actual ?? "(unset)"}, expected ${want}`);
  }
}

/**
 * Returns a human-readable failure for every policy violation. An empty array
 * means the generated projects match the committed configuration exactly.
 */
export function checkGeneratedNativeSurface(
  generated: GeneratedNativeSurface,
  expected: ExpectedNativeSurface,
): string[] {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  checkIos(generated, expected, fail);
  checkAndroid(generated, expected, fail);
  return failures;
}

/**
 * The identifiers and booleans the CLI prints. Deliberately excludes anything
 * that could carry signing material, provisioning data, or a team identifier.
 */
export function summarizeGeneratedNativeSurface(
  generated: GeneratedNativeSurface,
  expected: ExpectedNativeSurface,
): Record<string, string | boolean> {
  const backgroundModes = asStringArray(generated.infoPlist.UIBackgroundModes) ?? [];
  return {
    appId: expected.appId,
    scheme: expected.scheme,
    webHost: expected.webHost,
    release: expected.release,
    iosDeploymentTarget: expected.iosDeploymentTarget,
    iosBackgroundModes: backgroundModes.join(","),
    iosAppBoundDomainsExact:
      (asStringArray(generated.infoPlist.WKAppBoundDomains) ?? []).join(",") === expected.webHost,
    iosAssociatedDomains: Boolean(entitlementHasAssociatedDomains(generated.entitlements)),
    iosPushEntitlement: FORBIDDEN_IOS_ENTITLEMENTS.some((key) => key in generated.entitlements),
    androidLocationForegroundServiceType: generated.locationServiceForegroundType ?? "(none)",
    androidMinSdk: gradleProperty(generated.gradleProperties, "android.minSdkVersion") ?? "(unset)",
    androidTargetSdk:
      gradleProperty(generated.gradleProperties, "android.targetSdkVersion") ?? "(unset)",
    androidCleartextDenied: !/cleartextTrafficPermitted="true"/.test(
      generated.networkSecurityConfig,
    ),
  };
}

function entitlementHasAssociatedDomains(entitlements: Record<string, unknown>): boolean {
  return Array.isArray(entitlements["com.apple.developer.associated-domains"]);
}
