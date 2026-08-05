import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it } from "vitest";
import type { TransitProgress } from "../navigation/transitProgress";
import type { NavProgress } from "../navigation/types";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import type { Route } from "../types/routing";
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
