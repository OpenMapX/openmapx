import { describe, expect, it } from "vitest";
import { pickRentalActionUrl } from "./DataSourceSections";

const action = {
  label: { $t: "action.openRentalApp" },
  web: "https://example.test/rent",
  ios: "example-ios://rent",
  android: "example-android://rent",
};

const labeled = (values: { web?: string; ios?: string; android?: string }) => ({
  label: action.label,
  ...values,
});

describe("pickRentalActionUrl", () => {
  it("selects the native platform URI with a web fallback", () => {
    expect(pickRentalActionUrl(action, "Mozilla iPhone")).toBe("example-ios://rent");
    expect(pickRentalActionUrl(action, "Mozilla Android")).toBe("example-android://rent");
    expect(pickRentalActionUrl(action, "Mozilla Desktop")).toBe("https://example.test/rent");
  });

  it("falls back safely when a platform URI is absent", () => {
    expect(
      pickRentalActionUrl(labeled({ web: action.web, android: action.android }), "Mozilla iPhone"),
    ).toBe(action.web);
  });

  it("keeps an https web handoff unchanged", () => {
    expect(pickRentalActionUrl(labeled({ web: "https://lime.app/x" }), "Mozilla Desktop")).toBe(
      "https://lime.app/x",
    );
  });

  it("preserves an Android custom-scheme handoff", () => {
    expect(
      pickRentalActionUrl(labeled({ android: "com.limebike://station/1" }), "Mozilla Android"),
    ).toBe("com.limebike://station/1");
  });

  it("preserves an iOS custom-scheme handoff", () => {
    expect(pickRentalActionUrl(labeled({ ios: "lime://station/1" }), "Mozilla iPhone")).toBe(
      "lime://station/1",
    );
  });

  it("rejects a javascript web URI", () => {
    expect(
      pickRentalActionUrl(labeled({ web: "javascript:alert(1)" }), "Mozilla Desktop"),
    ).toBeUndefined();
  });

  it("rejects a javascript URI disguised as an iOS deep link", () => {
    expect(
      pickRentalActionUrl(labeled({ ios: "javascript://x%0aalert(1)" }), "Mozilla iPhone"),
    ).toBeUndefined();
  });

  it("rejects a protocol-relative web URI", () => {
    expect(
      pickRentalActionUrl(labeled({ web: "//evil.example/x" }), "Mozilla Desktop"),
    ).toBeUndefined();
  });

  it("rejects a data URI disguised as an iOS deep link", () => {
    expect(
      pickRentalActionUrl(
        labeled({ ios: "data:text/html,<script>alert(1)</script>" }),
        "Mozilla iPhone",
      ),
    ).toBeUndefined();
  });

  it("rejects intent, market, ftp, and tel schemes", () => {
    for (const uri of [
      "intent://station/1",
      "market://details?id=lime",
      "ftp://station/1",
      "tel://123",
    ]) {
      expect(pickRentalActionUrl(labeled({ ios: uri }), "Mozilla iPhone")).toBeUndefined();
    }
  });

  it("falls back to a safe web URL when the native URI is rejected", () => {
    expect(
      pickRentalActionUrl(
        labeled({ web: "https://ok.example", ios: "javascript:alert(1)" }),
        "Mozilla iPhone",
      ),
    ).toBe("https://ok.example");
  });
});
