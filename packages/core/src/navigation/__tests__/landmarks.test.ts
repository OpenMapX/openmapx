import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { Route, RouteStep } from "../../types/routing";
import {
  eligibleLandmarkManeuvers,
  type LandmarkCandidate,
  landmarkManeuverAt,
  selectLandmark,
} from "../landmarks";

const ORIGIN: LngLat = [13.4, 52.5];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((52.5 * Math.PI) / 180);

/** A point `east` and `north` metres from the manoeuvre. */
const at = (east: number, north: number): LngLat => [
  ORIGIN[0] + east / M_PER_DEG_LON,
  ORIGIN[1] + north / M_PER_DEG_LAT,
];

const candidate = (
  east: number,
  north: number,
  extra: Partial<LandmarkCandidate> = {},
): LandmarkCandidate => {
  const [lon, lat] = at(east, north);
  return { category: "fuel", lat, lon, ...extra };
};

// Heading north, turning right (east).
const rightTurn = { stepIndex: 3, point: ORIGIN, bearingIn: 0, bearingOut: 90, modifier: "right" };

describe("selectLandmark", () => {
  it("picks the fuel station on the turn side", () => {
    expect(selectLandmark(rightTurn, [candidate(15, -10, { brand: "Aral" })])).toEqual({
      stepIndex: 3,
      category: "fuel",
      brand: "Aral",
    });
    // The far corner on the right side, past the junction, also counts.
    expect(selectLandmark(rightTurn, [candidate(12, 15)])).toEqual({
      stepIndex: 3,
      category: "fuel",
    });
  });

  it("rejects a candidate on the far corner", () => {
    expect(selectLandmark(rightTurn, [candidate(-15, 10)])).toBeNull();
    expect(selectLandmark(rightTurn, [candidate(-15, -10)])).toBeNull();
  });

  it("rejects a candidate further than 30 m", () => {
    expect(selectLandmark(rightTurn, [candidate(28, -14)])).toBeNull();
  });

  it("measures an outline to its nearest edge", () => {
    // A church whose centre is 45 m away but whose wall runs 12 m from the corner.
    const church = candidate(45, -20, {
      category: "place_of_worship",
      religion: "christian",
      outline: [at(12, -5), at(12, -40), at(80, -40), at(80, -5), at(12, -5)],
    });
    expect(selectLandmark(rightTurn, [church])).toEqual({ stepIndex: 3, category: "church" });
  });

  it("slight turns accept either corner within 20 m", () => {
    const slight = { ...rightTurn, bearingOut: 30, modifier: "slight right" };
    expect(selectLandmark(slight, [candidate(-12, 8)])).toEqual({ stepIndex: 3, category: "fuel" });
    expect(selectLandmark(slight, [candidate(-18, 12)])).toBeNull();
  });

  it("two pharmacies within 150 m give none", () => {
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { category: "pharmacy" }),
        candidate(-90, 60, { category: "pharmacy" }),
      ]),
    ).toBeNull();
    // A second one beyond 150 m does not matter.
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { category: "pharmacy" }),
        candidate(140, 90, { category: "pharmacy" }),
      ]),
    ).toEqual({ stepIndex: 3, category: "pharmacy" });
  });

  it("treats a station mapped as both node and area as one", () => {
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { brand: "Shell" }),
        candidate(25, -18, { brand: "Shell" }),
      ]),
    ).toEqual({ stepIndex: 3, category: "fuel", brand: "Shell" });
  });

  it("a church and a mosque are different categories", () => {
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { category: "place_of_worship", religion: "muslim" }),
        candidate(-60, 40, { category: "place_of_worship", religion: "christian" }),
      ]),
    ).toEqual({ stepIndex: 3, category: "mosque" });
  });

  it("prefers the nearest qualifying landmark", () => {
    expect(
      selectLandmark(rightTurn, [
        candidate(20, -15, { category: "supermarket" }),
        candidate(8, -6, { category: "pharmacy" }),
      ]),
    ).toEqual({ stepIndex: 3, category: "pharmacy" });
  });

  it("never uses the name", () => {
    const named = { ...candidate(15, -10), name: "Tankstelle am Ring" } as LandmarkCandidate;
    const reference = selectLandmark(rightTurn, [named]);
    expect(reference).toEqual({ stepIndex: 3, category: "fuel" });
    expect(JSON.stringify(reference)).not.toContain("Ring");
  });

  it("drops a brand over 40 characters", () => {
    expect(selectLandmark(rightTurn, [candidate(15, -10, { brand: "x".repeat(41) })])).toEqual({
      stepIndex: 3,
      category: "fuel",
    });
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { category: "fast_food", brand: "x".repeat(41) }),
      ]),
    ).toBeNull();
  });

  it("speaks no brand for a pharmacy or church", () => {
    expect(
      selectLandmark(rightTurn, [candidate(15, -10, { category: "pharmacy", brand: "DocMorris" })]),
    ).toEqual({ stepIndex: 3, category: "pharmacy" });
  });

  it("skips places of worship of other religions", () => {
    expect(
      selectLandmark(rightTurn, [
        candidate(15, -10, { category: "place_of_worship", religion: "buddhist" }),
      ]),
    ).toBeNull();
  });
});

const step = (coordinates: LngLat[], extra: Partial<RouteStep> = {}): RouteStep =>
  ({
    instruction: "",
    distance: 500,
    duration: 50,
    coordinates,
    maneuver: { type: "turn", modifier: "right" },
    ...extra,
  }) as RouteStep;

describe("eligibleLandmarkManeuvers", () => {
  // A straight line north, one step per km from the origin.
  const line: LngLat[] = [0, 1, 2, 3, 4].map((km) => at(0, km * 1000));
  const route = (steps: RouteStep[]): Route =>
    ({ geometry: line, steps, distance: 4000, duration: 400 }) as unknown as Route;

  it("skips manoeuvres near origin and destination", () => {
    const steps = [
      step([at(0, 0)], { maneuver: { type: "depart" } }),
      step([at(0, 250)]),
      step([at(0, 1000)]),
      step([at(0, 3000)], { maneuver: { type: "turn", modifier: "slight left" } }),
      step([at(0, 3800)]),
      step([at(0, 4000)], { maneuver: { type: "arrive" } }),
    ];
    expect(eligibleLandmarkManeuvers(route(steps))).toEqual([2, 3]);
  });

  it("takes turn manoeuvres off the motorway only", () => {
    const steps = [
      step([at(0, 0)], { maneuver: { type: "depart" } }),
      step([at(0, 1000)], { maneuver: { type: "continue", modifier: "straight" } }),
      step([at(0, 1500)], { maneuver: { type: "uturn", modifier: "left" } }),
      step([at(0, 2000)], { motorway: true }),
      step([at(0, 2500)]),
      step([at(0, 3000)]),
      step([at(0, 4000)], { maneuver: { type: "arrive" } }),
    ];
    // Step 4 follows a motorway step; step 5 is the first town turn after it.
    expect(eligibleLandmarkManeuvers(route(steps))).toEqual([5]);
  });

  it("gives none for a route without geometry", () => {
    expect(eligibleLandmarkManeuvers({ ...route([]), geometry: [] } as Route)).toEqual([]);
  });
});

describe("landmarkManeuverAt", () => {
  const routeOf = (steps: RouteStep[]) =>
    ({ geometry: [], steps, distance: 0, duration: 0 }) as unknown as Route;

  it("uses the engine's bearings when it sends them", () => {
    const steps = [
      step([at(0, 0), at(0, 400)], { maneuver: { type: "depart" } }),
      step([at(0, 400), at(300, 400)], { bearingBefore: 2, bearingAfter: 88 }),
    ];
    expect(landmarkManeuverAt(routeOf(steps), 1)).toEqual({
      stepIndex: 1,
      point: at(0, 400),
      bearingIn: 2,
      bearingOut: 88,
      modifier: "right",
    });
  });

  it("derives bearings from the step geometry otherwise", () => {
    const steps = [
      step([at(0, 0), at(0, 400)], { maneuver: { type: "depart" } }),
      step([at(0, 400), at(300, 400)]),
    ];
    const maneuver = landmarkManeuverAt(routeOf(steps), 1);
    expect(maneuver?.bearingIn).toBeCloseTo(0, 0);
    expect(maneuver?.bearingOut).toBeCloseTo(90, 0);
  });

  it("gives none without a modifier or geometry", () => {
    const steps = [
      step([at(0, 0)], { maneuver: { type: "depart" } }),
      step([at(0, 400)], { maneuver: { type: "turn" } }),
      step([at(0, 800)]),
    ];
    expect(landmarkManeuverAt(routeOf(steps), 1)).toBeNull();
    expect(landmarkManeuverAt(routeOf(steps), 2)).toBeNull();
    expect(landmarkManeuverAt(routeOf(steps), 9)).toBeNull();
  });
});
