import { describe, expect, it } from "vitest";
import type { NavigationRouteOptions } from "../stores/navigationStore";
import type { Route } from "../types/routing";
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
    packageIds: [`omp1-${"a".repeat(64)}`],
    startedAtMs: 1_000_000_000,
    updatedAtMs: 1_000_010_000,
    ...overrides,
  };
}

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
