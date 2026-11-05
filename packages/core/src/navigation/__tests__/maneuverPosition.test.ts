import { describe, expect, it } from "vitest";
import type { Route } from "../../types/routing";
import { prepareManeuverPositions } from "../maneuverPosition";
import { computeProgress } from "../progress";
import { advanceStepGate } from "../stepGate";

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

  it("keeps both known boundaries around an omitted middle shape despite provider-distance drift", () => {
    const route = {
      distance: 1800,
      duration: 180,
      geometry: [
        [0, 0],
        [0, 0.001],
        [0, 0.002],
        [0, 0.009],
      ],
      steps: [
        {
          distance: 600,
          duration: 60,
          coordinates: [
            [0, 0],
            [0, 0.001],
          ],
        },
        { distance: 600, duration: 60, coordinates: [] },
        {
          distance: 600,
          duration: 60,
          coordinates: [
            [0, 0.002],
            [0, 0.009],
          ],
        },
      ],
    } as unknown as Route;
    const positions = prepareManeuverPositions(route);
    expect(positions.starts[0]).toBe(0);
    expect(positions.starts[1]).toBeCloseTo(111.195, 2);
    expect(positions.starts[2]).toBeCloseTo(222.39, 2);
    const progress = computeProgress(route, 250);
    expect(progress.currentStepIndex).toBe(2);
    expect(progress.distanceToNextManeuver).toBeCloseTo(750.754, 2);
    expect(progress.distanceRemaining).toBeCloseTo(578.717, 2);
    expect(progress.durationRemaining).toBeCloseTo(57.872, 2);
    expect(
      advanceStepGate(route, 250, { committedStepIndex: 0, reachedStepEnd: false }, 15, 15),
    ).toEqual({ committedStepIndex: 2, reachedStepEnd: false });
  });

  it("distributes multiple missing boundaries between confirmed endpoints using relative provider distances", () => {
    const route = {
      distance: 2800,
      geometry: [
        [0, 0],
        [0, 0.001],
        [0, 0.004],
        [0, 0.009],
      ],
      steps: [
        {
          distance: 600,
          coordinates: [
            [0, 0],
            [0, 0.001],
          ],
        },
        { distance: 400, coordinates: [] },
        { distance: 1200, coordinates: [] },
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
    expect(positions.starts[1]).toBeCloseTo(111.195, 2);
    expect(positions.starts[2]).toBeCloseTo(194.591, 2);
    expect(positions.starts[3]).toBeCloseTo(444.78, 2);
  });

  it("bounds trailing missing shapes by the remaining physical route length", () => {
    const route = {
      distance: 2600,
      geometry: [
        [0, 0],
        [0, 0.001],
        [0, 0.009],
      ],
      steps: [
        {
          distance: 600,
          coordinates: [
            [0, 0],
            [0, 0.001],
          ],
        },
        { distance: 500, coordinates: [] },
        { distance: 1500, coordinates: [] },
      ],
    } as unknown as Route;
    const positions = prepareManeuverPositions(route);
    expect(positions.starts[1]).toBeCloseTo(111.195, 2);
    expect(positions.starts[2]).toBeCloseTo(333.585, 2);
    expect(positions.ends[2]).toBeCloseTo(1000.754, 2);
  });
});
