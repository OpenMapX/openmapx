import {
  createNavigationSessionSnapshot,
  parseNavigationSessionSnapshot,
} from "@openmapx/core/navigation";
import { describe, expect, it } from "vitest";
import { concatenateRoutes } from "../route-concat.js";
import type { Route, RouteStep } from "../types.js";

function step(instruction: string): RouteStep {
  return { instruction, distance: 100, duration: 60, coordinates: [] };
}

function route(overrides: Partial<Route> & { geometry: [number, number][] }): Route {
  return {
    distance: 1000,
    duration: 600,
    legs: [
      {
        distance: 1000,
        duration: 600,
        geometry: overrides.geometry,
        steps: [{ ...step("go"), coordinates: overrides.geometry }],
      },
    ],
    steps: [{ ...step("go"), coordinates: overrides.geometry }],
    mode: "driving",
    ...overrides,
  };
}

describe("concatenateRoutes", () => {
  it("returns the single route untouched", () => {
    const only = route({
      geometry: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(concatenateRoutes([only])).toBe(only);
  });

  it("drops the duplicated join coordinate", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.geometry).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("keeps a coordinate that is not an exact join", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
      }),
      route({
        geometry: [
          [1.0001, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.geometry).toHaveLength(4);
  });

  it("sums distance and duration and concatenates legs and steps", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        distance: 1000,
        duration: 600,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        distance: 2500,
        duration: 900,
      }),
    ]);
    expect(merged.distance).toBe(3500);
    expect(merged.duration).toBe(1500);
    expect(merged.legs).toHaveLength(2);
    expect(merged.steps).toHaveLength(2);
  });

  it("keeps segmentSpeedLimits aligned to the joined geometry", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        segmentSpeedLimits: [50, 70],
      }),
      route({
        geometry: [
          [2, 2],
          [3, 3],
        ],
        segmentSpeedLimits: [null],
      }),
    ]);
    expect(merged.geometry).toHaveLength(4);
    expect(merged.segmentSpeedLimits).toEqual([50, 70, null]);
    expect(merged.segmentSpeedLimits).toHaveLength(merged.geometry.length - 1);
  });

  it("leaves connecting segments unknown across unequal joins", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [13.4, 52.5],
          [13.401, 52.5],
        ],
        segmentSpeedLimits: [50],
      }),
      route({
        geometry: [
          [13.4012, 52.5],
          [13.402, 52.5],
        ],
        segmentSpeedLimits: [30],
      }),
      route({
        geometry: [
          [13.4022, 52.5],
          [13.403, 52.5],
        ],
        segmentSpeedLimits: [70],
      }),
    ]);
    expect(merged.geometry).toHaveLength(6);
    expect(merged.segmentSpeedLimits).toEqual([50, null, 30, null, 70]);
    expect(merged.segmentSpeedLimits).toHaveLength(merged.geometry.length - 1);
  });

  it("persists and restores navigation after an unequal route join", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [13.4, 52.5],
          [13.401, 52.5],
        ],
        segmentSpeedLimits: [50],
      }),
      route({
        geometry: [
          [13.4012, 52.5],
          [13.402, 52.5],
        ],
        segmentSpeedLimits: [30],
      }),
    ]);
    const snapshot = createNavigationSessionSnapshot({
      route: merged,
      routes: [merged],
      activeRouteIndex: 0,
      routeSelectionIntent: "automatic",
      mode: "driving",
      routeOptions: {
        avoidHighways: false,
        avoidTolls: false,
        avoidFerries: false,
        avoidClosures: false,
      },
      routeProvider: "osrm",
      destinationWaypoints: [
        [13.4, 52.5],
        [13.402, 52.5],
      ],
      progress: null,
      packageIds: [`omp2-${"a".repeat(64)}`],
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
    });
    const restored = parseNavigationSessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored?.route.segmentSpeedLimits).toEqual([50, null, 30]);
    expect(restored?.route.geometry).toEqual(merged.geometry);
  });

  it("omits segmentSpeedLimits when any leg lacks them", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        segmentSpeedLimits: [50],
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(merged.segmentSpeedLimits).toBeUndefined();
  });

  it("sums baselineDuration only when every leg reports one", () => {
    const both = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        baselineDuration: 500,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        baselineDuration: 800,
      }),
    ]);
    expect(both.baselineDuration).toBe(1300);

    const partial = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        baselineDuration: 500,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
      }),
    ]);
    expect(partial.baselineDuration).toBeUndefined();
  });

  it("joins elevation only when every leg samples at the same interval", () => {
    const same = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        elevation: [10, 20],
        elevationInterval: 30,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        elevation: [20, 40],
        elevationInterval: 30,
      }),
    ]);
    expect(same.elevation).toEqual([10, 20, 20, 40]);
    expect(same.elevationInterval).toBe(30);

    const mixed = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        elevation: [10, 20],
        elevationInterval: 30,
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        elevation: [20, 40],
        elevationInterval: 60,
      }),
    ]);
    expect(mixed.elevation).toBeUndefined();
    expect(mixed.elevationInterval).toBeUndefined();
  });

  it("keeps the first leg's summary and mode", () => {
    const merged = concatenateRoutes([
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        summary: "via A57",
        mode: "driving",
      }),
      route({
        geometry: [
          [1, 1],
          [2, 2],
        ],
        summary: "via B9",
      }),
    ]);
    expect(merged.summary).toBe("via A57");
    expect(merged.mode).toBe("driving");
  });

  it("tolls the trip when any leg is tolled, and frees it only when every leg is", () => {
    const leg = (hasTolls?: boolean) =>
      route({
        geometry: [
          [0, 0],
          [1, 1],
        ],
        ...(hasTolls === undefined ? {} : { hasTolls }),
      });

    expect(concatenateRoutes([leg(false), leg(true)]).hasTolls).toBe(true);
    expect(concatenateRoutes([leg(false), leg(false)]).hasTolls).toBe(false);
    expect(concatenateRoutes([leg(false), leg()]).hasTolls).toBeUndefined();
  });
});

it("preserves all required notices and field receipts when retained legs overlap", () => {
  const a = { sourceId: "same", name: "Supplier", attributionText: "A notice" };
  const b = { sourceId: "same", name: "Supplier", attributionText: "B notice" };
  const first = route({
    geometry: [
      [0, 0],
      [1, 1],
    ],
    contributors: [a],
    fieldContributors: { geometry: [a], duration: [] },
    sourceIds: ["a"],
  });
  const second = route({
    geometry: [
      [1, 1],
      [2, 2],
    ],
    contributors: [b],
    fieldContributors: { geometry: [b] },
    sourceIds: ["b"],
  });
  const joined = concatenateRoutes([first, second]);
  expect(joined.contributors).toEqual([a, b]);
  expect(joined.fieldContributors).toMatchObject({ geometry: [a, b], duration: [] });
  expect(joined.sourceIds).toEqual(["a", "b"]);
  expect(joined.geometry).toHaveLength(3);
  a.attributionText = "changed";
  expect(joined.contributors?.[0].attributionText).toBe("A notice");
  expect(joined.fieldContributors?.geometry[0].attributionText).toBe("A notice");
});

it("copies scalar receipts from the retained value and drops absent output fields", () => {
  const a = { sourceId: "same", name: "Supplier", attributionText: "A notice" };
  const b = { sourceId: "same", name: "Supplier", attributionText: "B notice" };
  const joined = concatenateRoutes([
    route({
      geometry: [
        [0, 0],
        [1, 1],
      ],
      summary: "Only A",
      contributors: [a],
      fieldContributors: { summary: [a], mode: [a], geometry: [a], elevation: [a], hasTolls: [a] },
      hasTolls: false,
      elevation: [1, 2],
      elevationInterval: 30,
    }),
    route({
      geometry: [
        [1, 1],
        [2, 2],
      ],
      summary: "Discarded B",
      contributors: [b],
      fieldContributors: { summary: [b], mode: [b], geometry: [b], elevation: [b], hasTolls: [b] },
      hasTolls: true,
    }),
  ]);
  expect(joined.fieldContributors?.summary).toEqual([a]);
  expect(joined.fieldContributors?.mode).toEqual([a]);
  expect(joined.fieldContributors?.geometry).toEqual([a, b]);
  expect(joined.fieldContributors?.elevation).toBeUndefined();
  expect(joined.fieldContributors?.hasTolls).toEqual([b]);
});

it("retains uniform field ownership beside a partial route and preserves spatial boundaries offline", () => {
  const a = { sourceId: "a", name: "A", attributionText: "A required" };
  const b = { sourceId: "b", name: "B" };
  const joined = concatenateRoutes([
    route({
      geometry: [
        [0, 0],
        [1, 0],
      ],
      contributors: [a],
      summary: "A only",
    }),
    route({
      geometry: [
        [1, 0],
        [2, 0],
      ],
      contributors: [b],
      fieldContributors: { duration: [b], "legs.0.summary": [] },
    }),
  ]);
  expect(joined.fieldContributors?.geometry).toEqual([a]);
  expect(joined.fieldContributors?.distance).toEqual([a]);
  expect(joined.fieldContributors?.duration).toEqual([a, b]);
  expect(joined.fieldContributors?.summary).toEqual([a]);
  expect(joined.fieldContributors?.mode).toEqual([a]);
  expect(joined.fieldContributors?.["legs.1.summary"]).toEqual([]);
  expect(joined.geometryContributors).toEqual([
    { startIndex: 0, endIndex: 1, contributors: [a] },
    { startIndex: 1, endIndex: 2, contributors: [] },
  ]);
  const snapshot = createNavigationSessionSnapshot({
    route: joined,
    routes: [joined],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: "test",
    destinationWaypoints: [[2, 0]],
    progress: null,
    packageIds: [],
    startedAtMs: 1000,
    updatedAtMs: 1000,
  });
  const restored = parseNavigationSessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
  expect(restored?.route.geometryContributors).toEqual(joined.geometryContributors);
  expect(restored?.route.fieldContributors).toEqual(joined.fieldContributors);
  a.attributionText = "later mutation";
  expect(restored?.route.geometryContributors?.[0].contributors?.[0].attributionText).toBe(
    "A required",
  );
});

it("keeps canonical empty child authority over a parent's stale detailed tree", () => {
  const a = { sourceId: "a", name: "A" };
  const first = route({
    geometry: [
      [0, 0],
      [1, 0],
    ],
    contributors: [a],
    fieldContributors: { legs: [a], "legs.0.summary": [a] },
  });
  first.legs[0].contributors = [];
  const second = route({
    geometry: [
      [1, 0],
      [2, 0],
    ],
    contributors: [],
  });
  const result = concatenateRoutes([first, second]);
  expect(result.fieldContributors?.["legs.0"]).toEqual([]);
  expect(result.fieldContributors?.["legs.0.summary"]).toBeUndefined();
});
