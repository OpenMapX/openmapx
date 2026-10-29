// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import {
  type FixInput,
  type IncidentAlert,
  type RouteStep,
  readRouteMatcherCounters,
  remainingWaypoints,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { createTranslator } from "@openmapx/i18n";
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
    kind: "closure",
    eventType: "closure",
    severity: "major",
    origin: "feed",
    headline: [{ lang: "en", text: `closure ${id}` }],
    closesRoad: true,
    geometry: { type: "Point", coordinates: [0.002, 0] },
    approach: { leadSec: 20, minM: 400, maxM: 1500 },
  };
}

let locale = "en";

vi.mock("next-intl", () => ({
  useTranslations: () => createTranslator(locale, "navigation"),
  useLocale: () => locale,
}));

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("../useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
const speak = vi.fn();
vi.mock("./useNavigationVoice", () => ({ useNavigationVoice: () => speak }));
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

function offRouteFixes(timestampOffset = 0): FixInput[] {
  return [
    { coords: [0.001, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 1000 },
    { coords: [0.0012, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 2000 },
    { coords: [0.0014, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 3000 },
    { coords: [0.0016, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 4000 },
    { coords: [0.0018, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 5000 },
    { coords: [0.002, 0.002], accuracy: 5, speed: 15, timestampMs: timestampOffset + 6000 },
  ];
}

async function triggerOffRoute(timestampOffset = 0): Promise<FixInput[]> {
  const fixes = offRouteFixes(timestampOffset);
  await act(async () => {
    for (const fix of fixes) fixHandler?.(fix);
    await Promise.resolve();
    await Promise.resolve();
  });
  return fixes;
}

describe("useNavigationEngine", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    // Live road-conditions polling writes to the store from a resolved promise,
    // which would otherwise sprinkle unrelated publications over a fix.
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    fixHandler = null;
    fetchDirections.mockReset();
    speak.mockClear();
    locale = "en";
    useNavigationStore.setState({ voiceEnabled: true });
    useSettingsStore.setState({ units: "metric" });
  });

  function speakManeuver(step: Partial<RouteStep>, longitude = 0.0011) {
    const withSpeech = { ...route, steps: [route.steps[0], { ...route.steps[1], ...step }] };
    useNavigationStore.getState().startGroundNavigation(withSpeech, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    renderHook(() => useNavigationEngine(disabledResource));
    act(() => fixHandler?.({ coords: [longitude, 0], accuracy: 5, speed: 0, timestampMs: 1000 }));
    return useNavigationStore.getState().progress;
  }

  it.each([
    ["en", "metric", "In 100 metres, Advance alert"],
    ["de", "metric", "In 100 Meter, Advance alert"],
    ["en", "imperial", "In 350 feet, Advance alert"],
    ["de", "imperial", "In 350 Fuß, Advance alert"],
  ] as const)("formats advance speech in %s with %s units", (language, units, expected) => {
    locale = language;
    useSettingsStore.setState({ units });
    speakManeuver({
      instruction: "Written",
      verbalAlert: "Advance alert",
      verbalPre: "Pre-transition",
      verbalSuccinct: "Succinct",
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(expected);
  });

  it("speaks pre-transition text without distance at the imminent turn", () => {
    speakManeuver(
      { instruction: "Written", verbalAlert: "Alert", verbalPre: "Pre-transition" },
      0.0018,
    );
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith("Pre-transition");
  });

  it.each([
    [
      { instruction: "Written", verbalAlert: " ", verbalPre: "  Pre-transition  " },
      "In 100 metres, Pre-transition",
    ],
    [{ instruction: "Written", verbalAlert: 42, verbalPre: null }, "In 100 metres, Written"],
  ] as const)("skips malformed or blank verbal fields", (step, expected) => {
    speakManeuver(step as Partial<RouteStep>);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(expected);
  });

  it.each(["", "   ", "x".repeat(241)])(
    "preserves navigation progression without unusable speech",
    (instruction) => {
      const progress = speakManeuver({ instruction });
      expect(progress?.currentStepIndex).toBe(0);
      expect(speak).not.toHaveBeenCalled();
    },
  );

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
    const offFixes = await triggerOffRoute();
    expect(fetchDirections).toHaveBeenCalled();
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        // The fifth fix reaches the score threshold. A reroute must start at
        // that raw GPS position, not its projection onto the obsolete route.
        waypoints: [offFixes[4].coords, [0.004, 0]],
        avoidClosures: false,
      }),
    );
    expect(useNavigationStore.getState().route?.distance).toBe(999);
  });

  it("adopts the captured remaining itinerary and cannot resurrect visited stops", async () => {
    const a: [number, number] = [0.001, 0];
    const b: [number, number] = [0.003, 0];
    const destination: [number, number] = [0.004, 0];
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", [[0, 0], a, b, destination]);
    const replacement = { ...route, geometry: [[0.0018, 0.002], b, destination] } as Route;
    fetchDirections.mockResolvedValue({ routes: [replacement], activeRouteIndex: 0 });
    renderHook(() => useNavigationEngine(disabledResource));
    const fixes = await triggerOffRoute();
    const captured = [fixes[4].coords, b, destination];
    expect(fetchDirections).toHaveBeenCalledWith(expect.objectContaining({ waypoints: captured }));
    const state = useNavigationStore.getState();
    expect(state.destinationWaypoints).toEqual(captured);
    expect(state.progress).toBeNull();
    expect(
      remainingWaypoints(replacement.geometry, state.destinationWaypoints, [0.002, 0.002], 0),
    ).toEqual([[0.002, 0.002], b, destination]);
  });

  it("keeps the old route and suppresses directions while offline", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    useNavigationStore.getState().setConnectivity("offline");
    renderHook(() => useNavigationEngine(disabledResource));
    await triggerOffRoute();
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
    await triggerOffRoute();
    expect(fetchDirections).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().route?.distance).toBe(1111);
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(false);
  });

  it("returns to the old route state after a network failure", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    fetchDirections.mockRejectedValue(new TypeError("Failed to fetch"));
    renderHook(() => useNavigationEngine(disabledResource));

    await triggerOffRoute();

    const state = useNavigationStore.getState();
    expect(state.status).toBe("navigating");
    expect(state.route).toBe(route);
    expect(state.destinationWaypoints).toEqual([
      [0, 0],
      [0.004, 0],
    ]);
    expect(state.rerouteFailedNonce).toBe(1);
    expect(state.rerouteUnavailable).toBe(true);
  });

  it("ignores a reroute that completes after navigation stops", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    let resolveResponse: (response: { routes: Route[]; activeRouteIndex: number }) => void =
      () => {};
    fetchDirections.mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    renderHook(() => useNavigationEngine(disabledResource));

    await triggerOffRoute();
    act(() => useNavigationStore.getState().stopNavigation());
    await act(async () => {
      resolveResponse({ routes: [{ ...route, distance: 999 } as Route], activeRouteIndex: 0 });
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().status).toBe("idle");
    expect(useNavigationStore.getState().route).toBeNull();
  });

  it("ignores a reroute that completes after the engine unmounts", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    let resolveResponse: (response: { routes: Route[]; activeRouteIndex: number }) => void =
      () => {};
    fetchDirections.mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const { unmount } = renderHook(() => useNavigationEngine(disabledResource));

    await triggerOffRoute();
    unmount();
    await act(async () => {
      resolveResponse({ routes: [{ ...route, distance: 999 } as Route], activeRouteIndex: 0 });
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().status).toBe("navigating");
    expect(useNavigationStore.getState().route).toBe(route);
    expect(useNavigationStore.getState().destinationWaypoints).toEqual([
      [0, 0],
      [0.004, 0],
    ]);
  });

  it("cannot replace the itinerary after another route wins", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    let resolveResponse: (response: { routes: Route[]; activeRouteIndex: number }) => void =
      () => {};
    fetchDirections.mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    renderHook(() => useNavigationEngine(disabledResource));
    await triggerOffRoute();
    const captured: [number, number][] = [
      [0.003, 0.002],
      [0.004, 0],
    ];
    const replacement = { ...route, geometry: captured } as Route;
    act(() =>
      useNavigationStore
        .getState()
        .applyReroute(replacement, undefined, undefined, undefined, captured),
    );
    await act(async () => {
      resolveResponse({ routes: [{ ...route, distance: 999 } as Route], activeRouteIndex: 0 });
    });
    expect(useNavigationStore.getState().route).toBe(replacement);
    expect(useNavigationStore.getState().destinationWaypoints).toEqual(captured);
  });

  it("suppresses concurrent reroute attempts", async () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [0.004, 0],
    ]);
    let resolveResponse: (response: { routes: Route[]; activeRouteIndex: number }) => void =
      () => {};
    fetchDirections.mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    renderHook(() => useNavigationEngine(disabledResource));

    await triggerOffRoute();
    await triggerOffRoute(10_000);
    expect(fetchDirections).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResponse({ routes: [{ ...route, distance: 999 } as Route], activeRouteIndex: 0 });
      await Promise.resolve();
    });
  });

  it("enters a cooldown after three successful reroutes in the churn window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.004, 0],
      ]);
      fetchDirections.mockImplementation(async () => ({
        routes: [{ ...route, distance: 500 + fetchDirections.mock.calls.length } as Route],
        activeRouteIndex: 0,
      }));
      renderHook(() => useNavigationEngine(disabledResource));

      await triggerOffRoute();
      await triggerOffRoute(10_000);
      await triggerOffRoute(20_000);
      expect(fetchDirections).toHaveBeenCalledTimes(3);

      await triggerOffRoute(30_000);
      expect(fetchDirections).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
    speak.mockClear();
    locale = "en";
    useNavigationStore.setState({ voiceEnabled: true });
    useSettingsStore.setState({ units: "metric" });
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
    speak.mockClear();
    locale = "en";
    useNavigationStore.setState({ voiceEnabled: true });
    useSettingsStore.setState({ units: "metric" });
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

  it("keeps navigation active when coasting enters the arrival range", () => {
    vi.useFakeTimers();
    try {
      useNavigationStore.getState().startGroundNavigation(freshRoute(), "driving", waypoints);
      renderHook(() => useNavigationEngine(disabledResource));
      act(() => {
        fixHandler?.({ coords: [0.001, 0], accuracy: 5, speed: 15, timestampMs: Date.now() });
      });

      act(() => vi.advanceTimersByTime(30_000));
      const estimated = useNavigationStore.getState();
      expect(estimated.progress?.distanceRemaining).toBeLessThan(35);
      expect(estimated.coasting).toBe(true);
      expect(estimated.status).toBe("navigating");

      act(() => {
        fixHandler?.({ coords: [0.004, 0], accuracy: 5, timestampMs: Date.now() });
      });
      expect(useNavigationStore.getState().status).toBe("arrived");
      expect(useNavigationStore.getState().coasting).toBe(false);
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
    speak.mockClear();
    locale = "en";
    useNavigationStore.setState({ voiceEnabled: true });
    useSettingsStore.setState({ units: "metric" });
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

  it.each([1500, 2500])(
    "retains ordered retraced stops in a closure replacement at %im",
    async (alongMeters) => {
      const origin: [number, number] = [0, 0];
      const a: [number, number] = [0.02, 0];
      const b: [number, number] = [0.01, 0];
      const destination: [number, number] = [0.03, 0];
      const from: [number, number] = [0.0175, 0];
      const retraced = { ...route, geometry: [origin, b, a, b, destination] } as Route;
      const captured = alongMeters === 1500 ? [from, a, b, destination] : [from, b, destination];
      const replacement = { ...route, geometry: captured } as Route;
      fetchDirections.mockResolvedValue({ routes: [replacement], activeRouteIndex: 0 });
      useNavigationStore
        .getState()
        .startGroundNavigation(retraced, "driving", [origin, a, b, destination]);
      const { rerender } = renderHook(({ resource }) => useNavigationEngine(resource), {
        initialProps: { resource: resourceWith({ status: "fresh", successfulRevision: 1 }) },
      });
      act(() =>
        useNavigationStore.getState().applyProgress({ snapped: from, alongMeters } as never),
      );
      await act(async () => {
        rerender({
          resource: resourceWith({
            status: "fresh",
            successfulRevision: 2,
            incidents: [closureIncident("future-closure")],
          }),
        });
      });
      expect(fetchDirections).toHaveBeenCalledWith(
        expect.objectContaining({ waypoints: captured, avoidClosures: true }),
      );
      expect(useNavigationStore.getState().destinationWaypoints).toEqual(captured);
      expect(useNavigationStore.getState().route).toBe(replacement);
      expect(
        remainingWaypoints(
          replacement.geometry,
          useNavigationStore.getState().destinationWaypoints,
          from,
          0,
        ),
      ).toEqual(captured);
    },
  );

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
