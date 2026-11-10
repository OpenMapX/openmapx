import { supportsVerifiedAuthCallback } from "./verifiedCallbackSupport";

describe("supportsVerifiedAuthCallback", () => {
  it.each([
    ["android", 24, true],
    ["android", 36, true],
    ["ios", "17.4", true],
    ["ios", "17.4.1", true],
    ["ios", "18.0", true],
    ["ios", "26.1", true],
    ["ios", "17.3.1", false],
    ["ios", "16.4", false],
    ["ios", "not-a-version", false],
    ["web", "1", false],
  ])("%s %s → %s", (os, version, supported) => {
    expect(supportsVerifiedAuthCallback(os, version)).toBe(supported);
  });
});
