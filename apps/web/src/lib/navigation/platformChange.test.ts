import { describe, expect, it } from "vitest";
import { changedFromPlatform } from "./platformChange";

describe("changedFromPlatform", () => {
  it("returns the scheduled platform when it differs from the realtime one", () => {
    expect(changedFromPlatform({ platformCode: "3", scheduledPlatformCode: "5" })).toBe("5");
  });

  it("returns undefined when the platform is unchanged", () => {
    expect(changedFromPlatform({ platformCode: "5", scheduledPlatformCode: "5" })).toBeUndefined();
  });

  it("returns undefined when either side is missing", () => {
    expect(changedFromPlatform({ platformCode: "5" })).toBeUndefined();
    expect(changedFromPlatform({ scheduledPlatformCode: "5" })).toBeUndefined();
  });
});
