import type { Route } from "@integrations/routing/types";
import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore } from "./navigationStore";

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
});
