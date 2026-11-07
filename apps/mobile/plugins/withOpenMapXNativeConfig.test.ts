import { describe, expect, it } from "vitest";
import { readMobileConfig } from "../config/mobileConfig";
import { IOS_USAGE_DESCRIPTIONS, MOBILE_LOCALES } from "../config/nativeCopy";
import {
  type AndroidManifestLike,
  applyAndroidApplicationSecurity,
  applyAndroidPermissions,
  applyAndroidReleaseSigning,
  applyAppBoundDomains,
  applyAppTransportSecurity,
  applyAssociatedDomains,
  applyBackgroundModes,
  applyDataProtection,
  applyLocationServiceType,
  applyUrlSchemes,
  buildNetworkSecurityConfigXml,
  IOS_ONLY_STRING_RESOURCE_KEYS,
  type NativeConfigInput,
  removeUnusedUsageDescriptions,
  stripIosOnlyStringResources,
} from "./nativeConfigTransforms";
import { nativeConfigInputFrom, withOpenMapXNativeConfig } from "./withOpenMapXNativeConfig";

const RELEASE: NativeConfigInput = {
  release: true,
  webHost: "openmapx.com",
  apiHost: "openmapx.com",
  usesCleartextOrigin: false,
  hasAppleTeamId: true,
  scheme: "openmapx",
};

const DEVELOPMENT: NativeConfigInput = {
  release: false,
  webHost: "localhost",
  apiHost: "localhost",
  usesCleartextOrigin: true,
  hasAppleTeamId: false,
  scheme: "openmapx-dev",
};

function baseManifest(): AndroidManifestLike {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      "uses-permission": [{ $: { "android:name": "android.permission.VIBRATE" } }],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          service: [
            { $: { "android:name": "expo.modules.location.services.LocationTaskService" } },
            { $: { "android:name": "com.example.OtherService" } },
          ],
        },
      ],
    },
  };
}

describe("nativeConfigInputFrom", () => {
  it("derives its hosts and cleartext decision from the compiled config", () => {
    const input = nativeConfigInputFrom(
      readMobileConfig({ OPENMAPX_MOBILE_RELEASE: "1", OPENMAPX_APPLE_TEAM_ID: "ABCDEFGHIJ" }),
    );
    expect(input).toEqual({
      release: true,
      webHost: "openmapx.com",
      apiHost: "openmapx.com",
      usesCleartextOrigin: false,
      hasAppleTeamId: true,
      scheme: "openmapx",
    });
  });

  it("flags a development http origin as cleartext", () => {
    const input = nativeConfigInputFrom(
      readMobileConfig({
        OPENMAPX_MOBILE_RELEASE: "0",
        OPENMAPX_MOBILE_WEB_ORIGIN: "http://localhost:3000",
        OPENMAPX_MOBILE_APP_ID: "org.example.maps",
      }),
    );
    expect(input.usesCleartextOrigin).toBe(true);
    expect(input.webHost).toBe("localhost");
    expect(input.hasAppleTeamId).toBe(false);
  });
});

describe("iOS transforms", () => {
  it("replaces a wildcard or extra App-Bound Domain rather than merging it", () => {
    const result = applyAppBoundDomains({ WKAppBoundDomains: ["*.evil.example"] }, RELEASE);
    expect(result.WKAppBoundDomains).toEqual(["openmapx.com"]);
  });

  it("never keeps an audio background mode", () => {
    const result = applyBackgroundModes({ UIBackgroundModes: ["location", "audio", "fetch"] });
    expect(result.UIBackgroundModes).toEqual(["location"]);
  });

  it("forbids arbitrary loads in release", () => {
    expect(applyAppTransportSecurity({}, RELEASE).NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
    });
  });

  it("allows insecure loads only for the explicit development host", () => {
    expect(applyAppTransportSecurity({}, DEVELOPMENT).NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
      NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } },
    });
  });

  it("preserves webcredentials while adding applinks", () => {
    const result = applyAssociatedDomains(
      { "com.apple.developer.associated-domains": ["webcredentials:openmapx.com"] },
      RELEASE,
    );
    expect(result["com.apple.developer.associated-domains"]).toEqual([
      "applinks:openmapx.com",
      "webcredentials:openmapx.com",
    ]);
  });

  it("omits the entitlement entirely without a real Apple Team ID", () => {
    const result = applyAssociatedDomains(
      { "com.apple.developer.associated-domains": ["webcredentials:localhost"] },
      DEVELOPMENT,
    );
    expect(result).not.toHaveProperty("com.apple.developer.associated-domains");
  });

  it.each([
    ["release", RELEASE],
    ["development", DEVELOPMENT],
  ])("never leaves a push entitlement in a %s build", (_label, input) => {
    const result = applyAssociatedDomains({ "aps-environment": "development" }, input);
    expect(result).not.toHaveProperty("aps-environment");
  });

  it("drops usage descriptions for resources the app never requests", () => {
    const result = removeUnusedUsageDescriptions({
      NSLocationWhenInUseUsageDescription: "keep me",
      NSLocationAlwaysUsageDescription: "Allow access",
      NSMotionUsageDescription: "Allow motion",
    });
    expect(result).toEqual({ NSLocationWhenInUseUsageDescription: "keep me" });
  });

  it("registers exactly the compiled URL scheme", () => {
    const result = applyUrlSchemes(
      { CFBundleURLTypes: [{ CFBundleURLSchemes: ["openmapx", "org.openmapx.app"] }] },
      "openmapx",
    );
    expect(result.CFBundleURLTypes).toEqual([{ CFBundleURLSchemes: ["openmapx"] }]);
  });

  it("adds the scheme when the generated plist has none", () => {
    expect(applyUrlSchemes({}, "openmapx").CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ["openmapx"] },
    ]);
  });

  it.each([{ schemes: [] }, { schemes: ["org.openmapx.app"] }])(
    "replaces disallowed URL schemes $schemes",
    ({ schemes }) => {
      const result = applyUrlSchemes(
        { CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }] },
        "openmapx",
      );
      expect(result.CFBundleURLTypes).toEqual([{ CFBundleURLSchemes: ["openmapx"] }]);
    },
  );
});

describe("Android transforms", () => {
  it("adds every required permission exactly once and keeps existing ones", () => {
    const result = applyAndroidPermissions(baseManifest());
    const names = result.manifest["uses-permission"]?.map((node) => node.$["android:name"]) ?? [];
    expect(names).toContain("android.permission.VIBRATE");
    expect(names).toEqual(
      expect.arrayContaining([
        "androidx.car.app.NAVIGATION_TEMPLATES",
        "androidx.car.app.ACCESS_SURFACE",
        "android.permission.RECORD_AUDIO",
        "android.permission.INTERNET",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.POST_PROMOTED_NOTIFICATIONS",
        "android.permission.RECEIVE_BOOT_COMPLETED",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("types only the Expo location service as a location foreground service", () => {
    const services = applyLocationServiceType(baseManifest()).manifest.application?.[0]?.service;
    expect(services?.[0]?.$["android:foregroundServiceType"]).toBe("location");
    expect(services?.[1]?.$).not.toHaveProperty("android:foregroundServiceType");
  });

  it("denies cleartext and backup in release", () => {
    const application = applyAndroidApplicationSecurity(baseManifest(), RELEASE).manifest
      .application?.[0];
    expect(application?.$["android:usesCleartextTraffic"]).toBe("false");
    expect(application?.$["android:allowBackup"]).toBe("false");
    expect(application?.$["android:networkSecurityConfig"]).toBe("@xml/network_security_config");
  });

  it("permits cleartext only for an explicit development origin", () => {
    const application = applyAndroidApplicationSecurity(baseManifest(), DEVELOPMENT).manifest
      .application?.[0];
    expect(application?.$["android:usesCleartextTraffic"]).toBe("true");
    expect(application?.$["android:allowBackup"]).toBe("false");
  });

  it("builds a release network security config that permits no cleartext domain", () => {
    const xml = buildNetworkSecurityConfigXml(RELEASE);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
    expect(xml).not.toContain('cleartextTrafficPermitted="true"');
    expect(xml).not.toContain("domain-config");
  });

  it("scopes a development cleartext exception to the compiled host", () => {
    const xml = buildNetworkSecurityConfigXml(DEVELOPMENT);
    expect(xml).toContain('<domain includeSubdomains="false">localhost</domain>');
    expect(xml).not.toContain("openmapx.com");
  });

  it.each([RELEASE, { ...DEVELOPMENT, usesCleartextOrigin: false }])(
    "allows local Metro in the debug resource even with HTTPS app origins",
    (input) => {
      const xml = buildNetworkSecurityConfigXml(input, "debug");
      expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
      expect(
        [...xml.matchAll(/<domain includeSubdomains="false">(.*?)<\/domain>/g)].map(
          (match) => match[1],
        ),
      ).toEqual(["10.0.2.2", "127.0.0.1", "localhost"]);
      expect(xml).not.toContain('src="user"');
    },
  );

  it("preserves the explicit app host alongside debug Metro without duplicates", () => {
    const xml = buildNetworkSecurityConfigXml(DEVELOPMENT, "debug");
    expect(xml.match(/<domain includeSubdomains="false">localhost<\/domain>/g)).toHaveLength(1);
    expect(xml).toContain('<domain includeSubdomains="false">10.0.2.2</domain>');
  });
});

describe("Android string resources", () => {
  const localeStrings = `<resources>
  <string name="NSLocationWhenInUseUsageDescription">"why"</string>
  <string name="NSLocationAlwaysAndWhenInUseUsageDescription">"why background"</string>
</resources>`;

  it("deletes a locale file that held only iOS usage descriptions", () => {
    // Android lint fails a release build on a translated string with no
    // default-locale entry, and these keys mean nothing on Android anyway.
    expect(stripIosOnlyStringResources(localeStrings)).toBeNull();
  });

  it("keeps a locale file that still has a real Android string", () => {
    const mixed = `<resources>
  <string name="NSLocationWhenInUseUsageDescription">"why"</string>
  <string name="app_name">OpenMapX</string>
</resources>`;
    const result = stripIosOnlyStringResources(mixed);
    expect(result).not.toBeNull();
    expect(result).toContain('<string name="app_name">OpenMapX</string>');
    expect(result).not.toContain("NSLocationWhenInUseUsageDescription");
  });

  it("strips every iOS usage description Expo's locales field writes", () => {
    // A usage description added to the iOS copy without being listed here
    // reaches Android's values-b+<locale> resources and fails lintVitalRelease.
    for (const locale of MOBILE_LOCALES) {
      for (const key of Object.keys(IOS_USAGE_DESCRIPTIONS[locale])) {
        expect(IOS_ONLY_STRING_RESOURCE_KEYS).toContain(key);
      }
    }
  });

  it("deletes a locale file that held only voice search usage descriptions", () => {
    const voiceStrings = `<resources>
  <string name="NSMicrophoneUsageDescription">"mic"</string>
  <string name="NSSpeechRecognitionUsageDescription">"speech"</string>
</resources>`;
    expect(stripIosOnlyStringResources(voiceStrings)).toBeNull();
  });

  it("leaves a file with no iOS keys untouched", () => {
    const androidOnly = `<resources>\n  <string name="app_name">OpenMapX</string>\n</resources>`;
    expect(stripIosOnlyStringResources(androidOnly)).toBe(androidOnly);
  });

  it("removes a multi-line value without truncating the file", () => {
    const wrapped = `<resources>
  <string name="NSLocationAlwaysAndWhenInUseUsageDescription">"first line
  second line"</string>
  <string name="app_name">OpenMapX</string>
</resources>`;
    const result = stripIosOnlyStringResources(wrapped);
    expect(result).toContain("app_name");
    expect(result).not.toContain("second line");
  });

  it("is idempotent", () => {
    const once = stripIosOnlyStringResources(
      `<resources>\n  <string name="NSMotionUsageDescription">"m"</string>\n  <string name="app_name">X</string>\n</resources>`,
    );
    expect(stripIosOnlyStringResources(once as string)).toBe(once);
  });
});

describe("idempotency", () => {
  it.each([
    ["release", RELEASE],
    ["development", DEVELOPMENT],
  ])("produces byte-equivalent %s output when applied twice", (_label, input) => {
    const info = (plist: Record<string, unknown>) =>
      applyUrlSchemes(
        applyAppTransportSecurity(
          removeUnusedUsageDescriptions(applyBackgroundModes(applyAppBoundDomains(plist, input))),
          input,
        ),
        input.scheme,
      );
    const infoOnce = info({});
    expect(JSON.stringify(info(infoOnce))).toBe(JSON.stringify(infoOnce));

    const entitlementsOnce = applyAssociatedDomains({}, input);
    const entitlementsTwice = applyAssociatedDomains(entitlementsOnce, input);
    expect(JSON.stringify(entitlementsTwice)).toBe(JSON.stringify(entitlementsOnce));

    const manifestOnce = applyAndroidApplicationSecurity(
      applyLocationServiceType(applyAndroidPermissions(baseManifest())),
      input,
    );
    const manifestTwice = applyAndroidApplicationSecurity(
      applyLocationServiceType(applyAndroidPermissions(manifestOnce)),
      input,
    );
    expect(JSON.stringify(manifestTwice)).toBe(JSON.stringify(manifestOnce));
  });
});

describe("withOpenMapXNativeConfig", () => {
  it("registers iOS and Android mods through Expo", () => {
    const base = { name: "OpenMapX", slug: "openmapx" };
    // `mods` is added by Expo's plugin machinery and is not part of the public
    // `ExpoConfig` type, so the assertion reads it through a narrow cast.
    const result = withOpenMapXNativeConfig(base) as {
      mods?: { ios?: unknown; android?: unknown };
    };
    expect(result.mods?.ios).toBeDefined();
    expect(result.mods?.android).toBeDefined();
  });

  it("is safe to apply twice", () => {
    const once = withOpenMapXNativeConfig({ name: "OpenMapX", slug: "openmapx" });
    expect(() => withOpenMapXNativeConfig(once)).not.toThrow();
  });
});

describe("iOS storage protection", () => {
  it("protects the container until first unlock, so background reads still work", () => {
    // `Complete` would make the session database unreadable while the device is
    // locked — precisely when locked-screen navigation needs it.
    expect(applyDataProtection({}).NSFileProtectionKey).toBe(
      "NSFileProtectionCompleteUntilFirstUserAuthentication",
    );
  });

  it("allows Files to offer OpenMapX without exposing its private container", () => {
    expect(applyDataProtection({}).LSSupportsOpeningDocumentsInPlace).toBe(true);
    expect(applyDataProtection({ UISupportsDocumentBrowser: true })).not.toHaveProperty(
      "UISupportsDocumentBrowser",
    );
  });

  it.each(["UIFileSharingEnabled", "UISupportsDocumentBrowser"])(
    "removes %s, which would expose the session database",
    (key) => {
      const result = applyDataProtection({ [key]: true });
      expect(result).not.toHaveProperty(key);
    },
  );

  it("is idempotent", () => {
    const once = applyDataProtection({ UIFileSharingEnabled: true });
    expect(JSON.stringify(applyDataProtection(once))).toBe(JSON.stringify(once));
  });
});

describe("Android release signing", () => {
  // The signing and build-type blocks of Expo's generated `app/build.gradle`.
  const EXPO_APP_GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

  function releaseBlock(gradle: string): string {
    const start = gradle.indexOf("        release {", gradle.indexOf("buildTypes {"));
    return gradle.slice(start, gradle.indexOf("\n        }", start));
  }

  it("signs the release build type from the external properties file", () => {
    const gradle = applyAndroidReleaseSigning(EXPO_APP_GRADLE);
    expect(gradle).toContain('rootProject.file("release-signing.properties")');
    for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword"]) {
      expect(gradle).toContain(`"${key}"`);
    }
    expect(releaseBlock(gradle)).toContain('signingConfig signingConfigs.findByName("release")');
    expect(releaseBlock(gradle)).not.toContain("signingConfigs.debug");
    const debugStart = gradle.indexOf("        debug {", gradle.indexOf("buildTypes {"));
    expect(debugStart).toBeGreaterThanOrEqual(0);
    expect(gradle.slice(debugStart, gradle.indexOf("}", debugStart))).toContain(
      "signingConfig signingConfigs.debug",
    );
  });

  it("is idempotent", () => {
    const once = applyAndroidReleaseSigning(EXPO_APP_GRADLE);
    expect(applyAndroidReleaseSigning(once)).toBe(once);
  });

  it("refuses a build file whose signing blocks it does not recognise", () => {
    expect(() => applyAndroidReleaseSigning("android {}\n")).toThrow(/signing/);
  });
});

it("strips a speculative microphone foreground service permission but keeps merge denial", () => {
  const result = applyAndroidPermissions({
    manifest: {
      $: {},
      "uses-permission": [
        { $: { "android:name": "android.permission.FOREGROUND_SERVICE_MICROPHONE" } },
        {
          $: {
            "android:name": "android.permission.FOREGROUND_SERVICE_MICROPHONE",
            "tools:node": "remove",
          },
        },
      ],
    },
  });
  expect(
    result.manifest["uses-permission"]?.filter(
      (node) => node.$["android:name"] === "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    ),
  ).toEqual([
    {
      $: {
        "android:name": "android.permission.FOREGROUND_SERVICE_MICROPHONE",
        "tools:node": "remove",
      },
    },
  ]);
  expect(result.manifest["uses-permission"]).toContainEqual({
    $: { "android:name": "android.permission.RECORD_AUDIO" },
  });
});
