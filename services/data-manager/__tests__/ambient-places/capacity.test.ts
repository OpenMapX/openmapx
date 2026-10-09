import { describe, expect, it } from "vitest";
import { assertAmbientDiskCapacity } from "../../src/jobs/ambient-places/capacity.js";

const gib = 1024 ** 3;
describe("Germany publication disk admission", () => {
  it("reserves working space as well as free-space headroom before starting", () => {
    expect(() => assertAmbientDiskCapacity(6 * gib, 1)).not.toThrow();
    expect(() => assertAmbientDiskCapacity(6 * gib - 1, 1)).toThrow(/disk/i);
    expect(() => assertAmbientDiskCapacity(7 * gib, 2_000_000)).toThrow(/disk/i);
    expect(() => assertAmbientDiskCapacity(5 * gib + 2_000_000 * 2048, 2_000_000)).not.toThrow();
  });
  it("stops a running build when its safety reserve is depleted", () => {
    expect(() => assertAmbientDiskCapacity(5 * gib)).not.toThrow();
    expect(() => assertAmbientDiskCapacity(5 * gib - 1)).toThrow(/disk/i);
    for (const bytes of [NaN, Infinity, -1]) {
      expect(() => assertAmbientDiskCapacity(bytes)).toThrow();
    }
    expect(() => assertAmbientDiskCapacity(8 * gib, -1)).toThrow();
  });
});
