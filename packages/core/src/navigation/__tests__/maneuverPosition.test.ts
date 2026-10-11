import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";
import { prepareManeuverPositions } from "../maneuverPosition";

describe("prepareManeuverPositions transport fallback", () => {
  it("retains engine boundaries for a mobile route with omitted step shapes", () => {
    const route = {
      distance: 1000,
      geometry: [
        [0, 0],
        [0, 0.009],
      ],
      steps: [{ distance: 400 }, { distance: 600 }],
    } as unknown as Route;
    expect(prepareManeuverPositions(route)).toEqual({
      starts: [0, 400],
      ends: [400, 1000],
      total: 1000,
      metric: "engine-fallback",
    });
  });

  it("recovers a physical boundary after a step with no transported shape", () => {
    const route = {
      distance: 1200,
      geometry: [
        [0, 0],
        [0, 0.004],
        [0, 0.009],
      ],
      steps: [
        { distance: 600 },
        {
          distance: 600,
          coordinates: [
            [0, 0.004],
            [0, 0.009],
          ],
        },
      ],
    } as unknown as Route;
    const positions = prepareManeuverPositions(route);
    expect(positions.metric).toBe("geometry");
    expect(positions.starts[0]).toBe(0);
    expect(positions.starts[1]).toBeCloseTo(444.78, 1);
  });
});
