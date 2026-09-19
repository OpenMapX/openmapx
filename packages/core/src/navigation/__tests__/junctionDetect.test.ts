import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { Route, RouteStep } from "../../types/routing";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import {
  findJunctionCandidates,
  findJunctionDecisionPoints,
  sameJunction,
} from "../junctionDetect";

const a57Route = fixture.route as unknown as Route;

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
