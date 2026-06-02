import { describe, expect, it } from "vitest";
import { hasCapability } from "./platformCapabilities";

describe("hasCapability", () => {
  it("returns false in a non-DOM environment for hardware features", () => {
    expect(hasCapability("wakeLock")).toBe(
      typeof navigator !== "undefined" && "wakeLock" in navigator,
    );
  });

  it("knows the capability keys", () => {
    expect(() => hasCapability("vibrate")).not.toThrow();
    expect(() => hasCapability("speech")).not.toThrow();
    expect(() => hasCapability("geolocation")).not.toThrow();
    expect(() => hasCapability("deviceOrientation")).not.toThrow();
  });
});
