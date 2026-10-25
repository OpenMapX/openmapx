import { describe, expect, it } from "vitest";
import { diffFeedFiles, transitousPinIsCurrent } from "../src/commands/transitous-bump.js";

const TRANSITOUS = {
  ref: `main@${"a".repeat(40)}`,
  submodules: { "transitland-atlas": "b".repeat(40) },
  lockedAt: "2026-07-15T00:00:00.000Z",
  lockedBy: "test",
};

describe("Transitous catalog bump", () => {
  it("detects a no-op only when the Transitous pin matches", () => {
    expect(transitousPinIsCurrent(TRANSITOUS, "a".repeat(40))).toBe(true);
    expect(transitousPinIsCurrent(TRANSITOUS, "f".repeat(40))).toBe(false);
    expect(transitousPinIsCurrent(null, "a".repeat(40))).toBe(false);
  });

  it("reports removed feeds and license changes for compatibility review", () => {
    const summary = diffFeedFiles(
      new Map([
        [
          "de",
          {
            sources: [
              { name: "BVG", license: { "spdx-identifier": "CC-BY-4.0" } },
              { name: "Removed" },
            ],
          },
        ],
      ]),
      new Map([["de", { sources: [{ name: "BVG", license: { "spdx-identifier": "ODbL-1.0" } }] }]]),
    );
    expect(summary.removedSources).toBe(1);
    expect(summary.licenseChanges).toEqual([{ region: "de", source: "BVG" }]);
  });
});
