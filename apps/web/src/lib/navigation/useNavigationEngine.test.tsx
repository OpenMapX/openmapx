// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  type FixInput,
  type IncidentAlert,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import type { NavIncidentResource } from "@openmapx/integration-framework/react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationEngine } from "./useNavigationEngine";

/** No live incident data — most of this file exercises fix/reroute plumbing unrelated to it. */
const disabledResource: NavIncidentResource = {
  incidents: [],
  status: "disabled",
  routeIdentity: null,
  successfulRevision: 0,
};

function resourceWith(overrides: Partial<NavIncidentResource>): NavIncidentResource {
  return { ...disabledResource, ...overrides };
}

function closureIncident(id: string): IncidentAlert {
  return {
    id,
    type: "traffic_incident",
    coord: [0.002, 0],
    alongMeters: 200,
    eventType: "road_closure",
    severity: "high",
    headline: `closure ${id}`,
    geometry: { type: "Point", coordinates: [0.002, 0] },
    approach: { leadSec: 20, minM: 400, maxM: 1500 },
  };
}

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
vi.mock("./useNavigationVoice", () => ({ useNavigationVoice: () => vi.fn() }));
const fetchDirections = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, fetchDirections: (...a: unknown[]) => fetchDirections(...a) };
});

const geometry: [number, number][] = [
  [0, 0],
  [0.002, 0],
  [0.004, 0],
];
const route = {
  distance: 444,
  duration: 60,
  geometry,
  legs: [],
  mode: "driving",
  steps: [
    { instruction: "Head east", distance: 222, duration: 30, coordinates: geometry.slice(0, 2) },
    { instruction: "Arrive", distance: 222, duration: 30, coordinates: geometry.slice(1, 3) },
  ],
} as unknown as Route;

describe("useNavigationEngine", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    // Live road-conditions polling writes to the store from a resolved promise,
    // which would otherwise sprinkle unrelated publications over a fix.
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
  });

  it("writes progress to the store on each on-route fix", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    renderHook(() => useNavigationEngine(disabledResource));
    act(() => fixHandler?.({ coords: [0.001, 0], accuracy: 5, timestampMs: 1000 }));
    expect(useNavigationStore.getState().progress?.currentStepIndex).toBe(0);
  });

  it("requests a reroute and applies the new route when off-route", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    const route2 = { ...route, distance: 999 } as Route;
    fetchDirections.mockResolvedValue({ routes: [route2], activeRouteIndex: 0 });
    renderHook(() => useNavigationEngine(disabledResource));
    // Enough moving, off-route fixes (each ~222 m off the line) to accrue the
    // off-route score past the reroute threshold. They advance east, parallel to
    // the route, so this reads as a deviation rather than a wrong-way turn.
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const f of offFixes) fixHandler?.(f);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalled();
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        // The fifth fix reaches the score threshold. A reroute must start at
        // that raw GPS position, not its projection onto the obsolete route.
        waypoints: [offFixes[4].coords, [0.004, 0]],
      }),
    );
    expect(useNavigationStore.getState().route?.distance).toBe(999);
  });

  it("keeps the old route and suppresses directions while offline", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    useNavigationStore.getState().setConnectivity("offline");
    renderHook(() => useNavigationEngine(disabledResource));
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const fix of offFixes) fixHandler?.(fix);
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalledTimes(0);
    expect(useNavigationStore.getState().route?.distance).toBe(444);
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(true);
    expect(useNavigationStore.getState().status).toBe("navigating");
  });

  it("allows one deliberate retry after connectivity returns", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    useNavigationStore.getState().setConnectivity("online");
    useNavigationStore.getState().setRerouteUnavailable(true);
    useNavigationStore.getState().requestRerouteRetry();
    const route2 = { ...route, distance: 1111 } as Route;
    fetchDirections.mockResolvedValue({ routes: [route2], activeRouteIndex: 0 });
    renderHook(() => useNavigationEngine(disabledResource));
    const offFixes: FixInput[] = [
      { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: 1000 },
      { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: 2000 },
      { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: 3000 },
      { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: 4000 },
      { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: 5000 },
      { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: 6000 },
    ];
    await act(async () => {
      for (const fix of offFixes) fixHandler?.(fix);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchDirections).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().route?.distance).toBe(1111);
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(false);
  });
});

describe("useNavigationEngine fix publications", () => {
  const waypoints: [number, number][] = [
    [0, 0],
    [0.004, 0],
  ];
  // On the first geometry segment, ~111 m along the route.
  const onRouteFix: FixInput = { coords: [0.001, 0], accuracy: 5, timestampMs: 1000 };

  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
  });

  /** Deliver one fix and report how many times the store notified subscribers. */
  function publicationsForFix(fix: FixInput): number {
    let count = 0;
    const unsubscribe = useNavigationStore.subscribe(() => {
      count += 1;
    });
    act(() => fixHandler?.(fix));
    unsubscribe();
    return count;
  }

  it("publishes one combined update for an accepted driving fix", () => {
    const limited = { ...route, segmentSpeedLimits: [50, 70] } as Route;
    useNavigationStore.getState().startGroundNavigation(limited, "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));

    expect(publicationsForFix(onRouteFix)).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.progress?.currentStepIndex).toBe(0);
    expect(s.weakGps).toBe(false);
    expect(s.offRoute).toBe(false);
    expect(s.currentSpeedLimit).toBe(50);
    expect(s.coasting).toBe(false);
  });

  it("falls back to the live map-matched speed limit", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));
    useNavigationStore.getState().setLiveSpeedLimits([80, 100]);

    expect(publicationsForFix(onRouteFix)).toBe(1);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(80);
  });

  it("falls back to the step speed limit when nothing is indexed by segment", () => {
    const stepLimited = {
      ...route,
      steps: [{ ...route.steps[0], speedLimit: 30 }, route.steps[1]],
    } as Route;
    useNavigationStore.getState().startGroundNavigation(stepLimited, "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));

    expect(publicationsForFix(onRouteFix)).toBe(1);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(30);
  });

  it("clears the speed limit for walking in that same update", () => {
    const limited = { ...route, segmentSpeedLimits: [50, 70] } as Route;
    useNavigationStore.getState().startGroundNavigation(limited, "walking", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));
    useNavigationStore.getState().setSpeedLimit(99);

    expect(publicationsForFix(onRouteFix)).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.currentSpeedLimit).toBeNull();
    expect(s.progress?.currentStepIndex).toBe(0);
  });

  it("keeps coasting alive for a coasted fix, and one publication", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));
    useNavigationStore.getState().setCoasting(true);

    expect(publicationsForFix({ ...onRouteFix, coasted: true })).toBe(1);
    const s = useNavigationStore.getState();
    expect(s.coasting).toBe(true);
    expect(s.progress?.alongMeters).toBeGreaterThan(0);
  });

  it("keeps the last progress on an accuracy-rejected fix and stops republishing", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));
    act(() => fixHandler?.(onRouteFix));
    const accepted = useNavigationStore.getState().progress;

    // Way past the driving accuracy cap, so the fix never becomes progress.
    const rejected: FixInput = { coords: [0.0015, 0], accuracy: 500, timestampMs: 2000 };
    expect(publicationsForFix(rejected)).toBe(1);
    expect(useNavigationStore.getState().weakGps).toBe(true);
    expect(useNavigationStore.getState().progress).toBe(accepted);

    // Weak GPS is already flagged; a second bad fix must not publish again.
    expect(publicationsForFix({ ...rejected, timestampMs: 3000 })).toBe(0);
    expect(useNavigationStore.getState().progress).toBe(accepted);
  });
});

describe("useNavigationEngine route index ownership", () => {
  const waypoints: [number, number][] = [
    [0, 0],
    [0.004, 0],
  ];

  // A fresh geometry array per route, so the index is genuinely built for it
  // rather than served from the factory's identity cache by an earlier test.
  const freshRoute = (): Route => {
    const geom: [number, number][] = [
      [0, 0],
      [0.002, 0],
      [0.004, 0],
    ];
    return { ...route, geometry: geom } as Route;
  };

  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });

  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
  });

  it("indexes the active route once for a whole run of fixes", () => {
    useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));

    act(() => {
      for (let i = 1; i <= 12; i++) {
        fixHandler?.({ coords: [0.0002 * i, 0], accuracy: 5, speed: 12, timestampMs: 1000 * i });
      }
    });

    const counters = readRouteMatcherCounters();
    expect(counters.preparations).toBe(1);
    // One snap per accepted fix, all against that single index.
    expect(counters.snaps).toBe(12);
  });

  it("keeps the same index through a 4 Hz coast", () => {
    vi.useFakeTimers();
    try {
      useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
      renderHook(() => useNavigationEngine(disabledResource));
      act(() => {
        fixHandler?.({ coords: [0.0005, 0], accuracy: 5, speed: 12, timestampMs: Date.now() });
      });
      const afterRealFix = readRouteMatcherCounters().snaps;

      // Past the coast start delay, then two seconds of synthetic 4 Hz fixes.
      act(() => vi.advanceTimersByTime(3_500));
      act(() => vi.advanceTimersByTime(2_000));

      const counters = readRouteMatcherCounters();
      expect(counters.preparations).toBe(1);
      expect(useNavigationStore.getState().coasting).toBe(true);
      expect(counters.snaps).toBeGreaterThanOrEqual(afterRealFix + 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("indexes the replacement route exactly once after a reroute", () => {
    useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
    renderHook(() => useNavigationEngine(disabledResource));
    act(() => {
      fixHandler?.({ coords: [0.0005, 0], accuracy: 5, speed: 12, timestampMs: 1000 });
    });
    expect(readRouteMatcherCounters().preparations).toBe(1);

    act(() => useNavigationStore.getState().applyReroute(freshRoute()));
    act(() => {
      for (let i = 1; i <= 6; i++) {
        fixHandler?.({ coords: [0.0002 * i, 0], accuracy: 5, speed: 12, timestampMs: 2000 + i });
      }
    });

    expect(readRouteMatcherCounters().preparations).toBe(2);
  });
});

describe("useNavigationEngine incident-resource baseline", () => {
  const waypoints: [number, number][] = [
    [0, 0],
    [0.004, 0],
  ];

  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true });
    fixHandler = null;
    fetchDirections.mockReset();
    fetchDirections.mockResolvedValue({ routes: [route], activeRouteIndex: 0 });
  });

  afterEach(() => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
  });

  it("arms the baseline on the first fresh revision without rerouting for closures already present", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    const { rerender } = renderHook(({ resource }) => useNavigationEngine(resource), {
      initialProps: { resource: resourceWith({ status: "loading" }) },
    });
    act(() => fixHandler?.({ coords: [0.001, 0], accuracy: 5, speed: 10, timestampMs: 1000 }));

    rerender({
      resource: resourceWith({
        status: "fresh",
        successfulRevision: 1,
        incidents: [closureIncident("c1")],
      }),
    });

    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("reroutes once a later fresh revision reveals a genuinely new closure", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    const { rerender } = renderHook(({ resource }) => useNavigationEngine(resource), {
      initialProps: {
        resource: resourceWith({
          status: "fresh",
          successfulRevision: 1,
          incidents: [closureIncident("c1")],
        }),
      },
    });
    act(() => fixHandler?.({ coords: [0.001, 0], accuracy: 5, speed: 10, timestampMs: 1000 }));

    rerender({
      resource: resourceWith({
        status: "fresh",
        successfulRevision: 2,
        incidents: [closureIncident("c1"), closureIncident("c2")],
      }),
    });

    expect(fetchDirections).toHaveBeenCalledWith(expect.objectContaining({ avoidClosures: true }));
  });

  it("a stale revision never arms an empty baseline nor triggers a reroute", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
    const { rerender } = renderHook(({ resource }) => useNavigationEngine(resource), {
      initialProps: { resource: resourceWith({ status: "loading" }) },
    });
    act(() => fixHandler?.({ coords: [0.001, 0], accuracy: 5, speed: 10, timestampMs: 1000 }));

    // A stale revision surfaces an incident before any fetch has succeeded —
    // must not be mistaken for the baseline, and must not fire a reroute either.
    rerender({ resource: resourceWith({ status: "stale", incidents: [closureIncident("c1")] }) });
    expect(fetchDirections).not.toHaveBeenCalled();

    // The first genuinely fresh revision arms the baseline INCLUDING that
    // closure, since it's present at the moment the baseline is captured.
    rerender({
      resource: resourceWith({
        status: "fresh",
        successfulRevision: 1,
        incidents: [closureIncident("c1")],
      }),
    });
    expect(fetchDirections).not.toHaveBeenCalled();
  });
});
