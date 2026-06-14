import type { Route } from "@integrations/routing/types";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it } from "vitest";
import type { TransitProgress } from "../navigation/transitProgress";
import type { NavProgress } from "../navigation/types";
import { configureStorage, type StorageAdapter } from "../platform/storage";
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
