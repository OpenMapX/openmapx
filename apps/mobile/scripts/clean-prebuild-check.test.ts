import { describe, expect, it } from "vitest";
import type { AndroidManifestLike } from "../plugins/nativeConfigTransforms";
import type { GeneratedNativeSurface } from "./generatedNativeChecks";
import { hashNormalizedSurface, normalizeGeneratedNativeSurface } from "./normalizeGeneratedNative";

function androidManifest(): AndroidManifestLike {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      "uses-permission": [
        { $: { "android:name": "android.permission.ACCESS_FINE_LOCATION" } },
        { $: { "android:name": "android.permission.INTERNET" } },
        { $: { "android:name": "android.permission.RECORD_AUDIO", "tools:node": "remove" } },
      ],
      application: [
        {
          $: {
            "android:name": ".MainApplication",
            "android:usesCleartextTraffic": "false",
            "android:allowBackup": "false",
            "android:networkSecurityConfig": "@xml/network_security_config",
            "android:theme": "@style/AppTheme",
          },
          "meta-data": [
            { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "false" } },
          ],
        },
      ],
    },
  };
}

function surface(): GeneratedNativeSurface {
  return {
    infoPlist: {
      WKAppBoundDomains: ["openmapx.com"],
      UIBackgroundModes: ["location"],
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
      NSLocationWhenInUseUsageDescription: "why",
      NSLocationAlwaysAndWhenInUseUsageDescription: "why background",
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["openmapx"] }],
      NSFileProtectionKey: "NSFileProtectionCompleteUntilFirstUserAuthentication",
    },
    entitlements: {
      "com.apple.developer.associated-domains": [
        "applinks:openmapx.com",
        "webcredentials:openmapx.com",
      ],
    },
    pbxproj: "PRODUCT_BUNDLE_IDENTIFIER = org.openmapx.app;\nIPHONEOS_DEPLOYMENT_TARGET = 16.4;\n",
    podfileProperties: { "ios.deploymentTarget": "16.4" },
    androidManifest: androidManifest(),
    networkSecurityConfig: '<base-config cleartextTrafficPermitted="false">',
    gradleProperties:
      "android.minSdkVersion=24\nandroid.compileSdkVersion=36\nandroid.targetSdkVersion=36",
    locationServiceForegroundType: "location",
  };
}

const hashOf = (mutate: (value: GeneratedNativeSurface) => void = () => {}) => {
  const value = surface();
  mutate(value);
  return hashNormalizedSurface(normalizeGeneratedNativeSurface(value));
};

describe("normalizeGeneratedNativeSurface stability", () => {
  it("produces the same hash for an identical regeneration", () => {
    expect(hashOf()).toBe(hashOf());
  });

  it("ignores Xcode object UUID churn", () => {
    expect(
      hashOf((value) => {
        value.pbxproj = `/* 1A2B3C4D5E6F7A8B9C0D1E2F */\n${value.pbxproj}/* FF00AA11BB22 */\n`;
      }),
    ).toBe(hashOf());
  });

  it("ignores permission declaration order", () => {
    expect(
      hashOf((value) => {
        value.androidManifest.manifest["uses-permission"]?.reverse();
      }),
    ).toBe(hashOf());
  });

  it("ignores background-mode ordering", () => {
    expect(
      hashOf((value) => {
        value.infoPlist.UIBackgroundModes = ["location"];
      }),
    ).toBe(hashOf());
  });

  it("ignores an unrelated application attribute", () => {
    expect(
      hashOf((value) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:theme"] = "@style/Other";
      }),
    ).toBe(hashOf());
  });

  it("ignores an unrelated Info.plist key", () => {
    expect(
      hashOf((value) => {
        value.infoPlist.CFBundleVersion = "17";
      }),
    ).toBe(hashOf());
  });
});

describe("normalizeGeneratedNativeSurface sensitivity", () => {
  it.each([
    [
      "an added permission",
      (value: GeneratedNativeSurface) => {
        value.androidManifest.manifest["uses-permission"]?.push({
          $: { "android:name": "android.permission.CAMERA" },
        });
      },
    ],
    [
      "a permission that stopped being removed",
      (value: GeneratedNativeSurface) => {
        const nodes = value.androidManifest.manifest["uses-permission"];
        if (nodes?.[2]) delete nodes[2].$["tools:node"];
      },
    ],
    [
      "a changed bundle identifier",
      (value: GeneratedNativeSurface) => {
        value.pbxproj = value.pbxproj.replace("org.openmapx.app", "com.other.app");
      },
    ],
    [
      "a lowered deployment target",
      (value: GeneratedNativeSurface) => {
        value.pbxproj = value.pbxproj.replace("16.4", "15.0");
      },
    ],
    [
      "an added App-Bound Domain",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.WKAppBoundDomains = ["openmapx.com", "cdn.openmapx.com"];
      },
    ],
    [
      "an added background mode",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.UIBackgroundModes = ["location", "audio"];
      },
    ],
    [
      "an added URL scheme",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.CFBundleURLTypes = [
          { CFBundleURLSchemes: ["openmapx", "org.openmapx.app"] },
        ];
      },
    ],
    [
      "an added entitlement",
      (value: GeneratedNativeSurface) => {
        value.entitlements["aps-environment"] = "production";
      },
    ],
    [
      "a changed associated domain",
      (value: GeneratedNativeSurface) => {
        value.entitlements["com.apple.developer.associated-domains"] = ["applinks:evil.example"];
      },
    ],
    [
      "data protection being dropped",
      (value: GeneratedNativeSurface) => {
        delete value.infoPlist.NSFileProtectionKey;
      },
    ],
    [
      "file sharing being enabled",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.UIFileSharingEnabled = true;
      },
    ],
    [
      "an added usage description",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.NSMotionUsageDescription = "motion";
      },
    ],
    [
      "arbitrary loads being enabled",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true };
      },
    ],
    [
      "an added transport exception domain",
      (value: GeneratedNativeSurface) => {
        value.infoPlist.NSAppTransportSecurity = {
          NSAllowsArbitraryLoads: false,
          NSExceptionDomains: { "evil.example": {} },
        };
      },
    ],
    [
      "cleartext traffic being enabled",
      (value: GeneratedNativeSurface) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:usesCleartextTraffic"] = "true";
      },
    ],
    [
      "backup being enabled",
      (value: GeneratedNativeSurface) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:allowBackup"] = "true";
      },
    ],
    [
      "the OTA update channel being enabled",
      (value: GeneratedNativeSurface) => {
        const application = value.androidManifest.manifest.application?.[0] as {
          "meta-data"?: Array<{ $: Record<string, string> }>;
        };
        application["meta-data"] = [
          { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } },
        ];
      },
    ],
    [
      "a lost foreground-service type",
      (value: GeneratedNativeSurface) => {
        value.locationServiceForegroundType = undefined;
      },
    ],
    [
      "a new cleartext domain",
      (value: GeneratedNativeSurface) => {
        value.networkSecurityConfig +=
          '<domain-config cleartextTrafficPermitted="true"><domain>evil.example</domain></domain-config>';
      },
    ],
    [
      "a lowered target SDK",
      (value: GeneratedNativeSurface) => {
        value.gradleProperties = value.gradleProperties.replace(
          "android.targetSdkVersion=36",
          "android.targetSdkVersion=34",
        );
      },
    ],
  ])("changes the hash for %s", (_label, mutate) => {
    expect(hashOf(mutate)).not.toBe(hashOf());
  });
});
