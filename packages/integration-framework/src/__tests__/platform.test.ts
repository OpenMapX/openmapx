import { describe, expect, it } from "vitest";
import { satisfiesPlatformVersion } from "../platform";

describe("external extension compatibility", () => {
  it.each(["", "garbage", "1", "1.0.0", "1.x", "-1.0", "1.0junk", " 1.0", "1.0 "])(
    "rejects malformed requirements: %j",
    (required) => {
      expect(satisfiesPlatformVersion(required)).toBe(false);
    },
  );
  it("rejects an older incompatible major", () => {
    expect(satisfiesPlatformVersion("0.9")).toBe(false);
  });
  it("accepts same-major earlier requirements and rejects future minors", () => {
    expect(satisfiesPlatformVersion("1.1", "1.3")).toBe(true);
    expect(satisfiesPlatformVersion("1.4", "1.3")).toBe(false);
    expect(satisfiesPlatformVersion("2.0", "1.3")).toBe(false);
  });
});
