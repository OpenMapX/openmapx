// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  type BoundingBox,
  type LngLat,
  progressBucket,
  progressBucketStartMeters,
  type RoadAlert,
  type RoadAlertType,
  selectActiveAlert,
  snapToRoute,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PaddedRouteAheadBounds = typeof import("@openmapx/core").paddedRouteAheadBounds;

const fetchRoadAlerts = vi.fn();
const paddedRouteAheadBoundsSpy = vi.fn();
// Defaults to the real implementation (assigned inside the mock factory,
// where `actual` is in scope); a test may override `.impl` to force a
// synthetic — but still deterministic — box for a given window.
const paddedRouteAheadBoundsOverride: { impl: PaddedRouteAheadBounds | null } = { impl: null };
let countryValue: string | null | undefined;
// `vi.fn`'s implementation type in this repo's minimal vitest.d.ts stub is
// `(...args: unknown[]) => unknown`, so the real (origin, enabled) signature
// is recovered inside the body rather than declared on the parameter list.
const useCountryFromCoordinatesSpy = vi.fn((...args: unknown[]) => {
  const enabled = args[1] as boolean;
  return { data: enabled ? countryValue : undefined };
});

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchRoadAlerts: (...a: unknown[]) => fetchRoadAlerts(...a),
    paddedRouteAheadBounds: ((...a: Parameters<PaddedRouteAheadBounds>) => {
      paddedRouteAheadBoundsSpy(...a);
      const impl = paddedRouteAheadBoundsOverride.impl ?? actual.paddedRouteAheadBounds;
      return impl(...a);
    }) as PaddedRouteAheadBounds,
    useCountryFromCoordinates: (...a: [LngLat | null, boolean]) =>
      useCountryFromCoordinatesSpy(...a),
  };
});

import { useNavAlerts } from "./useNavAlerts";

const noIncidents: NavIncidentResource = {
  incidents: [],
  status: "disabled",
  routeIdentity: null,
  successfulRevision: 0,
};

// A straight ~2226 m east-west route at the equator.
const geometry: [number, number][] = [
  [0, 0],
  [0.02, 0],
];
function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    distance: 2226,
    duration: 200,
    geometry,
    legs: [],
    mode: "driving",
    steps: [{ instruction: "Head east", distance: 2226, duration: 200, coordinates: geometry }],
    ...overrides,
  } as unknown as Route;
}

function start(route: Route, alongMeters = 0, speedMps = 20) {
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(route, "driving", [geometry[0], geometry[1]]);
  useNavigationStore.getState().applyProgress({
    snapped: geometry[0],
    alongMeters,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: Date.now() + 60_000,
    bearing: 90,
    speedMps,
  } as never);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  fetchRoadAlerts.mockReset().mockResolvedValue([]);
  paddedRouteAheadBoundsSpy.mockReset();
  paddedRouteAheadBoundsOverride.impl = null;
  countryValue = undefined;
  useCountryFromCoordinatesSpy.mockClear();
  useNavigationStore.getState().stopNavigation();
  useSettingsStore.setState({ speedCameraAlerts: false, incidentAlerts: false });
});

afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  useSettingsStore.setState({ speedCameraAlerts: false, incidentAlerts: false });
});

describe("useNavAlerts — bounded ahead window", () => {
  it("queries a window keyed on the current progress bucket, not the whole route", async () => {
    // 40 km route so a bucket well past the start is meaningfully different
    // from "from the beginning".
    const longGeometry: [number, number][] = [
      [0, 0],
      [0.4, 0],
    ];
    const route = makeRoute({ distance: 44_500, geometry: longGeometry });
    start(route, 12_000);
    renderHook(() => useNavAlerts(noIncidents));
    await flush();

    const bucket = progressBucket(12_000);
    expect(bucket).toBeGreaterThan(0);
    const expectedStart = progressBucketStartMeters(bucket);
    const calls = paddedRouteAheadBoundsSpy.mock.calls;
    expect(calls.some((call) => call[0] === longGeometry && call[1] === expectedStart)).toBe(true);
    // Never the route-start-anchored call the old whole-route bbox used.
    expect(calls.some((call) => call[0] === longGeometry && call[1] === 0)).toBe(false);
  });

  it("splits an oversized window into subwindows instead of dropping every alert", async () => {
    // A synthetic box whose area scales with the requested lookahead: the full
    // 5.5 km window is oversized (1.1 deg²), one halving brings it under the
    // 0.6 deg² cap, so exactly two boxes should be queried.
    paddedRouteAheadBoundsOverride.impl = (
      _geometry: LngLat[],
      fromAlongMeters: number,
      lookaheadMeters: number,
    ): BoundingBox[] => {
      const west = fromAlongMeters / 1000;
      const east = west + lookaheadMeters / 5000;
      return [{ west, east, south: 0, north: 1 }];
    };
    const route = makeRoute();
    start(route, 0);

    fetchRoadAlerts.mockImplementation((...args: unknown[]) => {
      const box = args[0] as BoundingBox;
      // Only the second (further-along) subwindow's response carries this
      // alert, ~100 m ahead (well inside a stationary "stop" alert's ~120 m
      // approach window at 20 m/s) — it must still make it into the merged
      // result.
      if (box.west > 0) {
        return Promise.resolve([
          { id: "second-window", type: "stop", lat: 0, lng: 0.0009, speedLimitKmh: undefined },
        ]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    expect(fetchRoadAlerts).toHaveBeenCalledTimes(2);
    expect(result.current?.alert.id).toBe("second-window");
  });

  it("discards a stale response when the route changes mid-fetch", async () => {
    const routeA = makeRoute();
    start(routeA, 0);

    let releaseA: (v: unknown[]) => void = () => {};
    fetchRoadAlerts.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    const routeB = makeRoute({ distance: 3000 });
    fetchRoadAlerts.mockResolvedValue([{ id: "route-b-alert", type: "stop", lat: 0, lng: 0.01 }]);
    act(() => {
      useNavigationStore.getState().applyReroute(routeB);
    });
    rerender();
    await flush();

    // Route A's stale response arrives after route B's fetch has already
    // resolved; it must not overwrite route B's data.
    act(() => releaseA([{ id: "route-a-alert", type: "stop", lat: 0, lng: 0.01 }]));
    await flush();

    expect(result.current?.alert.id).not.toBe("route-a-alert");
  });
});

describe("useNavAlerts — prepared-matcher projection matches snapToRoute", () => {
  const route = makeRoute();

  function place(id: string, lat: number, lng = 0.01) {
    return { id, type: "stop" as const, lat, lng };
  }

  it("surfaces an on-route alert with the exact snapToRoute alongMeters", async () => {
    const alert = place("onroute", 0);
    const expected = snapToRoute(geometry, [alert.lng, alert.lat]);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([alert]);

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    expect(result.current?.alert.id).toBe("onroute");
    expect(result.current?.alert.alongMeters).toBeCloseTo(expected.alongMeters, 6);
    expect(result.current?.distanceMeters).toBeCloseTo(90, 6);
  });

  it("surfaces an alert just inside the 25 m deviation cutoff", async () => {
    const lat = 20 / 110_540; // ~20 m north of the line
    const alert = place("inside25", lat);
    const expected = snapToRoute(geometry, [alert.lng, alert.lat]);
    expect(expected.deviationMeters).toBeLessThan(25);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([alert]);

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    expect(result.current?.alert.id).toBe("inside25");
    expect(result.current?.alert.alongMeters).toBeCloseTo(expected.alongMeters, 6);
  });

  it("drops an alert just outside the 25 m deviation cutoff", async () => {
    const lat = 30 / 110_540; // ~30 m north of the line
    const alert = place("outside25", lat);
    const expected = snapToRoute(geometry, [alert.lng, alert.lat]);
    expect(expected.deviationMeters).toBeGreaterThan(25);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([alert]);

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    expect(result.current).toBeNull();
  });

  it("drops an alert far off the route", async () => {
    const lat = 1000 / 110_540; // ~1000 m north of the line
    const alert = place("faroff", lat);
    const expected = snapToRoute(geometry, [alert.lng, alert.lat]);
    expect(expected.deviationMeters).toBeGreaterThan(25);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([alert]);

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    expect(result.current).toBeNull();
  });

  it("resolves duplicate coordinates deterministically, matching snapToRoute's projection", async () => {
    const a = place("dupA", 0);
    const b = place("dupB", 0);
    const expected = snapToRoute(geometry, [a.lng, a.lat]);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([a, b]);

    const { result } = renderHook(() => useNavAlerts(noIncidents));
    await flush();

    // Same priority and distance: input order breaks the tie, matching
    // `selectActiveAlert`'s documented behaviour.
    expect(result.current?.alert.id).toBe("dupA");
    expect(result.current?.alert.alongMeters).toBeCloseTo(expected.alongMeters, 6);
  });
});

describe("useNavAlerts — speed-camera country gate", () => {
  const route = makeRoute();
  const camera = { id: "cam1", type: "speed_camera" as const, lat: 0, lng: 0.01 };

  beforeEach(() => {
    const expected = snapToRoute(geometry, [camera.lng, camera.lat]);
    start(route, expected.alongMeters - 90, 20);
    fetchRoadAlerts.mockResolvedValue([camera]);
  });

  it("does not query the country while the setting is off", async () => {
    renderHook(() => useNavAlerts(noIncidents));
    await flush();
    const lastCall = useCountryFromCoordinatesSpy.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(false);
  });

  it("blocks the camera until the country resolves, then applies the correct region rule", async () => {
    const { result, rerender } = renderHook(() => useNavAlerts(noIncidents));
    await flush();
    expect(result.current).toBeNull(); // setting off: camera never shown

    // Toggle on mid-drive; the country hasn't resolved yet.
    act(() => useSettingsStore.setState({ speedCameraAlerts: true }));
    rerender();
    expect(result.current).toBeNull();

    // Resolves to a restricted country: still blocked.
    countryValue = "de";
    rerender();
    expect(result.current).toBeNull();

    // Resolves to a permitted country: now surfaced.
    countryValue = "us";
    rerender();
    expect(result.current?.alert.id).toBe("cam1");
  });
});

describe("useNavAlerts — approach-window constant tracks the real maximum", () => {
  // Must mirror `MAX_APPROACH_M` in useNavAlerts.ts. `APPROACH` in
  // packages/core/src/navigation/alerts.ts is private, so it can't be
  // imported directly; probing `selectActiveAlert`'s own public behaviour
  // is the only way to observe its real numbers without duplicating them.
  const MAX_APPROACH_M = 500;
  // Every type the OSM alert endpoint can actually emit — see
  // `mapAlertElements` in integrations/routing/index.ts. `traffic_incident`
  // is excluded: it never comes from this endpoint (it arrives via the
  // road-conditions capability instead), and `pedestrian_crossing`/`tunnel`
  // are part of the shared `RoadAlertType` union but are never produced
  // here either.
  const OSM_ALERT_TYPES: RoadAlertType[] = [
    "speed_camera",
    "railway_crossing",
    "stop",
    "traffic_calming",
  ];
  // Large enough that `min(max(speed * leadSec, minM), maxM)` clamps to
  // `maxM` for every type in the table, regardless of `leadSec`.
  const HUGE_SPEED_MPS = 100_000;

  it("never lets a real approach window exceed the hook's fetch-window constant", () => {
    for (const type of OSM_ALERT_TYPES) {
      const alert: RoadAlert = {
        id: `probe-${type}`,
        type,
        coord: [0, 0],
        alongMeters: MAX_APPROACH_M + 1,
      };
      // If `alerts.ts` ever widens this type's `maxM` past the constant,
      // this starts resolving to the probe alert instead of null.
      const result = selectActiveAlert([alert], 0, HUGE_SPEED_MPS, []);
      expect(result).toBeNull();
    }
  });
});
