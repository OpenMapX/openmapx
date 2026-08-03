import { beforeEach, describe, expect, it } from "vitest";
import {
  createNavigationSessionSnapshot,
  type NavigationSessionSnapshot,
} from "../navigation/offlineSession";
import type { NavProgress } from "../navigation/types";
import type { Route } from "../types/routing";
import { useNavigationStore } from "./navigationStore";

const geometry: [number, number][] = [
  [10, 50],
  [10.001, 50.001],
  [10.002, 50.002],
];

const route = (distance = 200): Route => ({
  distance,
  duration: 80,
  geometry,
  legs: [
    {
      distance,
      duration: 80,
      geometry,
      steps: [
        {
          instruction: "Turn right",
          distance: 100,
          duration: 40,
          coordinates: geometry.slice(0, 2),
        },
        { instruction: "Arrive", distance: 100, duration: 40, coordinates: geometry.slice(1) },
      ],
    },
  ],
  steps: [
    { instruction: "Turn right", distance: 100, duration: 40, coordinates: geometry.slice(0, 2) },
    { instruction: "Arrive", distance: 100, duration: 40, coordinates: geometry.slice(1) },
  ],
  mode: "driving",
});

const progress: NavProgress = {
  currentStepIndex: 0,
  distanceToNextManeuver: 100,
  distanceRemaining: 200,
  durationRemaining: 80,
  snapped: geometry[0],
  alongMeters: 0,
  deviationMeters: 0,
  segmentIndex: 0,
  etaEpochMs: 1_000,
  bearing: 45,
  speedMps: 10,
};

function snapshot() {
  const primary = route();
  return createNavigationSessionSnapshot({
    route: primary,
    routes: [primary, route(300)],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: "osrm",
    destinationWaypoints: [geometry[0], geometry[2]],
    progress,
    packageIds: [],
    startedAtMs: 500,
    updatedAtMs: 600,
  });
}

describe("navigationStore offline state", () => {
  beforeEach(() => useNavigationStore.getState().stopNavigation());

  it("starts online with rerouting and live data available", () => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route(), "driving", [geometry[0], geometry[2]]);
    const state = useNavigationStore.getState();
    expect(state.connectivity).toBe("online");
    expect(state.rerouteUnavailable).toBe(false);
    expect(state.liveDataUnavailable).toBe(false);
    expect(state.navigationStartedAtMs).toBeDefined();
  });

  it("keeps route and progress when connectivity becomes offline", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route(), "driving", [geometry[0], geometry[2]]);
    store.applyProgress(progress);
    store.setConnectivity("offline");
    const state = useNavigationStore.getState();
    expect(state.connectivity).toBe("offline");
    expect(state.route).not.toBeNull();
    expect(state.progress).toBe(progress);
    expect(state.status).toBe("navigating");
    expect(state.rerouteUnavailable).toBe(true);
    expect(state.liveDataUnavailable).toBe(true);
  });

  it("marks rerouting unavailable without making navigation idle", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route(), "driving", [geometry[0], geometry[2]]);
    store.signalRerouteFailed();
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(true);
    expect(useNavigationStore.getState().status).toBe("navigating");
  });

  it("increments the deliberate retry nonce only when requested", () => {
    const store = useNavigationStore.getState();
    expect(useNavigationStore.getState().rerouteRetryNonce).toBe(0);
    store.requestRerouteRetry();
    store.requestRerouteRetry();
    expect(useNavigationStore.getState().rerouteRetryNonce).toBe(2);
  });

  it("clears degraded state after a successful reroute", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route(), "driving", [geometry[0], geometry[2]]);
    store.setConnectivity("offline");
    store.signalRerouteFailed();
    store.setConnectivity("online");
    store.applyReroute(route(400));
    const state = useNavigationStore.getState();
    expect(state.rerouteUnavailable).toBe(false);
    expect(state.status).toBe("navigating");
    expect(state.route?.distance).toBe(400);
  });

  it("restores a ground snapshot without transient faster-route state", () => {
    const store = useNavigationStore.getState();
    store.proposeFasterRoute({
      route: route(500),
      alternatives: [],
      savedSeconds: 20,
      proposedAtMs: 1,
    });
    store.restoreGroundNavigation(snapshot());
    const state = useNavigationStore.getState();
    expect(state.kind).toBe("ground");
    expect(state.status).toBe("navigating");
    expect(state.progress?.alongMeters).toBe(0);
    expect(state.fasterRoute).toBeNull();
    expect(state.connectivity).toBe("offline");
    expect(state.rerouteUnavailable).toBe(true);
    expect(state.liveDataUnavailable).toBe(true);
  });

  it("does not restore a transit snapshot", () => {
    const transit = {
      ...snapshot(),
      kind: "transit" as const,
    } as unknown as NavigationSessionSnapshot;
    let error: unknown;
    try {
      useNavigationStore.getState().restoreGroundNavigation(transit);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeDefined();
    expect(useNavigationStore.getState().status).toBe("idle");
  });

  it("resets degraded state on stop and arrival", () => {
    const store = useNavigationStore.getState();
    store.startGroundNavigation(route(), "driving", [geometry[0], geometry[2]]);
    store.setConnectivity("offline");
    store.setRerouteUnavailable(true);
    store.completeArrival();
    expect(useNavigationStore.getState().rerouteUnavailable).toBe(false);
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(false);
    store.stopNavigation();
    expect(useNavigationStore.getState().connectivity).toBe("online");
  });
});
