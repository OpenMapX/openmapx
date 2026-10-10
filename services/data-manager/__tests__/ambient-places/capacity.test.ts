import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAmbientDiskCapacity,
  assertPlanetDiskCapacity,
  planetPlaceLimit,
} from "../../src/jobs/ambient-places/capacity.js";

const gib = 1024 ** 3;
afterEach(() => vi.unstubAllEnvs());
describe("planet publication configuration", () => {
  it.each(["", " \t "])("uses safe defaults for blank optional settings %j", (value) => {
    vi.stubEnv("AMBIENT_PLANET_MAX_PLACES", value);
    vi.stubEnv("AMBIENT_PLANET_RESERVE_BYTES", value);
    expect(planetPlaceLimit()).toBe(250_000_000);
    expect(() => assertPlanetDiskCapacity(21 * gib, 0)).not.toThrow();
    expect(() => assertPlanetDiskCapacity(21 * gib - 1, 0)).toThrow(/disk/i);
  });
  it.each(["0", "-1", "NaN", "1.5", "9007199254740992"])(
    "refuses an invalid explicit planet limit or reserve %j",
    (value) => {
      vi.stubEnv("AMBIENT_PLANET_MAX_PLACES", value);
      expect(() => planetPlaceLimit()).toThrow(/positive integer/);
      vi.stubEnv("AMBIENT_PLANET_RESERVE_BYTES", value);
      expect(() => assertPlanetDiskCapacity(21 * gib, 0)).toThrow(/positive integer/);
    },
  );
});
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
