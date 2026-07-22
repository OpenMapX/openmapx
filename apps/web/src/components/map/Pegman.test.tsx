import { describe, expect, it } from "vitest";
import { nearestFeature } from "./Pegman";

describe("nearestFeature", () => {
  const features = [
    { id: "far", providerId: "panoramax", screenX: 100, screenY: 100 },
    { id: "near", providerId: "mapillary", screenX: 12, screenY: 12 },
  ];

  it("picks the closest candidate across providers", () => {
    expect(nearestFeature(features, 10, 10)?.id).toBe("near");
  });

  it("preserves the owning provider", () => {
    expect(nearestFeature(features, 10, 10)?.providerId).toBe("mapillary");
  });

  it("returns null when there are no candidates", () => {
    expect(nearestFeature([], 10, 10)).toBeNull();
  });
});
