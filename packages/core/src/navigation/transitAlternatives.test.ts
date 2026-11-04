import { expect, it } from "vitest";
import { transitAlternativeOrigin } from "./transitAlternatives";

it("uses a future alight time for onboard alternatives instead of GPS on a moving vehicle", () => {
  const result = transitAlternativeOrigin(
    {
      phase: "riding",
      currentLegIndex: 0,
      snapped: [0, 0],
      fractionAlongLeg: 0,
      deviationMeters: 0,
      arrived: false,
      position: [1, 1],
      positionTimestampMs: 1000,
    },
    {
      legs: [{ to: { name: "Station", lng: 8, lat: 50 }, endTime: new Date(100000).toISOString() }],
    } as never,
    50000,
  );
  expect(result).toEqual({
    origin: [8, 50],
    time: new Date(100000).toISOString(),
    preview: true,
    name: "Station",
  });
});
it("cannot plan from stale or absent actual location off vehicle", () => {
  expect(transitAlternativeOrigin(null, { legs: [] } as never, 100000)).toBeNull();
  expect(
    transitAlternativeOrigin(
      {
        phase: "walking",
        currentLegIndex: 0,
        snapped: [0, 0],
        fractionAlongLeg: 0,
        deviationMeters: 0,
        arrived: false,
        position: [1, 1],
        positionTimestampMs: 1,
      },
      { legs: [] } as never,
      100000,
    ),
  ).toBeNull();
});
