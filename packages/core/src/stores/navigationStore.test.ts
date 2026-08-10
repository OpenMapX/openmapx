import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it } from "vitest";
import type { TransitProgress } from "../navigation/transitProgress";
import type { NavProgress } from "../navigation/types";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import type { Route } from "../types/routing";
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

  it("starts ground navigation", () => {
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    const s = useNavigationStore.getState();
    expect(s.status).toBe("navigating");
    expect(s.mode).toBe("driving");
    expect(s.route).toBe(route);
    expect(s.cameraMode).toBe("follow");
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
    expect(useNavigationStore.getState().progress).toBeNull();
  });

  it("clears live speed limits on reroute (they index the old geometry)", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.setLiveSpeedLimits([50, 70, 70]);
    expect(useNavigationStore.getState().liveSpeedLimits).toEqual([50, 70, 70]);
    store.applyReroute({ ...route, distance: 200 } as Route);
    expect(useNavigationStore.getState().liveSpeedLimits).toBeNull();
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

  it("applyTransitProgress stores progress", () => {
    const store = useNavigationStore.getState();
    store.startTransitNavigation(itinerary);
    const tp: TransitProgress = {
      currentLegIndex: 1,
      snapped: [1, 2],
      fractionAlongLeg: 0.5,
      deviationMeters: 12,
      arrived: false,
    };
    store.applyTransitProgress(tp);
    expect(useNavigationStore.getState().transitProgress).toBe(tp);
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
    });
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

  it("startGroundNavigation resets transit bits", () => {
    const store = useNavigationStore.getState();
    store.startTransitNavigation(itinerary);
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    const s = useNavigationStore.getState();
    expect(s.kind).toBe("ground");
    expect(s.itinerary).toBeNull();
    expect(s.transitProgress).toBeNull();
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

  it("preserves the progress object identity", () => {
    useNavigationStore.getState().applyGroundFix({
      progress,
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: null,
    });
    expect(useNavigationStore.getState().progress).toBe(progress);
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

  it("clears coasting when the update passes false (real fix re-anchors)", () => {
    const store = useNavigationStore.getState();
    store.setCoasting(true);
    store.applyGroundFix({
      progress,
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: null,
      coasting: false,
    });
    expect(useNavigationStore.getState().coasting).toBe(false);
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
        // Unlike the other three route-identity actions, addStop does not
        // touch a pending faster-route proposal.
        expect(s.fasterRoute?.route.distance).toBe(777);
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

  it("startGroundNavigation preserves persisted toggle prefs", () => {
    useNavigationStore.getState().toggleVoice();
    useNavigationStore.getState().startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    expect(useNavigationStore.getState().voiceEnabled).toBe(false);
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

  it("starts under browser authority", () => {
    expect(useNavigationStore.getState().navigationAuthority).toBe("browser");
  });

  it("populates the fields the navigation UI reads from a full snapshot", () => {
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
  });

  it("replaces a stale browser read model rather than merging into it", () => {
    useNavigationStore.setState({ fasterRoute: { savedSeconds: 90 } as never, weakGps: true });

    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    // A browser-only offer that outlived its engine would be a button that
    // reroutes a session this page does not own.
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
    expect(useNavigationStore.getState().weakGps).toBe(false);
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
  });

  it("keeps the route a delta does not carry", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());
    useNavigationStore.getState().applyNativeDelta(delta());

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

  it("deduplicates navigation events by ID", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());

    expect(
      useNavigationStore.getState().applyNativeEvent({ eventId: "e1", type: "off-route" }),
    ).toBe("applied");
    // A reconnect replays what was never acknowledged; announcing it twice is
    // the bug that makes riders distrust the alerts.
    expect(
      useNavigationStore.getState().applyNativeEvent({ eventId: "e1", type: "off-route" }),
    ).toBe("duplicate");
  });

  it("keeps pending events across a full snapshot for the same session", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());
    useNavigationStore.getState().applyNativeEvent({ eventId: "e1", type: "off-route" });

    useNavigationStore.getState().applyNativeFullSnapshot(projection({ revision: 7 }));

    expect(useNavigationStore.getState().nativeEventIds).toEqual(["e1"]);
  });

  it("drops pending events when the session changes", () => {
    useNavigationStore.getState().applyNativeFullSnapshot(projection());
    useNavigationStore.getState().applyNativeEvent({ eventId: "e1", type: "off-route" });

    useNavigationStore.getState().applyNativeFullSnapshot(projection({ sessionId: "s2" }));

    expect(useNavigationStore.getState().nativeEventIds).toEqual([]);
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
