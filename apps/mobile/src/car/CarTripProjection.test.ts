import {
  type GroundFullSnapshot,
  type RoundaboutTurn,
  roundaboutGlyph,
  roundaboutTurnAt,
} from "@openmapx/core/navigation";
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
    rerouting: true,
    etaMs: 61000,
    maneuverIcon: "TurnRight",
  });
  // The phone banner's rounding, so the car shows the same distance.
  const projected = buildCarTripProjection(snapshot, 1000);
  expect(projected?.maneuverDistance).toEqual({ value: 50, unit: "m", decimals: 0 });
  expect(projected?.remainingDistanceDisplay).toEqual({ value: 500, unit: "m", decimals: 0 });
});
it("the car card shows the narrowed lanes", () => {
  const closeTurns = {
    ...snapshot,
    route: {
      steps: [
        { instruction: "Drive on", maneuver: { type: "depart" }, distance: 800 },
        {
          instruction: "Continue",
          maneuver: { type: "continue" },
          distance: 120,
          lanes: [
            { indications: ["through"], valid: true },
            { indications: ["through"], valid: true },
            { indications: ["through"], valid: true },
          ],
        },
        {
          instruction: "Turn right",
          maneuver: { type: "turn", modifier: "right" },
          distance: 300,
          lanes: [
            { indications: ["through"], valid: false },
            { indications: ["through"], valid: false },
            { indications: ["right"], valid: true, preferred: true, active: "right" },
          ],
        },
      ],
    },
  } as unknown as GroundFullSnapshot;
  const lanes = buildCarTripProjection(closeTurns, 1000)?.lanes;
  expect(lanes?.map((cell) => cell.valid)).toEqual([true, true, true]);
  expect(lanes?.map((cell) => cell.arrows.some((arrow) => arrow.active))).toEqual([
    false,
    false,
    true,
  ]);
});
it("clears terminal state and refuses invalid progress", () => {
  expect(buildCarTripProjection({ ...snapshot, status: "stopped" }, 0)).toBeNull();
  expect(
    buildCarTripProjection({ ...snapshot, progress: { distanceRemaining: NaN } }, 0),
  ).toBeNull();
});

const STEP_COUNT = 4_000;
const CURRENT = 2_000;
function longRoute(): Record<string, unknown>[] {
  return Array.from({ length: STEP_COUNT }, (_, index) => ({
    instruction: `Step ${index}`,
    distance: 100,
    duration: 10,
    maneuver: { type: "turn", modifier: "left" },
  }));
}
function withSteps(steps: unknown, currentStepIndex = CURRENT): GroundFullSnapshot {
  return {
    ...snapshot,
    route: { steps, distance: 400_000, duration: 40_000 },
    progress: {
      currentStepIndex,
      distanceToNextManeuver: 50,
      distanceRemaining: 200_000,
      durationRemaining: 20_000,
    },
  } as unknown as GroundFullSnapshot;
}

it("projects the upcoming and current steps of a long route", () => {
  const steps = longRoute();
  steps[CURRENT] = { instruction: "Driving", distance: 200, duration: 30 };
  steps[CURRENT + 1] = {
    instruction: "Take the 3rd exit",
    drivingSide: "left",
    roundaboutExitCount: 3,
    maneuver: { type: "roundabout", modifier: "right" },
  };
  expect(buildCarTripProjection(withSteps(steps), 1000)).toEqual({
    sessionId: "s",
    revision: 3,
    maneuverId: `s:${CURRENT + 1}`,
    instruction: "Take the 3rd exit",
    maneuverIcon: expect.any(String),
    roundabout: { exit: 3, clockwise: true },
    distanceToManeuver: 50,
    maneuverDistance: { value: 50, unit: "m", decimals: 0 },
    remainingDistanceDisplay: { value: 200, unit: "km", decimals: 0 },
    // 50 m of the current 200 m step at 30 s.
    secondsToManeuver: 7.5,
    maneuverEtaMs: 8500,
    remainingDistance: 200_000,
    remainingSeconds: 20_000,
    etaMs: 20_001_000,
    rerouting: true,
    locale: "en",
    units: "metric",
  });
});

it("ignores a malformed step that the projection does not read", () => {
  const clean = buildCarTripProjection(withSteps(longRoute()), 1000);
  const steps = longRoute();
  steps[10] = { distance: -1, maneuver: "not an object" };
  steps[STEP_COUNT - 1] = null as unknown as Record<string, unknown>;
  expect(clean).not.toBeNull();
  expect(buildCarTripProjection(withSteps(steps), 1000)).toEqual(clean);
});

it("refuses a malformed upcoming or current step", () => {
  const badUpcoming = longRoute();
  badUpcoming[CURRENT + 1] = { instruction: 42 };
  expect(buildCarTripProjection(withSteps(badUpcoming), 1000)).toBeNull();
  const badCurrent = longRoute();
  badCurrent[CURRENT] = { distance: Number.POSITIVE_INFINITY };
  expect(buildCarTripProjection(withSteps(badCurrent), 1000)).toBeNull();
  // On the last step both reads are the same index.
  const badLast = longRoute();
  badLast[STEP_COUNT - 1] = { lanes: "none" };
  expect(buildCarTripProjection(withSteps(badLast, STEP_COUNT - 1), 1000)).toBeNull();
});

it("refuses a route whose steps are not an array", () => {
  for (const steps of [undefined, null, "steps", { 0: { instruction: "x" }, length: 1 }]) {
    expect(buildCarTripProjection(withSteps(steps), 1000)).toBeNull();
  }
});

it("never touches the steps it does not read", () => {
  const steps: unknown[] = longRoute();
  let touched = 0;
  for (let index = 0; index < STEP_COUNT; index++) {
    if (index === CURRENT || index === CURRENT + 1) continue;
    Object.defineProperty(steps, index, {
      get() {
        touched++;
        throw new Error(`step ${index} was read`);
      },
    });
  }
  expect(buildCarTripProjection(withSteps(steps), 1000)).toMatchObject({
    instruction: `Step ${CURRENT + 1}`,
    maneuverId: `s:${CURRENT + 1}`,
  });
  expect(touched).toBe(0);
});

// Strausberger Platz, Berlin: in from Alexanderstraße, out at the 2nd exit,
// as Valhalla returns it (no driving side, enter and exit as two steps).
const strausberger = [
  {
    instruction: "Turn right onto Alexanderstraße",
    distance: 200,
    duration: 30,
    maneuver: { type: "turn", modifier: "right" },
    coordinates: [
      [13.427501, 52.5185],
      [13.427641, 52.518406],
    ],
  },
  {
    instruction: "Enter Strausberger Platz and take the 2nd exit",
    distance: 74,
    duration: 11,
    roundaboutExitCount: 2,
    maneuver: { type: "roundabout" },
    bearingBefore: 137,
    bearingAfter: 146,
    coordinates: [
      [13.427641, 52.518406],
      [13.427859, 52.518257],
      [13.428045, 52.518177],
      [13.428345, 52.518135],
      [13.428592, 52.518146],
    ],
  },
  {
    instruction: "Exit the roundabout",
    distance: 400,
    duration: 30,
    maneuver: { type: "exit roundabout" },
    bearingBefore: 73,
    bearingAfter: 78,
    coordinates: [
      [13.428592, 52.518146],
      [13.429106, 52.518204],
    ],
  },
  { instruction: "Arrive", distance: 0, duration: 0, maneuver: { type: "arrive" } },
];

it("tells the car how far round a counter-clockwise roundabout the exit lies", () => {
  const projection = buildCarTripProjection(withSteps(strausberger, 0), 1000);
  const turn = roundaboutTurnAt(strausberger as never, 1) as RoundaboutTurn;
  expect(turn.circulation).toBe("ccw");
  expect(projection?.roundabout).toEqual({ exit: 2, clockwise: false, angle: 239 });
  // The car draws the phone's glyph, not a drawable that circles the wrong way.
  expect(projection?.maneuverGlyph).toEqual(roundaboutGlyph(turn));
});

it("names the roundabout's exit step as leaving it", () => {
  const projection = buildCarTripProjection(withSteps(strausberger, 1), 1000);
  expect(projection?.roundabout).toEqual({ exit: 2, clockwise: false, angle: 239, leaving: true });
  expect(projection?.maneuverGlyph).toEqual(
    roundaboutGlyph(roundaboutTurnAt(strausberger as never, 1) as RoundaboutTurn),
  );
});
