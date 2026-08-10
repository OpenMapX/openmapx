import { describe, expect, it } from "vitest";
import type { AndroidManifestLike } from "../plugins/nativeConfigTransforms";
import { REQUIRED_ANDROID_PERMISSIONS } from "../plugins/nativeConfigTransforms";
import {
  checkGeneratedNativeSurface,
  type ExpectedNativeSurface,
  type GeneratedNativeSurface,
  summarizeGeneratedNativeSurface,
} from "./generatedNativeChecks";

const EXPECTED: ExpectedNativeSurface = {
  release: true,
  appId: "org.openmapx.app",
  scheme: "openmapx",
  webHost: "openmapx.com",
  usesCleartextOrigin: false,
  hasAppleTeamId: true,
  iosDeploymentTarget: "16.4",
  androidMinSdk: 24,
  androidCompileSdk: 36,
  androidTargetSdk: 36,
};

function androidManifest(): AndroidManifestLike {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      "uses-permission": [
        ...REQUIRED_ANDROID_PERMISSIONS.map((name) => ({ $: { "android:name": name } })),
        { $: { "android:name": "android.permission.RECORD_AUDIO", "tools:node": "remove" } },
      ],
      application: [
        {
          $: {
            "android:name": ".MainApplication",
            "android:usesCleartextTraffic": "false",
            "android:allowBackup": "false",
            "android:networkSecurityConfig": "@xml/network_security_config",
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
      NSLocationWhenInUseUsageDescription:
        "OpenMapX uses your location to show where you are on the map and to guide you along a route you start.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "OpenMapX uses your location in the background so navigation you have started keeps guiding you while the screen is locked. Tracking stops when you end navigation.",
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["openmapx"] }],
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
    gradleProperties: [
      "android.minSdkVersion=24",
      "android.compileSdkVersion=36",
      "android.targetSdkVersion=36",
    ].join("\n"),
    locationServiceForegroundType: "location",
  };
}

/** Applies a mutation to a fresh fixture and returns the resulting failures. */
function failuresAfter(
  mutate: (value: GeneratedNativeSurface) => void,
  expected: ExpectedNativeSurface = EXPECTED,
): string[] {
  const value = surface();
  mutate(value);
  return checkGeneratedNativeSurface(value, expected);
}

describe("checkGeneratedNativeSurface", () => {
  it("accepts a correctly generated release surface", () => {
    expect(checkGeneratedNativeSurface(surface(), EXPECTED)).toEqual([]);
  });
});

describe("iOS policy", () => {
  it("rejects a bundle identifier that does not match the build config", () => {
    expect(
      failuresAfter((value) => {
        value.pbxproj = value.pbxproj.replace("org.openmapx.app", "com.evil.app");
      }),
    ).toContainEqual(expect.stringContaining("bundle identifier"));
  });

  it("rejects more than one bundle identifier", () => {
    expect(
      failuresAfter((value) => {
        value.pbxproj += "PRODUCT_BUNDLE_IDENTIFIER = org.openmapx.app.extra;\n";
      }),
    ).toContainEqual(expect.stringContaining("exactly one iOS bundle identifier"));
  });

  it.each([
    [["*.openmapx.com"], "wildcard"],
    [["openmapx.com", "cdn.openmapx.com"], "extra host"],
    [["openmapx.com.evil.example"], "lookalike host"],
  ])("rejects App-Bound Domains %j (%s)", (domains) => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.WKAppBoundDomains = domains;
      }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an audio background mode", () => {
    const failures = failuresAfter((value) => {
      value.infoPlist.UIBackgroundModes = ["location", "audio"];
    });
    expect(failures).toContainEqual(expect.stringContaining("audio background mode"));
  });

  it("rejects a usage description for a resource the app never requests", () => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.NSMotionUsageDescription = "Allow motion";
      }),
    ).toContainEqual(expect.stringContaining("NSMotionUsageDescription"));
  });

  it("rejects placeholder purpose strings", () => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.NSLocationWhenInUseUsageDescription =
          "Allow $(PRODUCT_NAME) to access your location";
      }),
    ).toContainEqual(expect.stringContaining("placeholder"));
  });

  it("rejects arbitrary loads", () => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true };
      }),
    ).toContainEqual(expect.stringContaining("NSAllowsArbitraryLoads"));
  });

  it("rejects a release cleartext exception domain", () => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.NSAppTransportSecurity = {
          NSAllowsArbitraryLoads: false,
          NSExceptionDomains: { "openmapx.com": {} },
        };
      }),
    ).toContainEqual(expect.stringContaining("exception domains"));
  });

  it("rejects an extra registered URL scheme", () => {
    expect(
      failuresAfter((value) => {
        value.infoPlist.CFBundleURLTypes = [
          { CFBundleURLSchemes: ["openmapx", "org.openmapx.app"] },
        ];
      }),
    ).toContainEqual(expect.stringContaining("CFBundleURLSchemes"));
  });

  it("rejects a push entitlement", () => {
    expect(
      failuresAfter((value) => {
        value.entitlements["aps-environment"] = "production";
      }),
    ).toContainEqual(expect.stringContaining("aps-environment"));
  });

  it("rejects associated domains for the wrong host", () => {
    expect(
      failuresAfter((value) => {
        value.entitlements["com.apple.developer.associated-domains"] = [
          "applinks:evil.example",
          "webcredentials:openmapx.com",
        ];
      }),
    ).toContainEqual(expect.stringContaining("applinks:openmapx.com"));
  });

  it("rejects associated domains in a build without a Team ID", () => {
    expect(failuresAfter(() => {}, { ...EXPECTED, hasAppleTeamId: false })).toContainEqual(
      expect.stringContaining("must not declare associated domains"),
    );
  });

  it("rejects a deployment target below the supported floor", () => {
    expect(
      failuresAfter((value) => {
        value.pbxproj = value.pbxproj.replace("16.4", "15.1");
        value.podfileProperties["ios.deploymentTarget"] = "15.1";
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe("Android policy", () => {
  it("rejects a missing required permission", () => {
    expect(
      failuresAfter((value) => {
        value.androidManifest.manifest["uses-permission"] = value.androidManifest.manifest[
          "uses-permission"
        ]?.filter(
          (node) => node.$["android:name"] !== "android.permission.FOREGROUND_SERVICE_LOCATION",
        );
      }),
    ).toContainEqual(expect.stringContaining("FOREGROUND_SERVICE_LOCATION"));
  });

  it("rejects a duplicated permission declaration", () => {
    expect(
      failuresAfter((value) => {
        value.androidManifest.manifest["uses-permission"]?.push({
          $: { "android:name": "android.permission.ACCESS_FINE_LOCATION" },
        });
      }),
    ).toContainEqual(expect.stringContaining("declared 2 times"));
  });

  it("rejects a sensitive permission that is actually requested", () => {
    expect(
      failuresAfter((value) => {
        value.androidManifest.manifest["uses-permission"]?.push({
          $: { "android:name": "android.permission.RECORD_AUDIO" },
        });
      }),
    ).toContainEqual(expect.stringContaining("RECORD_AUDIO"));
  });

  it("rejects release cleartext traffic", () => {
    expect(
      failuresAfter((value) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:usesCleartextTraffic"] = "true";
      }),
    ).toContainEqual(expect.stringContaining("usesCleartextTraffic"));
  });

  it("rejects an app that allows Android backup", () => {
    expect(
      failuresAfter((value) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:allowBackup"] = "true";
      }),
    ).toContainEqual(expect.stringContaining("allowBackup"));
  });

  it("rejects a debuggable generated manifest", () => {
    expect(
      failuresAfter((value) => {
        const application = value.androidManifest.manifest.application?.[0];
        if (application) application.$["android:debuggable"] = "true";
      }),
    ).toContainEqual(expect.stringContaining("debuggable"));
  });

  it("rejects an enabled OTA update channel", () => {
    expect(
      failuresAfter((value) => {
        const application = value.androidManifest.manifest.application?.[0] as {
          "meta-data"?: Array<{ $: Record<string, string> }>;
        };
        application["meta-data"] = [
          { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } },
        ];
      }),
    ).toContainEqual(expect.stringContaining("expo-updates"));
  });

  it("rejects a location service without the location foreground-service type", () => {
    expect(
      failuresAfter((value) => {
        value.locationServiceForegroundType = undefined;
      }),
    ).toContainEqual(expect.stringContaining("foregroundServiceType"));
  });

  it("rejects a network security config that permits cleartext in release", () => {
    expect(
      failuresAfter((value) => {
        value.networkSecurityConfig +=
          '<domain-config cleartextTrafficPermitted="true"><domain>evil.example</domain></domain-config>';
      }),
    ).toContainEqual(expect.stringContaining("no cleartext domain"));
  });

  it.each(["android.minSdkVersion", "android.compileSdkVersion", "android.targetSdkVersion"])(
    "rejects a wrong %s",
    (key) => {
      expect(
        failuresAfter((value) => {
          value.gradleProperties = value.gradleProperties.replace(
            new RegExp(`${key.replace(/\./g, "\\.")}=\\d+`),
            `${key}=21`,
          );
        }),
      ).toContainEqual(expect.stringContaining(key));
    },
  );
});

describe("summarizeGeneratedNativeSurface", () => {
  it("prints identifiers and booleans without any signing material", () => {
    const summary = summarizeGeneratedNativeSurface(surface(), EXPECTED);
    expect(summary.appId).toBe("org.openmapx.app");
    expect(summary.iosPushEntitlement).toBe(false);
    expect(summary.androidCleartextDenied).toBe(true);
    const serialized = JSON.stringify(summary);
    for (const secret of ["ABCDEFGHIJ", "BEGIN ", "keystore", "p12", "provision"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
