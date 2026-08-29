import { describe, expect, it } from "vitest";
import {
  metresToMercatorWorld,
  normalizeTransitBands,
  prepareTransitFieldInstances,
  seedRadiusMetres,
} from "../transit-field";

describe("estimated transit field math", () => {
  it("normalizes up to four discrete bands", () => {
    expect(normalizeTransitBands([60, 15, 30, 15, 90, 45])).toEqual([15, 30, 45, 60]);
  });

  it("caps straight-line egress at fifteen minutes", () => {
    expect(seedRadiusMetres({ arrivalSeconds: 600 }, 1_800)).toBe(1_080);
    expect(seedRadiusMetres({ arrivalSeconds: 0 }, 3_600)).toBe(1_080);
    expect(seedRadiusMetres({ arrivalSeconds: 3_600 }, 3_600)).toBe(0);
  });

  it("adds only seeds with remaining budget", () => {
    const instances = prepareTransitFieldInstances(
      [
        { lng: 13.4, lat: 52.5, arrivalSeconds: 0 },
        { lng: 13.5, lat: 52.6, arrivalSeconds: 1_800 },
      ],
      1_800,
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ remainingSeconds: 1_800, radiusSeconds: 900 });
  });

  it("compensates Mercator metre scale at high latitudes", () => {
    expect(metresToMercatorWorld(1_000, 70)).toBeGreaterThan(metresToMercatorWorld(1_000, 0));
  });
});
