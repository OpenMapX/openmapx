import { beforeEach, describe, expect, it } from "vitest";
import type { Route } from "../types/routing";
import { useNavigationStore } from "./navigationStore";

const routeOf = (id: string, duration: number): Route =>
  ({
    distance: 1000,
    duration,
    geometry: [
      [0, 0],
      [0.01, 0],
    ],
    legs: [],
    steps: [],
    mode: "driving",
    summary: id,
  }) as Route;

const original = routeOf("original", 3600);
const altA = routeOf("altA", 3800);
const faster = routeOf("faster", 2700);
const fasterAlt = routeOf("fasterAlt", 2900);

beforeEach(() => {
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(
    original,
    "driving",
    [
      [0, 0],
      [0.01, 0],
    ],
    [altA],
    "routing-valhalla",
  );
});

describe("faster-route proposal", () => {
  it("holds one pending proposal", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: faster,
      alternatives: [fasterAlt],
      savedSeconds: 900,
      proposedAtMs: 1000,
    });
    expect(useNavigationStore.getState().fasterRoute?.savedSeconds).toBe(900);
  });

  it("accepting swaps the route and replaces the stale alternatives", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: faster,
      alternatives: [fasterAlt],
      savedSeconds: 900,
      proposedAtMs: 1000,
    });
    useNavigationStore.getState().acceptFasterRoute();
    const s = useNavigationStore.getState();
    expect(s.route).toBe(faster);
    expect(s.routes).toEqual([faster, fasterAlt]);
    expect(s.activeRouteIndex).toBe(0);
    expect(s.progress).toBeNull();
    expect(s.offRoute).toBe(false);
    expect(s.fasterRoute).toBeNull();
    expect(s.status).toBe("navigating");
  });

  it("accepting with no proposal pending is a no-op", () => {
    useNavigationStore.getState().acceptFasterRoute();
    expect(useNavigationStore.getState().route).toBe(original);
  });

  it("dismissing clears the proposal and leaves the route alone", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: faster,
      alternatives: [],
      savedSeconds: 900,
      proposedAtMs: 1000,
    });
    useNavigationStore.getState().dismissFasterRoute();
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
    expect(useNavigationStore.getState().route).toBe(original);
  });

  it("selecting another route clears a pending proposal", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: faster,
      alternatives: [],
      savedSeconds: 900,
      proposedAtMs: 1000,
    });
    useNavigationStore.getState().selectRoute(1);
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });

  it("stopping navigation clears a pending proposal", () => {
    useNavigationStore.getState().proposeFasterRoute({
      route: faster,
      alternatives: [],
      savedSeconds: 900,
      proposedAtMs: 1000,
    });
    useNavigationStore.getState().stopNavigation();
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });
});

describe("applyReroute alternatives", () => {
  it("refreshes routes[] when alternatives are supplied", () => {
    useNavigationStore.getState().applyReroute(faster, "routing-valhalla", [fasterAlt]);
    const s = useNavigationStore.getState();
    expect(s.routes).toEqual([faster, fasterAlt]);
    expect(s.activeRouteIndex).toBe(0);
  });

  it("leaves routes[] untouched when they are omitted", () => {
    useNavigationStore.getState().applyReroute(faster, "routing-valhalla");
    expect(useNavigationStore.getState().routes).toEqual([original, altA]);
  });
});
