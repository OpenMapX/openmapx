import { describe, expect, it } from "vitest";
import { pickRentalActionUrl } from "./DataSourceSections";

const action = {
  label: { $t: "action.openRentalApp" },
  web: "https://example.test/rent",
  ios: "example-ios://rent",
  android: "example-android://rent",
};

describe("pickRentalActionUrl", () => {
  it("selects the native platform URI with a web fallback", () => {
    expect(pickRentalActionUrl(action, "Mozilla iPhone")).toBe("example-ios://rent");
    expect(pickRentalActionUrl(action, "Mozilla Android")).toBe("example-android://rent");
    expect(pickRentalActionUrl(action, "Mozilla Desktop")).toBe("https://example.test/rent");
  });

  it("falls back safely when a platform URI is absent", () => {
    expect(
      pickRentalActionUrl(
        { label: action.label, web: action.web, android: action.android },
        "Mozilla iPhone",
      ),
    ).toBe(action.web);
  });
});
