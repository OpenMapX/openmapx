import { describe, expect, it } from "vitest";
import type { NavigationRouteOptions } from "../stores/navigationStore";
import type { Route, RouteStep } from "../types/routing";
import {
  createNavigationSessionSnapshot,
  isNavigationSessionExpired,
  NAVIGATION_SESSION_MAX_AGE_MS,
  navigationSessionFingerprint,
  parseNavigationSessionSnapshot,
} from "./offlineSession";
import type { NavProgress } from "./types";

const geometry: [number, number][] = [
  [13.4, 52.5],
  [13.401, 52.501],
  [13.402, 52.502],
];

const route = (offset = 0): Route => ({
  distance: 320 + offset,
  duration: 90,
  geometry: geometry.map(([lng, lat], index) => [lng + offset / 1_000_000, lat + index / 10_000]),
  legs: [
    {
      distance: 320 + offset,
      duration: 90,
      geometry: geometry.map(([lng, lat]) => [lng, lat]),
      steps: [
        {
          instruction: "Turn right",
          distance: 150,
          duration: 40,
          coordinates: [geometry[0], geometry[1]],
          maneuver: { type: "turn", modifier: "right" },
          verbalPre: "Turn right onto Main Street",
        },
        {
          instruction: "Arrive",
          distance: 170,
          duration: 50,
          coordinates: [geometry[1], geometry[2]],
        },
      ],
    },
  ],
  steps: [
    {
      instruction: "Turn right",
      distance: 150,
      duration: 40,
      coordinates: [geometry[0], geometry[1]],
      maneuver: { type: "turn", modifier: "right" },
      verbalPre: "Turn right onto Main Street",
    },
    {
      instruction: "Arrive",
      distance: 170,
      duration: 50,
      coordinates: [geometry[1], geometry[2]],
    },
  ],
  mode: "driving",
});

const options: NavigationRouteOptions = {
  avoidHighways: false,
  avoidTolls: true,
  avoidFerries: false,
  avoidClosures: true,
};

const progress: NavProgress = {
  currentStepIndex: 0,
  distanceToNextManeuver: 100,
  distanceRemaining: 320,
  durationRemaining: 90,
  snapped: geometry[0],
  alongMeters: 0,
  deviationMeters: 2,
  segmentIndex: 0,
  etaEpochMs: 1_000_090_000,
  bearing: 45,
  speedMps: 12,
};

function input(overrides: Partial<Parameters<typeof createNavigationSessionSnapshot>[0]> = {}) {
  const primary = route();
  return {
    route: primary,
    routes: [primary, route(100)],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic" as const,
    mode: "driving" as const,
    routeOptions: options,
    routeProvider: "osrm",
    destinationWaypoints: [geometry[0], geometry[2]],
    progress,
    packageIds: [`omp2-${"a".repeat(64)}`],
    startedAtMs: 1_000_000_000,
    updatedAtMs: 1_000_010_000,
    ...overrides,
  };
}

/** A step carrying every optional field the snapshot copier touches. */
function richStep(): RouteStep {
  return {
    instruction: "Turn right",
    distance: 150,
    duration: 40,
    coordinates: [geometry[0], geometry[1]],
    roadNames: ["Main Street", "B 9"],
    maneuver: { type: "turn", modifier: "right" },
    speedLimit: 50,
    lanes: [{ indications: ["straight", "right"], valid: true, active: "right" }],
    verbalAlert: "Turn right onto Main Street",
    verbalPre: "Turn right",
    verbalPost: "Continue on Main Street",
    verbalSuccinct: "Right",
    roundaboutExitCount: 2,
    sign: {
      exitNumbers: ["21"],
      exitBranches: ["A 57"],
      exitToward: ["Köln"],
      exitNames: ["Aéroport"],
    },
    drivingSide: "right",
  };
}

function arriveStep(): RouteStep {
  return {
    instruction: "Arrive",
    distance: 170,
    duration: 50,
    coordinates: [geometry[1], geometry[2]],
  };
}

function richRoute(): Route {
  return {
    distance: 320,
    duration: 90,
    baselineDuration: 100,
    geometry: geometry.map(([lng, lat]) => [lng, lat]),
    legs: [
      {
        distance: 320,
        duration: 90,
        geometry: geometry.map(([lng, lat]) => [lng, lat]),
        steps: [richStep(), arriveStep()],
        summary: "Main Street",
      },
    ],
    steps: [richStep(), arriveStep()],
    mode: "driving",
    segmentSpeedLimits: [50, 30],
    summary: "via Main Street",
    elevation: [10, 12, 14],
    elevationInterval: 100,
  };
}

function richInput() {
  const primary = richRoute();
  return input({ route: primary, routes: [primary] });
}

type Corrupt = (snapshot: Record<string, unknown>) => void;

function loose(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Overwrite one field of the active route's first step. */
function onStep(field: string, value: unknown): Corrupt {
  return (snapshot) => {
    loose((snapshot.route as Route).steps[0])[field] = value;
  };
}

/** Overwrite one field of the first step inside the active route's first leg. */
function onLegStep(field: string, value: unknown): Corrupt {
  return (snapshot) => {
    loose((snapshot.route as Route).legs[0].steps[0])[field] = value;
  };
}

function onRoute(field: string, value: unknown): Corrupt {
  return (snapshot) => {
    loose(snapshot.route)[field] = value;
  };
}

function onSnapshot(field: string, value: unknown): Corrupt {
  return (snapshot) => {
    snapshot[field] = value;
  };
}

// One row per optional object/array field the copier reads, plus the containers
// holding them. None of these may throw and none may be coerced into defaults.
const corruptions: [string, Corrupt][] = [
  ["road names as an object", onStep("roadNames", {})],
  ["road names holding numbers", onStep("roadNames", [1])],
  ["road names holding null", onStep("roadNames", [null])],
  ["a maneuver as a number", onStep("maneuver", 5)],
  ["a maneuver as an array", onStep("maneuver", [])],
  ["a maneuver without a type", onStep("maneuver", { modifier: "right" })],
  ["a maneuver with a non-string type", onStep("maneuver", { type: 5 })],
  ["a maneuver with a non-string modifier", onStep("maneuver", { type: "turn", modifier: 7 })],
  ["lanes as an object", onStep("lanes", {})],
  ["lanes holding null", onStep("lanes", [null])],
  ["lanes holding a string", onStep("lanes", ["right"])],
  ["lane indications as an object", onStep("lanes", [{ indications: {}, valid: true }])],
  ["lane indications holding numbers", onStep("lanes", [{ indications: [1], valid: true }])],
  ["lane validity as a string", onStep("lanes", [{ indications: [], valid: "yes" }])],
  [
    "a lane active indication as a number",
    onStep("lanes", [{ indications: [], valid: true, active: 3 }]),
  ],
  ["a sign as a number", onStep("sign", 7)],
  ["a sign as an array", onStep("sign", [])],
  ["sign exit numbers as an object", onStep("sign", { exitNumbers: {} })],
  ["sign exit branches holding numbers", onStep("sign", { exitBranches: [3] })],
  ["a sign exit toward as a string", onStep("sign", { exitToward: "Köln" })],
  ["sign exit names holding null", onStep("sign", { exitNames: [null] })],
  ["a verbal alert as a number", onStep("verbalAlert", 3)],
  ["a verbal pre-instruction as null", onStep("verbalPre", null)],
  ["a verbal post-instruction as an object", onStep("verbalPost", {})],
  ["a succinct instruction as an array", onStep("verbalSuccinct", [])],
  ["an unknown driving side", onStep("drivingSide", "middle")],
  ["a driving side as null", onStep("drivingSide", null)],
  ["step coordinates holding null", onStep("coordinates", [[0, 0], null])],
  ["a leg step with corrupt lanes", onLegStep("lanes", {})],
  ["a leg step with a corrupt sign", onLegStep("sign", { exitNames: 5 })],
  [
    "a leg summary as a number",
    (snapshot) => {
      loose((snapshot.route as Route).legs[0]).summary = 5;
    },
  ],
  ["legs as an object", onRoute("legs", {})],
  ["legs holding null", onRoute("legs", [null])],
  ["steps as an object", onRoute("steps", {})],
  ["steps holding null", onRoute("steps", [null])],
  ["a route summary as an object", onRoute("summary", {})],
  ["an elevation profile as an object", onRoute("elevation", {})],
  ["an elevation profile holding strings", onRoute("elevation", ["1"])],
  ["an elevation profile holding NaN", onRoute("elevation", [Number.NaN])],
  ["an elevation interval as a string", onRoute("elevationInterval", "10")],
  ["an elevation interval as null", onRoute("elevationInterval", null)],
  ["segment speed limits as an object", onRoute("segmentSpeedLimits", {})],
  ["route options as an array", onSnapshot("routeOptions", [])],
  ["destination waypoints as an object", onSnapshot("destinationWaypoints", {})],
  [
    "an alternative route",
    (snapshot) => {
      ((snapshot.routes as Route[])[0].steps as unknown[]).splice(0, 1, 5);
    },
  ],
  [
    "a last known position without coordinates",
    onSnapshot("lastKnownPosition", { timestampMs: 1 }),
  ],
];

describe("navigation session snapshot", () => {
  it("creates a schema-version-one snapshot with route and maneuver data", () => {
    const snapshot = createNavigationSessionSnapshot(input());
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.kind).toBe("ground");
    expect(snapshot.route.steps[0].instruction).toBe("Turn right");
    expect(snapshot.routes).toHaveLength(2);
    expect(snapshot.routeFingerprint).toContain("nav1-");
  });

  it("copies only the supported route/session fields", () => {
    const source = route() as Route & {
      rawResponse?: unknown;
      gpsHistory?: unknown;
      incidents?: unknown;
    };
    source.rawResponse = { secret: true };
    source.gpsHistory = [[1, 2]];
    source.incidents = [{ id: "live" }];
    const snapshot = createNavigationSessionSnapshot(input({ route: source, routes: [source] }));
    expect("rawResponse" in snapshot.route).toBe(false);
    expect("gpsHistory" in snapshot.route).toBe(false);
    expect("incidents" in snapshot.route).toBe(false);
    expect(snapshot.route.steps[0].instruction).toBe("Turn right");
  });

  it("round-trips a valid snapshot through JSON", () => {
    const original = createNavigationSessionSnapshot(input());
    const parsed = parseNavigationSessionSnapshot(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });

  it("rejects transit, unsupported modes, missing geometry, and empty steps", () => {
    const base = createNavigationSessionSnapshot(input());
    expect(parseNavigationSessionSnapshot({ ...base, kind: "transit" })).toBeNull();
    expect(parseNavigationSessionSnapshot({ ...base, mode: "transit" })).toBeNull();
    expect(
      parseNavigationSessionSnapshot({
        ...base,
        route: { ...base.route, geometry: [[0, 0]] },
        routes: [{ ...base.route, geometry: [[0, 0]] }],
        routeFingerprint: navigationSessionFingerprint({
          ...base,
          route: { ...base.route, geometry: [[0, 0]] },
        }),
      }),
    ).toBeNull();
    expect(
      parseNavigationSessionSnapshot({
        ...base,
        route: { ...base.route, steps: [] },
        routes: [{ ...base.route, steps: [] }],
      }),
    ).toBeNull();
  });

  it("rejects invalid alternatives, coordinates, and timestamps", () => {
    const base = createNavigationSessionSnapshot(input());
    expect(parseNavigationSessionSnapshot({ ...base, activeRouteIndex: 2 })).toBeNull();
    expect(
      parseNavigationSessionSnapshot({
        ...base,
        route: { ...base.route, geometry: [[Number.NaN, 0], ...base.route.geometry.slice(1)] },
      }),
    ).toBeNull();
    expect(
      parseNavigationSessionSnapshot({ ...base, startedAtMs: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(
      parseNavigationSessionSnapshot({ ...base, updatedAtMs: base.startedAtMs - 1 }),
    ).toBeNull();
  });

  it("rejects an unrecognized package id and an out-of-range progress value", () => {
    const base = createNavigationSessionSnapshot(input());
    expect(parseNavigationSessionSnapshot({ ...base, packageIds: ["old-area-id"] })).toBeNull();
    expect(
      parseNavigationSessionSnapshot({
        ...base,
        progress: { ...base.progress, speedMps: -1 },
      }),
    ).toBeNull();
  });

  it("expires after the bounded retention window", () => {
    const snapshot = createNavigationSessionSnapshot(input());
    expect(
      isNavigationSessionExpired(snapshot, snapshot.updatedAtMs + NAVIGATION_SESSION_MAX_AGE_MS),
    ).toBe(false);
    expect(
      isNavigationSessionExpired(
        snapshot,
        snapshot.updatedAtMs + NAVIGATION_SESSION_MAX_AGE_MS + 1,
      ),
    ).toBe(true);
  });

  it("preserves every optional nested route, leg, and step field through a round trip", () => {
    const original = createNavigationSessionSnapshot(richInput());
    expect(original.route.steps[0]).toEqual(richStep());
    expect(original.route.legs[0].summary).toBe("Main Street");
    expect(original.route.elevation).toEqual([10, 12, 14]);
    const parsed = parseNavigationSessionSnapshot(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });

  it.each(corruptions)("returns null for %s", (_name, corrupt) => {
    const snapshot = structuredClone(
      createNavigationSessionSnapshot(richInput()),
    ) as unknown as Record<string, unknown>;
    corrupt(snapshot);
    expect(parseNavigationSessionSnapshot(snapshot)).toBeNull();
  });

  it("returns null instead of throwing for hostile input", () => {
    const hostile = {
      get schemaVersion(): number {
        throw new Error("corrupt record");
      },
    };
    expect(parseNavigationSessionSnapshot(hostile)).toBeNull();
    expect(parseNavigationSessionSnapshot(undefined)).toBeNull();
    expect(parseNavigationSessionSnapshot("nav")).toBeNull();
    expect(parseNavigationSessionSnapshot([])).toBeNull();
  });

  it("reports one failure for input that cannot be copied at all", () => {
    expect(() =>
      createNavigationSessionSnapshot(input({ route: undefined as never })),
    ).toThrowError("cannot create an invalid navigation session snapshot");
    expect(() =>
      createNavigationSessionSnapshot(input({ destinationWaypoints: undefined as never })),
    ).toThrowError("cannot create an invalid navigation session snapshot");
  });

  it("fingerprints equivalent inputs identically and changes for route or destination changes", () => {
    const a = createNavigationSessionSnapshot(input());
    const b = createNavigationSessionSnapshot(input());
    expect(navigationSessionFingerprint(a)).toBe(navigationSessionFingerprint(b));
    expect(navigationSessionFingerprint({ ...a, route: route(10) })).not.toBe(
      navigationSessionFingerprint(a),
    );
    expect(
      navigationSessionFingerprint({ ...a, destinationWaypoints: [geometry[0], [13.5, 52.6]] }),
    ).not.toBe(navigationSessionFingerprint(a));
  });
});
