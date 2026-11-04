import { describe, expect, it } from "vitest";
import { widgetBuildSettings, widgetInfoPlist } from "./withNavigationSurfaces";

describe("navigation widget generated target", () => {
  it("derives identity and versions from the host and does not add an entitlement", () => {
    const s = widgetBuildSettings(
      { CURRENT_PROJECT_VERSION: "42", MARKETING_VERSION: "2.0", DEVELOPMENT_TEAM: "ABCDEFGHIJ" },
      "net.example.maps",
    );
    expect(s.PRODUCT_BUNDLE_IDENTIFIER).toBe('"net.example.maps.NavigationSurface"');
    expect(s.CURRENT_PROJECT_VERSION).toBe("42");
    expect(s.MARKETING_VERSION).toBe("2.0");
    expect(s.DEVELOPMENT_TEAM).toBe("ABCDEFGHIJ");
    expect(s.APPLICATION_EXTENSION_API_ONLY).toBe("YES");
    expect(s).not.toHaveProperty("CODE_SIGN_ENTITLEMENTS");
    expect(widgetInfoPlist()).toContain("com.apple.widgetkit-extension");
  });
});
