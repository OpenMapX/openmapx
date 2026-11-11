import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remainingWaypoints } from "../navigation/reroute";
import type { TransitProgress } from "../navigation/transitProgress";
import type { NavProgress } from "../navigation/types";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import type { LngLat } from "../types/geometry";
import type { RoadConditionRouteImpact, Route } from "../types/routing";
import type { NativeNavigationProjection } from "./navigationStore";
import { useNavigationStore } from "./navigationStore";

function makeMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key) ?? null,
    setString: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const itinerary = {
  duration: 1800,
  startTime: "2026-06-01T10:00:00Z",
  endTime: "2026-06-01T10:30:00Z",
  transfers: 1,
  walkDistance: 200,
  legs: [],
} as TripItinerary;

const route = {
  distance: 100,
  duration: 10,
  geometry: [[0, 0]],
  legs: [],
  mode: "driving",
  steps: [],
} as unknown as Route;

describe("navigationStore", () => {
  beforeEach(() => useNavigationStore.getState().stopNavigation());
  afterEach(() => vi.useRealTimers());

  it("expires the held route's current road-condition assessment at its lease boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    useNavigationStore.getState().startGroundNavigation(
      route,
      "driving",
      [
        [0, 0],
        [1, 1],
      ],
      [],
      "routing-valhalla",
      {
        roadConditionImpact: {
          availability: "current",
          evaluatedAt: "2026-09-12T12:00:00Z",
          validUntil: "2026-09-12T12:00:01Z",
          reasons: [],
        },
      },
    );

    expect(useNavigationStore.getState().roadConditionImpact?.availability).toBe("current");
    vi.advanceTimersByTime(1_000);

    expect(useNavigationStore.getState().roadConditionImpact).toMatchObject({
      availability: "expired",
      reasons: ["evidence_expired"],
    });
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  });

  it("drops the previous route assessment when accepting a faster route without one", () => {
    useNavigationStore.getState().startGroundNavigation(
      route,
      "driving",
      [
        [0, 0],
        [1, 1],
      ],
      [],
      "routing-valhalla",
      {
        roadConditionImpact: {
          availability: "limited",
          evaluatedAt: "2026-09-12T12:00:00Z",
          validUntil: null,
          reasons: ["planned_closure_on_route"],
        },
      },
    );
    useNavigationStore.getState().proposeFasterRoute({
      route: { ...route, duration: 5 },
      alternatives: [],
      savedSeconds: 5,
      proposedAtMs: Date.now(),
    });

    useNavigationStore.getState().acceptFasterRoute();

    expect(useNavigationStore.getState().roadConditionImpact).toBeNull();
  });

  it("carries alternatives and switches the active route", () => {
    const alt = { ...route, distance: 555 } as Route;
    const store = useNavigationStore.getState();
    store.startGroundNavigation(
      route,
      "driving",
      [
        [0, 0],
        [1, 1],
      ],
      [alt],
    );
    expect(useNavigationStore.getState()).toMatchObject({
      status: "navigating",
      mode: "driving",
      cameraMode: "follow",
      route,
    });
    expect(useNavigationStore.getState().routes).toHaveLength(2);
    expect(useNavigationStore.getState().activeRouteIndex).toBe(0);

    store.applyProgress({ alongMeters: 42 } as NavProgress);
    store.selectRoute(1);
    const s = useNavigationStore.getState();
    expect(s.activeRouteIndex).toBe(1);
    expect(s.route?.distance).toBe(555);
    expect(s.progress).toBeNull(); // stale progress dropped on switch

    // Out-of-range / same-index selections are no-ops.
    store.selectRoute(1);
    expect(useNavigationStore.getState().activeRouteIndex).toBe(1);
    store.selectRoute(9);
    expect(useNavigationStore.getState().activeRouteIndex).toBe(1);
  });

  it("addStop swaps in the through-route and persists the new waypoints", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.applyProgress({ alongMeters: 10 } as NavProgress);
    const viaRoute = { ...route, distance: 321 } as Route;
    const newWaypoints: [number, number][] = [
      [0.2, 0.2],
      [0.5, 0.5],
      [1, 1],
    ];
    store.addStop(viaRoute, newWaypoints);
    const s = useNavigationStore.getState();
    expect(s.status).toBe("navigating");
    expect(s.route?.distance).toBe(321);
    expect(s.destinationWaypoints).toEqual(newWaypoints);
    expect(s.progress).toBeNull();
  });

  it("atomically pairs a reroute with the requested remaining itinerary", () => {
    const original: LngLat[] = [
      [0, 0],
      [0.02, 0],
      [0.01, 0],
      [0.03, 0],
    ];
    const captured: LngLat[] = [
      [0.0175, 0],
      [0.01, 0],
      [0.03, 0],
    ];
    const replacement = { ...route, geometry: captured } as Route;
    useNavigationStore.getState().startGroundNavigation(route, "driving", original);
    const seen: LngLat[][] = [];
    const unsubscribe = useNavigationStore.subscribe((state) => {
      if (state.route === replacement) seen.push(state.destinationWaypoints);
    });
    useNavigationStore
      .getState()
      .applyReroute(replacement, undefined, undefined, undefined, captured);
    unsubscribe();
    expect(seen).toEqual([captured]);
    expect(
      remainingWaypoints(
        replacement.geometry,
        useNavigationStore.getState().destinationWaypoints,
        [0.017, 0],
        0,
      ),
    ).toEqual([
      [0.017, 0],
      [0.01, 0],
      [0.03, 0],
    ]);
    expect(original).toEqual([
      [0, 0],
      [0.02, 0],
      [0.01, 0],
      [0.03, 0],
    ]);
  });

  it("applyReroute swaps the route and returns to navigating", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    // Stale progress from the old route must not survive the swap.
    store.applyProgress({ alongMeters: 5000 } as NavProgress);
    store.beginReroute();
    expect(useNavigationStore.getState().status).toBe("rerouting");
    const route2 = { ...route, distance: 200 } as Route;
    store.applyReroute(route2);
    expect(useNavigationStore.getState().status).toBe("navigating");
    expect(useNavigationStore.getState().route?.distance).toBe(200);
    expect(useNavigationStore.getState().destinationWaypoints).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(useNavigationStore.getState().progress).toBeNull();
  });

  it("completeArrival then stop resets", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.completeArrival();
    expect(useNavigationStore.getState().status).toBe("arrived");
    store.stopNavigation();
    expect(useNavigationStore.getState().status).toBe("idle");
    expect(useNavigationStore.getState().route).toBeNull();
  });

  it("setCameraMode toggles follow/free", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.setCameraMode("free");
    expect(useNavigationStore.getState().cameraMode).toBe("free");
  });

  it("starts transit navigation and resets ground bits", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.startTransitNavigation(itinerary);
    const s = useNavigationStore.getState();
    expect(s.status).toBe("navigating");
    expect(s.kind).toBe("transit");
    expect(s.itinerary).toBe(itinerary);
    expect(s.route).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.transitProgress).toBeNull();
  });

  it("stopNavigation resets kind/itinerary/transitProgress", () => {
    const store = useNavigationStore.getState();
    store.startTransitNavigation(itinerary);
    store.applyTransitProgress({
      currentLegIndex: 0,
      snapped: [0, 0],
      fractionAlongLeg: 0,
      deviationMeters: 0,
      arrived: false,
      phase: "walking",
    });
    expect(useNavigationStore.getState().transitProgress?.phase).toBe("walking");
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    expect(useNavigationStore.getState()).toMatchObject({
      kind: "ground",
      itinerary: null,
      transitProgress: null,
    });
    store.startTransitNavigation(itinerary);
    store.applyTransitProgress({
      currentLegIndex: 1,
      snapped: [1, 2],
      fractionAlongLeg: 0.5,
      deviationMeters: 12,
      arrived: false,
      phase: "riding",
    });
    expect(useNavigationStore.getState().transitProgress?.phase).toBe("riding");
    store.stopNavigation();
    const s = useNavigationStore.getState();
    expect(s.status).toBe("idle");
    expect(s.kind).toBe("ground");
    expect(s.itinerary).toBeNull();
    expect(s.transitProgress).toBeNull();
  });

  it("updateItinerary swaps the itinerary but keeps progress; replaceItinerary clears it", () => {
    const store = useNavigationStore.getState();
    store.startTransitNavigation(itinerary);
    const tp: TransitProgress = {
      currentLegIndex: 1,
      snapped: [1, 2],
      fractionAlongLeg: 0.4,
      deviationMeters: 0,
      arrived: false,
      phase: "riding",
    };
    store.applyTransitProgress(tp);
    const refreshed = { ...itinerary, refreshToken: "next-token" };

    store.updateItinerary(refreshed);
    let s = useNavigationStore.getState();
    expect(s.itinerary?.refreshToken).toBe("next-token");
    expect(s.transitProgress).toEqual(tp);

    store.replaceItinerary(refreshed);
    s = useNavigationStore.getState();
    expect(s.transitProgress).toBeNull();
  });
  it("rejects another selected vehicle without replacing the itinerary and marks live data unavailable", () => {
    const current = {
      ...itinerary,
      legs: [
        {
          mode: "bus",
          tripId: "selected",
          from: { name: "A", lat: 0, lng: 0 },
          to: { name: "B", lat: 0, lng: 0.02 },
          startTime: "2020-01-01T00:00:00Z",
          endTime: "2020-01-01T00:10:00Z",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [0.02, 0],
            ],
          },
        },
      ],
    } as TripItinerary;
    useNavigationStore.getState().startTransitNavigation(current);
    const other = structuredClone(current);
    other.legs[0].tripId = "another";
    useNavigationStore.getState().updateItinerary(other);
    expect(useNavigationStore.getState().itinerary).toBe(current);
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
    expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
  });
});

describe("navigationStore applyGroundFix", () => {
  const progress = {
    snapped: [0.001, 0],
    alongMeters: 111,
    deviationMeters: 2,
    segmentIndex: 0,
    etaEpochMs: 1_700_000_000_000,
    bearing: 90,
    speedMps: 13,
    currentStepIndex: 0,
  } as unknown as NavProgress;

  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
  });

  /** Count store publications while `run` executes, then unsubscribe. */
  function countPublications(run: () => void): number {
    let count = 0;
    const unsubscribe = useNavigationStore.subscribe(() => {
      count += 1;
    });
    try {
      run();
    } finally {
      unsubscribe();
    }
    return count;
  }

  it("publishes every per-fix field in a single notification", () => {
    const store = useNavigationStore.getState();
    store.setWeakGps(true);
    store.setOffRoute(true);
    store.setCoasting(true);

    let seen: {
      progress: NavProgress | null;
      weakGps: boolean;
      offRoute: boolean;
      currentSpeedLimit: number | null;
      coasting: boolean;
    } | null = null;
    const unsubscribe = useNavigationStore.subscribe((s) => {
      seen = {
        progress: s.progress,
        weakGps: s.weakGps,
        offRoute: s.offRoute,
        currentSpeedLimit: s.currentSpeedLimit,
        coasting: s.coasting,
      };
    });
    let calls = 0;
    const countUnsubscribe = useNavigationStore.subscribe(() => {
      calls += 1;
    });
    store.applyGroundFix({
      progress,
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: 50,
      coasting: false,
    });
    countUnsubscribe();
    unsubscribe();

    expect(calls).toBe(1);
    expect(useNavigationStore.getState().progress).toBe(progress);
    // Every field must already carry its new value in that one notification —
    // no subscriber ever observes a half-applied fix.
    expect(seen).toEqual({
      progress,
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: 50,
      coasting: false,
    });
  });

  it("keeps coasting when the update omits it (synthetic fix)", () => {
    const store = useNavigationStore.getState();
    store.setCoasting(true);
    const publications = countPublications(() =>
      store.applyGroundFix({
        progress,
        weakGps: false,
        offRoute: false,
        currentSpeedLimit: 30,
      }),
    );
    expect(publications).toBe(1);
    expect(useNavigationStore.getState().coasting).toBe(true);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(30);
  });

  it("treats an explicit undefined coasting like an omitted one", () => {
    const store = useNavigationStore.getState();
    store.setCoasting(true);
    store.applyGroundFix({
      progress,
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: null,
      coasting: undefined,
    });
    expect(useNavigationStore.getState().coasting).toBe(true);
  });

  it("leaves the granular setters usable for non-fix callers", () => {
    const store = useNavigationStore.getState();
    store.setWeakGps(true);
    expect(useNavigationStore.getState().weakGps).toBe(true);
    store.setOffRoute(true);
    expect(useNavigationStore.getState().offRoute).toBe(true);
    store.setSpeedLimit(80);
    expect(useNavigationStore.getState().currentSpeedLimit).toBe(80);
    store.setCoasting(true);
    expect(useNavigationStore.getState().coasting).toBe(true);
    store.applyProgress(progress);
    expect(useNavigationStore.getState().progress).toBe(progress);
  });
});

describe("navigationStore route-identity reset", () => {
  // The four actions that swap in a different route identity (selectRoute,
  // addStop, applyReroute, acceptFasterRoute) must all drop state measured
  // against the OLD route/geometry — including the previous road's speed
  // limit, which used to survive the swap and left the regulatory badge
  // showing against the new route until the next fix overwrote it.
  const routeWith = (distance: number): Route => ({ ...route, distance }) as Route;

  function seedTransientState(): void {
    useNavigationStore.setState({
      progress: { alongMeters: 42 } as NavProgress,
      offRoute: true,
      liveSpeedLimits: [50, 60],
      currentSpeedLimit: 90,
    });
  }

  const scenarios: {
    name: string;
    setup: () => void;
    invoke: () => void;
    assertSpecific: () => void;
  }[] = [
    {
      name: "selectRoute",
      setup: () => {
        const alt = routeWith(555);
        useNavigationStore.getState().startGroundNavigation(
          route,
          "driving",
          [
            [0, 0],
            [1, 1],
          ],
          [alt],
        );
        seedTransientState();
      },
      invoke: () => useNavigationStore.getState().selectRoute(1),
      assertSpecific: () => {
        const s = useNavigationStore.getState();
        expect(s.route?.distance).toBe(555);
        expect(s.fasterRoute).toBeNull();
      },
    },
    {
      name: "addStop",
      setup: () => {
        useNavigationStore.getState().startGroundNavigation(route, "driving", [
          [0, 0],
          [1, 1],
        ]);
        const pendingProposal = routeWith(777);
        useNavigationStore.getState().proposeFasterRoute({
          route: pendingProposal,
          alternatives: [],
          savedSeconds: 300,
          proposedAtMs: 1,
        });
        seedTransientState();
      },
      invoke: () =>
        useNavigationStore.getState().addStop(routeWith(321), [
          [0.5, 0.5],
          [1, 1],
        ]),
      assertSpecific: () => {
        const s = useNavigationStore.getState();
        expect(s.route?.distance).toBe(321);
        // A pending offer was priced without the new stop, so it is withdrawn.
        expect(s.fasterRoute).toBeNull();
      },
    },
    {
      name: "applyReroute",
      setup: () => {
        useNavigationStore.getState().startGroundNavigation(route, "driving", [
          [0, 0],
          [1, 1],
        ]);
        seedTransientState();
      },
      invoke: () => useNavigationStore.getState().applyReroute(routeWith(654)),
      assertSpecific: () => {
        const s = useNavigationStore.getState();
        expect(s.route?.distance).toBe(654);
        expect(s.fasterRoute).toBeNull();
      },
    },
    {
      name: "acceptFasterRoute",
      setup: () => {
        useNavigationStore.getState().startGroundNavigation(route, "driving", [
          [0, 0],
          [1, 1],
        ]);
        useNavigationStore.getState().proposeFasterRoute({
          route: routeWith(888),
          alternatives: [],
          savedSeconds: 300,
          proposedAtMs: 1,
        });
        seedTransientState();
      },
      invoke: () => useNavigationStore.getState().acceptFasterRoute(),
      assertSpecific: () => {
        const s = useNavigationStore.getState();
        expect(s.route?.distance).toBe(888);
        expect(s.fasterRoute).toBeNull();
      },
    },
  ];

  it.each(scenarios)(
    "$name clears progress/offRoute/liveSpeedLimits/currentSpeedLimit in a single notification",
    ({ setup, invoke, assertSpecific }) => {
      useNavigationStore.getState().stopNavigation();
      setup();
      expect(useNavigationStore.getState().currentSpeedLimit).not.toBeNull();

      let calls = 0;
      const unsubscribe = useNavigationStore.subscribe(() => {
        calls += 1;
      });
      invoke();
      unsubscribe();

      expect(calls).toBe(1);
      const s = useNavigationStore.getState();
      expect(s.progress).toBeNull();
      expect(s.offRoute).toBe(false);
      expect(s.liveSpeedLimits).toBeNull();
      expect(s.currentSpeedLimit).toBeNull();
      assertSpecific();
    },
  );
});

describe("navigationStore route transitions", () => {
  const routeWith = (distance: number): Route => ({ ...route, distance }) as Route;
  const twoWaypoints: LngLat[] = [
    [0, 0],
    [1, 1],
  ];
  const currentImpact = (validUntil: string): RoadConditionRouteImpact => ({
    availability: "current",
    evaluatedAt: "2026-09-12T12:00:00Z",
    validUntil,
    reasons: [],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    useNavigationStore.getState().stopNavigation();
  });
  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    vi.useRealTimers();
  });

  it("keeps an added stop when a faster-route offer is accepted afterwards", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", twoWaypoints);
    store.proposeFasterRoute({
      route: routeWith(777),
      alternatives: [],
      savedSeconds: 300,
      proposedAtMs: 1,
    });
    const withStop: LngLat[] = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ];
    store.addStop(routeWith(321), withStop);

    store.acceptFasterRoute();

    const s = useNavigationStore.getState();
    expect(s.route?.distance).toBe(321);
    expect(s.destinationWaypoints).toEqual(withStop);
  });

  it("keeps the lease timer when accepting with no offer pending", () => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", twoWaypoints, [], "routing-valhalla", {
        roadConditionImpact: currentImpact("2026-09-12T12:00:01Z"),
      });

    useNavigationStore.getState().acceptFasterRoute();
    vi.advanceTimersByTime(1_000);

    expect(useNavigationStore.getState().roadConditionImpact?.availability).toBe("expired");
  });

  it("keeps the lease timer when the alternative selected shares the held assessment", () => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", twoWaypoints, [routeWith(555)], "routing-valhalla", {
        roadConditionImpact: currentImpact("2026-09-12T12:00:01Z"),
      });

    useNavigationStore.getState().selectRoute(1);
    vi.advanceTimersByTime(1_000);

    expect(useNavigationStore.getState().roadConditionImpact?.availability).toBe("expired");
  });

  it("moves the lease timer to the assessment a reroute brings", () => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", twoWaypoints, [], "routing-valhalla", {
        roadConditionImpact: currentImpact("2026-09-12T12:00:01Z"),
      });

    useNavigationStore
      .getState()
      .applyReroute(routeWith(654), undefined, undefined, currentImpact("2026-09-12T12:00:10Z"));
    vi.advanceTimersByTime(1_000);
    expect(useNavigationStore.getState().roadConditionImpact?.availability).toBe("current");

    vi.advanceTimersByTime(9_000);
    expect(useNavigationStore.getState().roadConditionImpact?.availability).toBe("expired");
  });

  it("does not let a dropped assessment's timer flag live data once the route changed", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", twoWaypoints, [], "routing-valhalla", {
      roadConditionImpact: currentImpact("2026-09-12T12:00:01Z"),
    });

    store.addStop(routeWith(321), [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ]);
    vi.advanceTimersByTime(5_000);

    const s = useNavigationStore.getState();
    expect(s.roadConditionImpact).toBeNull();
    expect(s.liveDataUnavailable).toBe(false);
  });

  it("drops the lease timer with the session when navigation stops", () => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", twoWaypoints, [], "routing-valhalla", {
        roadConditionImpact: currentImpact("2026-09-12T12:00:01Z"),
      });

    useNavigationStore.getState().stopNavigation();
    vi.advanceTimersByTime(5_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
  });
});

describe("navigationStore preference persistence", () => {
  beforeEach(() => {
    configureStorage(makeMemoryStorage());
    useNavigationStore.setState({ voiceEnabled: true, keepScreenOn: true });
  });

  it("persists voiceEnabled across a toggle + hydrate (simulated reload)", () => {
    useNavigationStore.getState().toggleVoice();
    expect(useNavigationStore.getState().voiceEnabled).toBe(false);
    // Simulate a fresh session whose in-memory default is true.
    useNavigationStore.setState({ voiceEnabled: true });
    useNavigationStore.getState().hydrate();
    expect(useNavigationStore.getState().voiceEnabled).toBe(false);
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    expect(useNavigationStore.getState().voiceEnabled).toBe(false);
  });

  it("persists keepScreenOn across a toggle + hydrate (simulated reload)", () => {
    useNavigationStore.getState().toggleKeepScreenOn();
    expect(useNavigationStore.getState().keepScreenOn).toBe(false);
    useNavigationStore.setState({ keepScreenOn: true });
    useNavigationStore.getState().hydrate();
    expect(useNavigationStore.getState().keepScreenOn).toBe(false);
  });

  it("hydrate keeps defaults when nothing is stored", () => {
    useNavigationStore.getState().hydrate();
    expect(useNavigationStore.getState().voiceEnabled).toBe(true);
    expect(useNavigationStore.getState().keepScreenOn).toBe(true);
  });
});

const projection = (overrides: Partial<NativeNavigationProjection> = {}) =>
  ({
    sessionId: "s1",
    revision: 4,
    fingerprint: "route-a",
    kind: "ground",
    status: "navigating",
    mode: "driving",
    route,
    routes: [route],
    progress: { alongMeters: 100 } as unknown as NavProgress,
    offRoute: false,
    weakGps: false,
    coasting: false,
    currentSpeedLimit: 50,
    connectivity: "online",
    permissionMode: "background",
    confidence: "live",
    ...overrides,
  }) satisfies NativeNavigationProjection;

const delta = (overrides: Partial<NativeNavigationProjection> = {}) =>
  projection({
    revision: 5,
    baseRevision: 4,
    progress: { alongMeters: 200 } as unknown as NavProgress,
    route: undefined,
    routes: undefined,
    ...overrides,
  });

describe("navigationStore native read model", () => {
  beforeEach(() => {
    useNavigationStore.setState({ navigationAuthority: "browser" });
    useNavigationStore.getState().clearNativeReadModel();
  });

  it("populates the fields the navigation UI reads from a full snapshot", () => {
    useNavigationStore.setState({ fasterRoute: { savedSeconds: 90 } as never, weakGps: true });
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    const state = useNavigationStore.getState();
    expect(state.navigationAuthority).toBe("native");
    expect(state.status).toBe("navigating");
    expect(state.kind).toBe("ground");
    expect(state.route).toBe(route);
    expect(state.progress).toEqual({ alongMeters: 100 });
    expect(state.currentSpeedLimit).toBe(50);
    expect(state.permissionMode).toBe("background");
    expect(state.nativeRevision).toBe(4);
    expect(state.nativeRouteFingerprint).toBe("route-a");
    expect(state.fasterRoute).toBeNull();
    expect(state.weakGps).toBe(false);
  });

  it("never hydrates an already-expired current road-condition assessment", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:01Z"));

    useNavigationStore.getState().applyNativeFullSnapshot(
      projection({
        roadConditionImpact: {
          availability: "current",
          evaluatedAt: "2026-09-12T12:00:00Z",
          validUntil: "2026-09-12T12:00:00Z",
          reasons: [],
        },
      }),
    );

    expect(useNavigationStore.getState().roadConditionImpact).toMatchObject({
      availability: "expired",
      reasons: ["evidence_expired"],
    });
  });

  it("cannot hydrate browser-only replay state", () => {
    useNavigationStore
      .getState()
      .applyNativeFullSnapshot(
        projection({ rerouteRetryNonce: 9, navigationStartedAtMs: 1 } as never),
      );

    // Not in the projection's copied key list, so an over-broad native payload
    // cannot reach the browser engine's own controls.
    expect(useNavigationStore.getState().rerouteRetryNonce).toBe(0);
    expect(useNavigationStore.getState().navigationStartedAtMs).toBeNull();
  });

  it("reports an identical full snapshot as a duplicate", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeFullSnapshot(projection())).toBe("duplicate");
  });

  it("accepts a full snapshot that moves the revision backwards", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeFullSnapshot(projection({ revision: 2 }))).toBe(
      "applied",
    );
    expect(useNavigationStore.getState().nativeRevision).toBe(2);
  });

  it("applies a delta on its declared base", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeDelta(delta())).toBe("applied");
    expect(useNavigationStore.getState().progress).toEqual({ alongMeters: 200 });
    expect(useNavigationStore.getState().nativeRevision).toBe(5);
    expect(useNavigationStore.getState().route).toBe(route);
  });

  it("asks for a full snapshot rather than interpolating a gap", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(
      useNavigationStore.getState().applyNativeDelta(delta({ revision: 9, baseRevision: 8 })),
    ).toBe("needs-full-snapshot");
    expect(useNavigationStore.getState().nativeRevision).toBe(4);
  });

  it("ignores a duplicate delta", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeDelta(delta({ revision: 4 }))).toBe(
      "duplicate",
    );
  });

  it("ignores an older delta", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeDelta(delta({ revision: 2 }))).toBe("stale");
  });

  it("refuses a delta for another session", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeDelta(delta({ sessionId: "s2" }))).toBe(
      "needs-full-snapshot",
    );
  });

  it("refuses a delta whose route changed underneath it", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(useNavigationStore.getState().applyNativeDelta(delta({ fingerprint: "route-b" }))).toBe(
      "needs-full-snapshot",
    );
  });

  it("refuses any delta before a full snapshot has arrived", () => {
    expect(useNavigationStore.getState().applyNativeDelta(delta())).toBe("needs-full-snapshot");
  });

  it("projects a transit snapshot", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(
      projection({
        kind: "transit",
        fingerprint: "it-a",
        route: null,
        routes: [],
        itinerary,
        transitProgress: { legIndex: 1 } as unknown as TransitProgress,
        alertAvailability: "scheduled",
      }),
    );

    const state = useNavigationStore.getState();
    expect(state.kind).toBe("transit");
    expect(state.itinerary).toBe(itinerary);
    expect(state.transitProgress).toEqual({ legIndex: 1 });
    expect(state.alertAvailability).toBe("scheduled");
  });

  it("keeps native authority after the session it described ends", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    useNavigationStore.getState().clearNativeReadModel();

    // Otherwise the browser engine takes the wheel inside an installed app the
    // moment a trip finishes.
    expect(useNavigationStore.getState().navigationAuthority).toBe("native");
    expect(useNavigationStore.getState().nativeRevision).toBeNull();
    expect(useNavigationStore.getState().status).toBe("idle");
  });
});

describe("navigationStore browser starts under native authority", () => {
  beforeEach(() => {
    useNavigationStore.setState({ navigationAuthority: "browser" });
    useNavigationStore.getState().clearNativeReadModel();
  });

  it("throws in development rather than starting a second engine", () => {
    useNavigationStore.setState({ navigationAuthority: "native" });

    expect(() =>
      useNavigationStore.getState().startGroundNavigation(route, "driving", []),
    ).toThrow();
    expect(() => useNavigationStore.getState().startTransitNavigation(itinerary)).toThrow();
  });

  it("still permits browser starts under browser authority", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", []);

    expect(useNavigationStore.getState().status).toBe("navigating");
  });
});

it("uses the captured platform area for explicit browser alighting", () => {
  const now = Date.now();
  const trip = {
    ...itinerary,
    legs: [
      {
        mode: "rail",
        tripId: "selected",
        from: { name: "A", stopId: "a", lat: 0, lng: 0 },
        to: { name: "B", stopId: "b", lat: 0, lng: 0.02 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [0.02, 0],
          ],
        },
      },
    ],
  } as TripItinerary;
  useNavigationStore.getState().startTransitNavigation(trip);
  useNavigationStore.getState().applyTransitAction({ type: "board", legIndex: 0 });
  useNavigationStore.setState((s) => ({
    transitTickState: {
      ...(s.transitTickState ?? {
        currentLegIndex: 0,
        currentWalkStepIndex: 0,
        phase: "riding" as const,
        legEnteredAtMs: now,
        spokenCueIds: [],
        emittedEventIds: [],
      }),
      lastAcceptedFix: { coords: [0.017, 0], accuracy: 5, timestampMs: now },
    },
    transitStopAreas: {
      "b|": {
        stopId: "b",
        platform: [
          {
            type: "line",
            coordinates: [
              [0.016, 0],
              [0.02, 0],
            ],
            bufferMeters: 10,
          },
        ],
        station: [],
        source: "osm",
      },
    },
  }));
  expect(useNavigationStore.getState().applyTransitAction({ type: "alight", legIndex: 0 })).toBe(
    true,
  );
  expect(useNavigationStore.getState().transitProgress?.phase).toBe("arrived");
  expect(useNavigationStore.getState().transitProgress?.offPlan).toBe(false);
  useNavigationStore.getState().stopNavigation();
});
