import { describe, expect, it } from "vitest";
import { PLATFORM_VERSION, satisfiesWebPlatformVersion, WEB_PLATFORM_VERSION } from "./platform";

describe("protocol versions", () => {
  it("publishes version 1.0 of both protocols", () => {
    expect(PLATFORM_VERSION).toBe("1.0");
    expect(WEB_PLATFORM_VERSION).toBe("1.0");
  });
  it("accepts a web requirement of the same major and an equal or lower minor", () => {
    expect(satisfiesWebPlatformVersion("1.0", "1.3")).toBe(true);
    expect(satisfiesWebPlatformVersion("1.4", "1.3")).toBe(false);
    expect(satisfiesWebPlatformVersion("2.0", "1.3")).toBe(false);
    expect(satisfiesWebPlatformVersion("1")).toBe(false);
  });
});
