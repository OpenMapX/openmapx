import { describe, expect, it } from "vitest";
import { formatStreetLevelRef, parseStreetLevelRef } from "./streetLevelRef";

describe("streetLevelRef", () => {
  it("formats a ref as provider:image", () => {
    expect(formatStreetLevelRef({ providerId: "panoramax", imageId: "abc-123" })).toBe(
      "panoramax:abc-123",
    );
  });

  it("parses a qualified ref", () => {
    expect(parseStreetLevelRef("panoramax:abc-123")).toEqual({
      providerId: "panoramax",
      imageId: "abc-123",
    });
  });

  it("keeps colons inside the image id", () => {
    expect(parseStreetLevelRef("panoramax:a:b:c")).toEqual({
      providerId: "panoramax",
      imageId: "a:b:c",
    });
  });

  it("treats a bare id as the fallback provider (legacy ?sv= links)", () => {
    expect(parseStreetLevelRef("1234567890", "mapillary")).toEqual({
      providerId: "mapillary",
      imageId: "1234567890",
    });
  });

  it("returns null for a bare id with no fallback", () => {
    expect(parseStreetLevelRef("1234567890")).toBeNull();
  });

  it("returns null for empty or malformed input", () => {
    expect(parseStreetLevelRef("")).toBeNull();
    expect(parseStreetLevelRef(":abc")).toBeNull();
    expect(parseStreetLevelRef("panoramax:")).toBeNull();
  });

  it("round-trips", () => {
    const ref = { providerId: "mapillary", imageId: "999" };
    expect(parseStreetLevelRef(formatStreetLevelRef(ref))).toEqual(ref);
  });
});
