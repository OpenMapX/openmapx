import type { Route } from "@integrations/routing/types";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it } from "vitest";
import type { TransitProgress } from "../navigation/transitProgress";
import { useNavigationStore } from "./navigationStore";

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

  it("applyReroute swaps the route and returns to navigating", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route, "driving", [
      [0, 0],
      [1, 1],
    ]);
    store.beginReroute();
    expect(useNavigationStore.getState().status).toBe("rerouting");
    const route2 = { ...route, distance: 200 } as Route;
    store.applyReroute(route2);
    expect(useNavigationStore.getState().status).toBe("navigating");
    expect(useNavigationStore.getState().route?.distance).toBe(200);
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
