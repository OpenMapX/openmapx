import { describe, expect, it } from "vitest";
import {
  joinSegmentSpeedLimits,
  osrmRouteSegmentSpeedLimits,
  osrmSegmentSpeedLimits,
  osrmService,
  transformOsrmStep,
} from "./provider.js";

const osrmStep = {
  distance: 120,
  duration: 30,
  name: "Main St",
  maneuver: { type: "turn", modifier: "right", location: [0, 0] as [number, number] },
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [0, 0],
      [0.001, 0],
    ] as [number, number][],
  },
  intersections: [
    {
      lanes: [
        { valid: false, indications: ["left"] },
        { valid: true, indications: ["straight"] },
      ],
    },
  ],
  annotation: { maxspeed: [{ speed: 50, unit: "km/h" }] },
};

describe("transformOsrmStep", () => {
  it("carries maneuver type/modifier", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.maneuver).toEqual({ type: "turn", modifier: "right" });
  });

  it("carries the road name and split refs for incident matching", () => {
    const s = transformOsrmStep({ ...osrmStep, ref: "A 57; E 31" });
    expect(s.roadNames).toEqual(["Main St", "A 57", "E 31"]);
  });

  it("carries lanes from the first intersection with lanes", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.lanes).toEqual([
      { indications: ["left"], valid: false },
      { indications: ["straight"], valid: true },
    ]);
  });

  it("captures valid_indication as the active lane indication", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      intersections: [
        {
          lanes: [
            { valid: false, indications: ["left"] },
            { valid: true, indications: ["straight", "right"], valid_indication: "right" },
          ],
        },
      ],
    });
    expect(s.lanes?.[1]).toEqual({
      indications: ["straight", "right"],
      valid: true,
      active: "right",
    });
    // Invalid lane without a valid_indication carries no `active`.
    expect(s.lanes?.[0].active).toBeUndefined();
  });

  it("carries speed limit in km/h", () => {
    const s = transformOsrmStep(osrmStep);
    expect(s.speedLimit).toBe(50);
  });

  it("converts mph speed limits to km/h", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      annotation: { maxspeed: [{ speed: 30, unit: "mph" }] },
    });
    expect(s.speedLimit).toBe(48); // 30 * 1.609 ≈ 48
  });

  it("omits lanes and speed limit when not provided", () => {
    const s = transformOsrmStep({
      distance: 10,
      duration: 5,
      name: "Side St",
      maneuver: { type: "depart", location: [0, 0] as [number, number] },
      geometry: {
        type: "LineString" as const,
        coordinates: [[0, 0]] as [number, number][],
      },
    });
    expect(s.lanes).toBeUndefined();
    expect(s.speedLimit).toBeUndefined();
    expect(s.maneuver).toEqual({ type: "depart", modifier: undefined });
  });

  it("skips maxspeed entries flagged unknown", () => {
    const s = transformOsrmStep({
      ...osrmStep,
      annotation: { maxspeed: [{ unknown: true }, { speed: 70, unit: "km/h" }] },
    });
    expect(s.speedLimit).toBe(70);
  });
});

// A step with N geometry coordinates has N-1 segments; OSRM's `maxspeed`
// annotation is already one entry per segment, so the per-segment limit array
// is just the normalized annotation aligned to those segments.
const threeCoordStep = {
  distance: 200,
  duration: 40,
  name: "Main St",
  maneuver: { type: "turn", modifier: "right", location: [0, 0] as [number, number] },
  geometry: {
    type: "LineString" as const,
    coordinates: [
      [0, 0],
      [0.001, 0],
      [0.002, 0],
    ] as [number, number][],
  },
  annotation: {
    maxspeed: [
      { speed: 50, unit: "km/h" },
      { speed: 70, unit: "km/h" },
    ],
  },
};

describe("osrmSegmentSpeedLimits", () => {
  it("returns one normalized km/h value per geometry segment", () => {
    expect(osrmSegmentSpeedLimits(threeCoordStep)).toEqual([50, 70]);
  });

  it("converts mph segments to km/h", () => {
    const limits = osrmSegmentSpeedLimits({
      ...threeCoordStep,
      annotation: { maxspeed: [{ speed: 30, unit: "mph" }, { unknown: true }] },
    });
    expect(limits).toEqual([48, null]); // 30 * 1.609 ≈ 48; unknown → null
  });

  it("yields all-null of length coords-1 when the annotation is absent", () => {
    const limits = osrmSegmentSpeedLimits({
      ...threeCoordStep,
      annotation: undefined,
    });
    expect(limits).toEqual([null, null]);
  });

  it("always has length equal to the segment count (coords - 1)", () => {
    expect(osrmSegmentSpeedLimits(threeCoordStep)).toHaveLength(2);
    // Ragged: fewer annotation entries than segments → padded with null.
    const ragged = osrmSegmentSpeedLimits({
      ...threeCoordStep,
      annotation: { maxspeed: [{ speed: 50, unit: "km/h" }] },
    });
    expect(ragged).toEqual([50, null]);
  });
});

describe("osrmRouteSegmentSpeedLimits", () => {
  // Standard OSRM returns maxspeed on the LEG (one entry per overview segment),
  // not on steps. The overview here has 3 coords = 2 segments.
  const baseRoute = {
    distance: 200,
    duration: 30,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [0, 0],
        [0.001, 0],
        [0.002, 0],
      ] as [number, number][],
    },
    legs: [
      {
        summary: "Main St",
        distance: 200,
        duration: 30,
        annotation: {
          maxspeed: [
            { speed: 50, unit: "km/h" },
            { speed: 70, unit: "km/h" },
          ],
        },
        steps: [],
      },
    ],
  };

  it("builds per-segment limits from the leg annotation (standard OSRM)", () => {
    expect(osrmRouteSegmentSpeedLimits(baseRoute)).toEqual([50, 70]);
  });

  it("falls back to per-step annotation when the leg has none", () => {
    const route = {
      ...baseRoute,
      legs: [{ ...baseRoute.legs[0], annotation: undefined, steps: [threeCoordStep] }],
    };
    expect(osrmRouteSegmentSpeedLimits(route)).toEqual([50, 70]);
  });

  it("returns undefined when neither leg nor step annotation is present", () => {
    const route = {
      ...baseRoute,
      legs: [{ ...baseRoute.legs[0], annotation: undefined, steps: [] }],
    };
    expect(osrmRouteSegmentSpeedLimits(route)).toBeUndefined();
  });
});

describe("joinSegmentSpeedLimits", () => {
  it("concatenates per-step segment limits into one route-aligned array", () => {
    const joined = joinSegmentSpeedLimits(
      [
        [50, 70],
        [70, 100, 100],
      ],
      5,
    );
    expect(joined).toEqual([50, 70, 70, 100, 100]);
  });

  it("returns undefined when the total length does not match the route segments", () => {
    // expectedLen mismatch (overview geometry diverged from step geometry).
    expect(joinSegmentSpeedLimits([[50], [70, 70]], 5)).toBeUndefined();
  });

  it("returns undefined when every segment is unknown (a useless array)", () => {
    expect(
      joinSegmentSpeedLimits(
        [
          [null, null],
          [null, null],
        ],
        4,
      ),
    ).toBeUndefined();
  });
});

describe("osrmService.temporal", () => {
  it("declares every semantic approximate and travel time not time-dependent", () => {
    expect(osrmService.temporal).toEqual({
      tripDepartAt: "approximate",
      tripArriveBy: "approximate",
      dwell: "approximate",
      waypointDepartAfter: "approximate",
      waypointArriveBy: "approximate",
      timeDependentTravel: "unsupported",
    });
  });
});
