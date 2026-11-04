import { describe, expect, it } from "vitest";
import {
  intakeAndroidFilters,
  intakeDocumentTypes,
  intakeImportedTypes,
  intakeShareInfo,
  shareBuildSettings,
} from "./withNativeIntake";

describe("native intake CNG", () => {
  it("restricts geographic document types without exposing the container", () => {
    expect(intakeDocumentTypes()[0].LSItemContentTypes).toEqual([
      "com.topografix.gpx",
      "public.geojson",
      "com.google.earth.kml",
    ]);
    expect(intakeImportedTypes().map((t) => t.UTTypeIdentifier)).toContain("public.geojson");
    const info = intakeShareInfo("net.example.maps");
    expect(info.OpenMapXIntakeAppGroup).toBe("group.net.example.maps.intake");
    const rule = info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule;
    expect(rule).toContain("SUBQUERY");
    expect(rule).toContain("public.file-url");
    expect(rule).not.toContain("TRUEPREDICATE");
  });
  it("derives extension identity and versions and limits entitlements", () => {
    const settings = shareBuildSettings(
      { CURRENT_PROJECT_VERSION: "42", MARKETING_VERSION: "2.0", DEVELOPMENT_TEAM: "ABCDEFGHIJ" },
      "net.example.maps",
    );
    expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('"net.example.maps.ShareExtension"');
    expect(settings.CODE_SIGN_ENTITLEMENTS).toBe(
      '"OpenMapXShareExtension/ShareExtension.entitlements"',
    );
    expect(settings.CURRENT_PROJECT_VERSION).toBe("42");
    expect(settings.MARKETING_VERSION).toBe("2.0");
    expect(settings.DEVELOPMENT_TEAM).toBe("ABCDEFGHIJ");
    expect(settings.APPLICATION_EXTENSION_API_ONLY).toBe("YES");
    expect(settings).not.toHaveProperty("SWIFT_OPTIMIZATION_LEVEL");
  });
  it("registers only typed intents, content VIEW is not browsable", () => {
    const filters = intakeAndroidFilters();
    expect(
      filters
        .filter((f) => f.action === "VIEW")
        .every(
          (f) => f.category.join() === "DEFAULT" && f.data.every((d) => d.scheme === "content"),
        ),
    ).toBe(true);
    expect(JSON.stringify(filters)).not.toContain('"*/*"');
    expect(filters.map((f) => f.action)).toContain("SEND_MULTIPLE");
  });
});
