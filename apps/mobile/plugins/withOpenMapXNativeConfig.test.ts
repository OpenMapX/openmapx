import { describe, expect, it } from "vitest";
import { readMobileConfig } from "../config/mobileConfig";
import {
  type AndroidManifestLike,
  applyAndroidApplicationSecurity,
  applyAndroidPermissions,
  applyAppBoundDomains,
  applyAppTransportSecurity,
  applyAssociatedDomains,
  applyBackgroundModes,
  applyDataProtection,
  applyLocationServiceType,
  applyUrlSchemes,
  buildNetworkSecurityConfigXml,
  FORBIDDEN_IOS_SHARING_KEYS,
  type NativeConfigInput,
  REQUIRED_ANDROID_PERMISSIONS,
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
  it("sets App-Bound Domains to exactly the compiled host", () => {
    expect(applyAppBoundDomains({}, RELEASE).WKAppBoundDomains).toEqual(["openmapx.com"]);
  });

  it("replaces a wildcard or extra App-Bound Domain rather than merging it", () => {
    const result = applyAppBoundDomains({ WKAppBoundDomains: ["*.evil.example"] }, RELEASE);
    expect(result.WKAppBoundDomains).toEqual(["openmapx.com"]);
  });

  it("declares only the location background mode", () => {
    expect(applyBackgroundModes({}).UIBackgroundModes).toEqual(["location"]);
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

  it("removes a URL type whose schemes are all disallowed", () => {
    const result = applyUrlSchemes(
      { CFBundleURLTypes: [{ CFBundleURLSchemes: ["org.openmapx.app"] }] },
      "openmapx",
    );
    expect(result.CFBundleURLTypes).toEqual([{ CFBundleURLSchemes: ["openmapx"] }]);
  });
});

describe("Android transforms", () => {
  it("adds every required permission exactly once and keeps existing ones", () => {
    const result = applyAndroidPermissions(baseManifest());
    const names = result.manifest["uses-permission"]?.map((node) => node.$["android:name"]) ?? [];
    expect(names).toContain("android.permission.VIBRATE");
    for (const permission of REQUIRED_ANDROID_PERMISSIONS) expect(names).toContain(permission);
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

    expect(buildNetworkSecurityConfigXml(input)).toBe(buildNetworkSecurityConfigXml(input));
  });
});

describe("withOpenMapXNativeConfig", () => {
  it("registers iOS and Android mods without mutating the incoming config object", () => {
    const base = { name: "OpenMapX", slug: "openmapx" };
    // `mods` is added by Expo's plugin machinery and is not part of the public
    // `ExpoConfig` type, so the assertion reads it through a narrow cast.
    const result = withOpenMapXNativeConfig({ ...base }) as {
      mods?: { ios?: unknown; android?: unknown };
    };
    expect(result.mods?.ios).toBeDefined();
    expect(result.mods?.android).toBeDefined();
    expect(base).toEqual({ name: "OpenMapX", slug: "openmapx" });
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

  it.each(FORBIDDEN_IOS_SHARING_KEYS)(
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
