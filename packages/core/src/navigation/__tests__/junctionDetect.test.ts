import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { Route, RouteStep } from "../../types/routing";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { cumulativeDistances } from "../deadReckon";
import {
  findJunctionCandidates,
  findJunctionDecisionPoints,
  sameJunction,
} from "../junctionDetect";
import { junctionLookupPoints } from "../junctionLookup";

const a57Route = fixture.route as unknown as Route;

const driftRoute: Route = {
  mode: "driving",
  distance: 1920,
  duration: 120,
  legs: [],
  geometry: [
    [0, 0],
    [0.01, 0],
    [0.01, 0.002],
    [0.012, 0.002],
  ],
  steps: [
    {
      instruction: "Drive east",
      distance: 1400,
      duration: 80,
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    },
    {
      instruction: "Drive north",
      distance: 300,
      duration: 20,
      coordinates: [
        [0.01, 0],
        [0.01, 0.002],
      ],
    },
    {
      instruction: "Exit right",
      distance: 220,
      duration: 20,
      coordinates: [
        [0.01, 0.002],
        [0.012, 0.002],
      ],
      maneuver: { type: "fork", modifier: "right" },
    },
  ],
};

describe("junction geometry positions", () => {
  it.each([true, false])(
    "anchors junctions to the maneuver despite distance drift (motorway flag %s)",
    (motorway) => {
      const route = {
        ...driftRoute,
        steps: driftRoute.steps.map((step) => ({ ...step, motorway })),
      };
      const points = motorway ? findJunctionDecisionPoints(route) : findJunctionCandidates(route);
      expect(points).toHaveLength(1);
      expect(points[0].point).toEqual([0.01, 0.002]);
      expect(points[0].alongMeters).toBeCloseTo(1334.339, 2);
      expect(points[0].approachBearing).toBeCloseTo(0, 4);
      expect(points[0].divergenceDeg).toBeCloseTo(90, 2);
      const lookup = junctionLookupPoints(route, points)[0].lookup;
      expect([lookup.lng, lookup.lat]).toEqual([0.01, 0.002]);
      expect(lookup.trace[4]).toEqual([0.01, 0.002]);
      expect(lookup.trace[3][0]).toBeCloseTo(0.01, 6);
      expect(lookup.trace[3][1]).toBeLessThan(0.002);
    },
  );

  it("uses the later occurrence when a step returns to an earlier coordinate", () => {
    const route: Route = {
      ...driftRoute,
      geometry: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
        [0.002, 0],
      ],
      steps: [
        {
          instruction: "Drive around the block",
          distance: 4000,
          duration: 100,
          coordinates: [
            [0, 0],
            [0.01, 0],
            [0.01, 0.01],
            [0, 0.01],
            [0, 0],
          ],
          motorway: true,
        },
        {
          instruction: "Exit right",
          distance: 220,
          duration: 20,
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
          maneuver: { type: "fork", modifier: "right" },
        },
      ],
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.point).toEqual([0, 0]);
    expect(point.alongMeters).toBeCloseTo(4447.797, 2);
    expect(point.approachBearing).toBeCloseTo(180, 4);
  });

  it("retains the distance fallback when a maneuver has no coordinates", () => {
    const route = {
      ...driftRoute,
      steps: driftRoute.steps.map((step) => ({ ...step, coordinates: [], motorway: true })),
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.alongMeters).toBe(1700);
    expect(point.point).toEqual([0.012, 0.002]);
  });

  it("projects a maneuver omitted from the route's geometry vertices", () => {
    const route: Route = {
      ...driftRoute,
      steps: [
        { ...driftRoute.steps[0], motorway: true },
        {
          ...driftRoute.steps[2],
          coordinates: [
            [0.01, 0.001],
            [0.01, 0.002],
          ],
        },
      ],
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.point[0]).toBeCloseTo(0.01, 6);
    expect(point.point[1]).toBeCloseTo(0.001, 6);
    expect(point.alongMeters).toBeCloseTo(1223.144, 2);
    expect(point.approachBearing).toBeCloseTo(0, 4);
  });

  it.each([0, 0.00002])(
    "keeps an omitted first visit before the same coordinate's later vertex (deviation %s)",
    (deviation) => {
      const route: Route = {
        ...driftRoute,
        geometry: [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0.005, 0.01],
          [0.005, deviation],
          [0.006, -0.001],
        ],
        steps: [
          {
            instruction: "Drive east",
            distance: 600,
            duration: 20,
            motorway: true,
            coordinates: [
              [0, 0],
              [0.005, deviation],
            ],
          },
          {
            instruction: "Fork around the block",
            distance: 3400,
            duration: 100,
            motorway: true,
            coordinates: [
              [0.005, deviation],
              [0.01, 0],
              [0.01, 0.01],
              [0.005, 0.01],
              [0.005, deviation],
            ],
            maneuver: { type: "fork", modifier: "right" },
          },
          {
            instruction: "Exit right",
            distance: 150,
            duration: 20,
            coordinates: [
              [0.005, deviation],
              [0.006, -0.001],
            ],
            maneuver: { type: "fork", modifier: "right" },
          },
        ],
      };
      const points = findJunctionDecisionPoints(route);
      expect(points).toHaveLength(2);
      expect(points[0].point).toEqual([0.005, deviation]);
      expect(points[1].point).toEqual([0.005, deviation]);
      expect(points[0].alongMeters).toBeCloseTo(555.975, 2);
      expect(points[0].approachBearing).toBeCloseTo(90, 4);
      expect(points[1].alongMeters).toBeCloseTo(cumulativeDistances(route.geometry)[4], 2);
      expect(points[1].approachBearing).toBeCloseTo(180, 4);
    },
  );

  it("skips lookahead vertices whose remaining visit is omitted from the geometry", () => {
    const t: LngLat = [0.005, -0.01];
    const b: LngLat = [0.005, 0];
    const start: LngLat = [0, 0];
    const a: LngLat = [0.0025, 0];
    const c: LngLat = [0.01, 0];
    const d: LngLat = [0.01, 0.01];
    const e: LngLat = [0.0025, 0.01];
    const end: LngLat = [0.003, -0.001];
    const route: Route = {
      ...driftRoute,
      geometry: [t, b, start, c, d, e, a, end],
      steps: [
        { ...driftRoute.steps[0], motorway: true, coordinates: [t, b, start, a] },
        { ...driftRoute.steps[2], motorway: true, coordinates: [a, b, c, d, e, a] },
        { ...driftRoute.steps[2], coordinates: [a, end] },
      ],
    };
    const points = findJunctionDecisionPoints(route);
    expect(points).toHaveLength(2);
    expect(points[0].alongMeters).toBeCloseTo(1945.911, 2);
    expect(points[0].approachBearing).toBeCloseTo(90, 4);
    expect(points[1].alongMeters).toBeCloseTo(cumulativeDistances(route.geometry)[6], 2);
    expect(points[1].approachBearing).toBeCloseTo(180, 4);
  });

  it("anchors a fork on the return along a retraced segment", () => {
    const a: LngLat = [0, 0];
    const middle: LngLat = [0.001, 0];
    const b: LngLat = [0.002, 0];
    const c: LngLat = [0.003, 0];
    const route: Route = {
      ...driftRoute,
      geometry: [a, b, c, a],
      steps: [
        { ...driftRoute.steps[0], motorway: true, coordinates: [a, middle, b, c] },
        { ...driftRoute.steps[1], motorway: true, coordinates: [c, b], maneuver: { type: "turn" } },
        { ...driftRoute.steps[2], coordinates: [b, middle, a] },
      ],
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.point).toEqual(b);
    expect(point.alongMeters).toBeCloseTo(444.78, 2);
    expect(point.approachBearing).toBeCloseTo(270, 4);
  });

  it.each(Array.from({ length: 64 }, (_, mask) => mask))(
    "retains travel order through simplified retraced geometry (mask %s)",
    (mask) => {
      const raw: LngLat[] = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3].map((x) => [x * 0.001, 0]);
      const optional = [1, 2, 4, 5, 7, 8];
      const retained = new Set([0, 3, 6, 9, ...optional.filter((_, bit) => mask & (1 << bit))]);
      const route: Route = {
        ...driftRoute,
        geometry: raw.filter((_, index) => retained.has(index)),
        steps: raw.slice(0, -1).map((coordinate, index) => ({
          ...driftRoute.steps[0],
          motorway: true,
          coordinates: [coordinate, raw[index + 1]],
          maneuver: { type: index === 0 ? "depart" : index === 3 || index === 6 ? "turn" : "fork" },
        })),
      };
      const points = findJunctionDecisionPoints(route);
      expect(points.map((point) => point.stepIndex)).toEqual([1, 2, 4, 5, 7, 8]);
      for (const point of points) {
        expect(point.point).toEqual(raw[point.stepIndex]);
        expect(point.alongMeters).toBeCloseTo(111.19492664455875 * point.stepIndex, 4);
      }
    },
  );

  it("reprojects anchors consumed by an earlier loop when its step shape is missing", () => {
    const a: LngLat = [0, 0];
    const b: LngLat = [0.01, 0];
    const c: LngLat = [0.01, 0.01];
    const d: LngLat = [0, 0.01];
    const end: LngLat = [0.012, 0];
    const route: Route = {
      ...driftRoute,
      geometry: [a, b, c, d, a, b, end],
      steps: [
        { ...driftRoute.steps[0], distance: 4447.797048846394, coordinates: [], motorway: true },
        { ...driftRoute.steps[1], coordinates: [a, b], motorway: true },
        { ...driftRoute.steps[2], coordinates: [b, end] },
      ],
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.point).toEqual(b);
    expect(point.alongMeters).toBeCloseTo(cumulativeDistances(route.geometry)[5], 4);
    expect(point.approachBearing).toBeCloseTo(90, 4);
  });

  it.each([5000, 6000])(
    "recovers a maneuver after missing-shape distance drift (%s m)",
    (distance) => {
      const a: LngLat = [0, 0];
      const b: LngLat = [0.01, 0];
      const c: LngLat = [0.01, 0.01];
      const d: LngLat = [0, 0.01];
      const route: Route = {
        ...driftRoute,
        geometry: [a, b, c, d, a, b, a],
        steps: [
          { ...driftRoute.steps[0], distance, coordinates: [], motorway: true },
          { ...driftRoute.steps[2], coordinates: [b, a] },
        ],
      };
      const point = findJunctionDecisionPoints(route)[0];
      expect(point.point).toEqual(b);
      expect(point.alongMeters).toBeCloseTo(cumulativeDistances(route.geometry)[5], 4);
      expect(point.divergenceDeg).toBeCloseTo(180, 4);
    },
  );

  it.each([
    { distance: 5000, earlierVertex: false },
    { distance: 6000, earlierVertex: false },
    { distance: 5000, earlierVertex: true },
    { distance: 6000, earlierVertex: true },
  ])(
    "recovers an omitted maneuver after a missing shape ($distance m, earlier vertex $earlierVertex)",
    ({ distance, earlierVertex }) => {
      const a: LngLat = [0, 0];
      const middle: LngLat = [0.005, 0];
      const b: LngLat = [0.01, 0];
      const c: LngLat = [0.01, 0.01];
      const d: LngLat = [0, 0.01];
      const end: LngLat = [0.012, 0];
      const route: Route = {
        ...driftRoute,
        geometry: earlierVertex ? [a, middle, b, c, d, a, b, end] : [a, b, c, d, a, b, end],
        steps: [
          { ...driftRoute.steps[0], distance, coordinates: [], motorway: true },
          { ...driftRoute.steps[2], coordinates: [middle, b, end] },
        ],
      };
      const point = findJunctionDecisionPoints(route)[0];
      expect(point.point).toEqual(middle);
      expect(point.alongMeters).toBeCloseTo(5003.77168196654, 4);
      expect(junctionLookupPoints(route, [point])[0].lookup.trace[3][0]).toBeLessThan(0.005);
    },
  );

  it.each([1, 8])("uses distance evidence to pass a loop with %s missing step shapes", (count) => {
    const route: Route = {
      ...driftRoute,
      geometry: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
        [0.002, 0],
      ],
      steps: [
        ...Array.from({ length: count }, () => ({
          instruction: "Drive around the block",
          distance: 4447.797048846394 / count,
          duration: 100 / count,
          coordinates: [],
          motorway: true,
        })),
        {
          instruction: "Exit right",
          distance: 220,
          duration: 20,
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
          maneuver: { type: "fork", modifier: "right" },
        },
      ],
    };
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.alongMeters).toBeCloseTo(4447.797, 2);
    expect(point.approachBearing).toBeCloseTo(180, 4);
  });
});

const METERS_PER_DEG_LAT = 111320;

interface SyntheticStep {
  bearing?: number;
  step: Omit<RouteStep, "coordinates" | "distance" | "duration">;
}

/** A synthetic route: every step runs 300 m at its bearing (east by default). */
function syntheticRoute(steps: SyntheticStep[], mode: Route["mode"] = "driving"): Route {
  const geometry: LngLat[] = [];
  const full: RouteStep[] = [];
  const LAT_DEG = 51.18;
  const lngM = 111320 * Math.cos((LAT_DEG * Math.PI) / 180);
  let cursor: LngLat = [0, LAT_DEG];
  let along = 0;
  for (const { bearing = 90, step } of steps) {
    const start = cursor;
    along += 300;
    const dx = Math.sin((bearing * Math.PI) / 180) * 300;
    const dy = Math.cos((bearing * Math.PI) / 180) * 300;
    cursor = [cursor[0] + dx / lngM, cursor[1] + dy / METERS_PER_DEG_LAT];
    geometry.push(start, cursor);
    full.push({
      ...step,
      instruction: step.instruction,
      distance: 300,
      duration: 20,
      coordinates: [start, cursor],
    });
  }
  return {
    distance: along,
    duration: 60,
    geometry,
    legs: [],
    steps: full,
    mode,
  };
}

describe("findJunctionDecisionPoints on the A57 fixture", () => {
  it("finds exactly the exit step as an exit decision point", () => {
    const points = findJunctionDecisionPoints(a57Route);
    expect(points).toHaveLength(1);
    const point = points[0];
    expect(point.stepIndex).toBe(1);
    expect(point.kind).toBe("exit");
    expect(point.side).toBe("right");
    expect(point.laneCount).toBe(5);
    expect(point.activeLanes).toEqual([4]);
    expect(point.divergenceDeg).toBe(17);
    // The route runs at bearing ~283 for the whole approach.
    expect(Math.abs(((point.approachBearing - 283 + 540) % 360) - 180)).toBeLessThan(15);
  });
});

describe("findJunctionCandidates", () => {
  it("offers an exit off a road the engine never flags, for OpenStreetMap to confirm", () => {
    // A trunk-road exit: the engine marks only motorways, so the step before
    // carries no flag and detection alone cannot tell it from an on-ramp.
    const route = syntheticRoute([
      { step: { instruction: "Drive", maneuver: { type: "depart" } } },
      {
        step: {
          instruction: "Take exit 3 toward Kaarst",
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitNumbers: ["3"], exitToward: ["Kaarst"] },
        },
      },
    ]);
    const candidates = findJunctionCandidates(route);
    expect(candidates.map((candidate) => candidate.stepIndex)).toEqual([1]);
    expect(candidates[0].kind).toBe("exit");
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("never offers a step detection already accepted", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      { step: { instruction: "Exit right", maneuver: { type: "fork", modifier: "right" } } },
    ]);
    expect(findJunctionCandidates(route)).toEqual([]);
  });

  it("leaves town keeps out, since a split between streets is no junction", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", maneuver: { type: "turn", modifier: "left" } } },
      { step: { instruction: "Keep right", maneuver: { type: "keep", modifier: "right" } } },
    ]);
    expect(findJunctionCandidates(route)).toEqual([]);
  });

  it("offers nothing on foot", () => {
    const route = syntheticRoute(
      [
        { step: { instruction: "Walk", maneuver: { type: "depart" } } },
        { step: { instruction: "Fork right", maneuver: { type: "fork", modifier: "right" } } },
      ],
      "walking",
    );
    expect(findJunctionCandidates(route)).toEqual([]);
  });
});

describe("findJunctionDecisionPoints synthetic cases", () => {
  it("treats a keep right after a motorway step as a fork", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      { step: { instruction: "Keep right", maneuver: { type: "keep", modifier: "right" } } },
    ]);
    const points = findJunctionDecisionPoints(route);
    expect(points).toHaveLength(1);
    expect(points[0].kind).toBe("fork");
    expect(points[0].side).toBe("right");
  });

  it("mirrors a left fork to side left", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      { step: { instruction: "Keep left", maneuver: { type: "fork", modifier: "left" } } },
    ]);
    expect(findJunctionDecisionPoints(route)[0].side).toBe("left");
  });

  it("ignores a plain turn in town", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive" } },
      { step: { instruction: "Turn right", maneuver: { type: "turn", modifier: "right" } } },
    ]);
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("keeps the exit number off a fork reached from an ordinary road", () => {
    // German on-ramps carry the junction's number too ("Take exit 16 onto
    // A 57"), so a number alone never makes a fork an exit.
    const route = syntheticRoute([
      { step: { instruction: "Drive", maneuver: { type: "turn", modifier: "left" } } },
      {
        step: {
          instruction: "Take exit 16 onto A 57",
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitNumbers: ["16"], exitBranches: ["A 57"] },
        },
      },
    ]);
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("carries the sign through on an unflagged exit ramp off the motorway", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      {
        step: {
          instruction: "Keep right at the exit",
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitNumbers: ["20"] },
        },
      },
    ]);
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.kind).toBe("exit");
    expect(point.activeLanes).toEqual([]);
    expect(point.laneCount).toBeUndefined();
  });

  it("ignores a fork with no flags and no sign", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive" } },
      { step: { instruction: "Keep right", maneuver: { type: "keep", modifier: "right" } } },
    ]);
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("ignores an on-ramp from a town road even though the ramp maneuver is motorway-flagged", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", maneuver: { type: "turn", modifier: "left" } } },
      {
        step: {
          instruction: "Turn right to take the A 57 ramp toward Krefeld.",
          motorway: true,
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitBranches: ["A 57"], exitToward: ["Krefeld"] },
        },
      },
    ]);
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("ignores a numbered on-ramp that continues onto the motorway", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", maneuver: { type: "turn", modifier: "uturn" } } },
      {
        step: {
          instruction: "Take exit 16 onto A 57 toward Krefeld.",
          motorway: true,
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitNumbers: ["16"], exitBranches: ["A 57"], exitToward: ["Krefeld"] },
        },
      },
    ]);
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("keeps a split on the exit ramp after a motorway exit", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      {
        bearing: 60,
        step: {
          instruction: "Take exit 20 toward A 46.",
          maneuver: { type: "fork", modifier: "right" },
          sign: { exitNumbers: ["20"] },
        },
      },
      {
        bearing: 40,
        step: {
          instruction: "Keep left toward Aachen.",
          motorway: true,
          maneuver: { type: "keep", modifier: "left" },
          sign: { exitToward: ["Aachen"] },
        },
      },
    ]);
    expect(findJunctionDecisionPoints(route).map((p) => p.stepIndex)).toEqual([1, 2]);
  });

  it("returns nothing for a walking route", () => {
    const route = syntheticRoute(
      [
        { step: { instruction: "Walk", motorway: true, maneuver: { type: "depart" } } },
        {
          step: {
            instruction: "Fork right",
            maneuver: { type: "fork", modifier: "right" },
            sign: { exitNumbers: ["1"] },
          },
        },
      ],
      "walking",
    );
    expect(findJunctionDecisionPoints(route)).toEqual([]);
  });

  it("derives the divergence from the geometry when the engine sent no bearings", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      {
        bearing: 45,
        step: { instruction: "Exit right", maneuver: { type: "fork", modifier: "right" } },
      },
    ]);
    const point = findJunctionDecisionPoints(route)[0];
    // Eastbound approach peeling north-east: ~45° divergence from the geometry.
    expect(Math.abs(point.divergenceDeg)).toBeGreaterThan(5);
    expect(Math.abs(point.divergenceDeg)).toBeLessThan(60);
  });

  it("reports no lanes for a step the engine sent none for", () => {
    const route = syntheticRoute([
      { step: { instruction: "Drive", motorway: true, maneuver: { type: "depart" } } },
      { step: { instruction: "Exit right", maneuver: { type: "fork", modifier: "right" } } },
    ]);
    const point = findJunctionDecisionPoints(route)[0];
    expect(point.laneCount).toBeUndefined();
    expect(point.activeLanes).toEqual([]);
  });
});

describe("sameJunction", () => {
  const exit = findJunctionDecisionPoints(fixture.route as unknown as Route)[0];

  it("matches the junction on a replacement route despite a new step index", () => {
    expect(
      sameJunction(exit, { ...exit, stepIndex: 7, point: [exit.point[0] + 0.0001, exit.point[1]] }),
    ).toBe(true);
  });

  it("tells apart a junction elsewhere, on the other side, or approached another way", () => {
    expect(sameJunction(exit, { ...exit, point: [exit.point[0] + 0.001, exit.point[1]] })).toBe(
      false,
    );
    expect(sameJunction(exit, { ...exit, side: "left" })).toBe(false);
    expect(sameJunction(exit, { ...exit, approachBearing: exit.approachBearing + 180 })).toBe(
      false,
    );
  });
});
