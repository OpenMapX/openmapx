import type { GroundFullSnapshot } from "../navigation/snapshots/groundSnapshot";
import { buildCarTripProjection } from "./CarTripProjection";

const snapshot = {
  status: "active",
  sessionId: "s",
  revision: 3,
  locale: "en",
  units: "metric",
  route: {
    steps: [
      { instruction: "Old", maneuver: { type: "depart" } },
      { instruction: "Turn right", maneuver: { type: "turn", modifier: "right" } },
    ],
  },
  progress: {
    currentStepIndex: 0,
    distanceToNextManeuver: 50,
    distanceRemaining: 500,
    durationRemaining: 60,
  },
  reroute: { status: "in-flight" },
} as unknown as GroundFullSnapshot;
it("projects upcoming maneuver and active rerouting with ETA", () => {
  expect(buildCarTripProjection(snapshot, 1000)).toMatchObject({
    instruction: "Turn right",
    maneuver: "right",
    rerouting: true,
    etaMs: 61000,
    maneuverIcon: "TurnRight",
  });
  // The phone banner's rounding, so the car shows the same distance.
  const projected = buildCarTripProjection(snapshot, 1000);
  expect(projected?.maneuverDistance).toEqual({ value: 50, unit: "m", decimals: 0 });
  expect(projected?.remainingDistanceDisplay).toEqual({ value: 500, unit: "m", decimals: 0 });
});
it("clears terminal state and refuses invalid progress", () => {
  expect(buildCarTripProjection({ ...snapshot, status: "stopped" }, 0)).toBeNull();
  expect(
    buildCarTripProjection({ ...snapshot, progress: { distanceRemaining: NaN } }, 0),
  ).toBeNull();
});
