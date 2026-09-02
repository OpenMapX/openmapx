import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizedDepartureMinute, resolveTravelTimeBackend, useTravelTimeStore } from "../store";

const initial = useTravelTimeStore.getInitialState();

describe("travel-time reachability state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:12:43.987Z"));
    useTravelTimeStore.setState(initial, true);
  });

  afterEach(() => vi.useRealTimers());

  it("captures and clears a minute-normalized departure instant", () => {
    useTravelTimeStore.getState().activate();
    expect(useTravelTimeStore.getState().queryTime).toBe("2026-08-30T10:12:00.000Z");
    useTravelTimeStore.getState().deactivate();
    expect(useTravelTimeStore.getState().queryTime).toBeNull();
  });

  it("retains time for band changes and recaptures it for a transit origin change", () => {
    useTravelTimeStore.getState().activate();
    useTravelTimeStore.getState().setMode("transit");
    const first = useTravelTimeStore.getState().queryTime;
    vi.setSystemTime(new Date("2026-08-30T10:14:59.000Z"));
    useTravelTimeStore.getState().toggleMinutes(30);
    expect(useTravelTimeStore.getState().queryTime).toBe(first);
    useTravelTimeStore.getState().setOrigin([13.4, 52.5]);
    expect(useTravelTimeStore.getState().queryTime).toBe("2026-08-30T10:14:00.000Z");
  });

  it("keeps transit separate from street isochrone backends", () => {
    expect(resolveTravelTimeBackend("transit")).toEqual({ kind: "transit-reachability" });
    expect(resolveTravelTimeBackend("walking")).toEqual({
      kind: "street-isochrone",
      mode: "walking",
    });
  });

  it("validates explicit selected times", () => {
    expect(normalizedDepartureMinute("2026-08-30T23:59:59Z")).toBe("2026-08-30T23:59:00.000Z");
    expect(() => normalizedDepartureMinute("not-a-date")).toThrow("Invalid reachability time");
  });
});

describe("transit surface kind", () => {
  it("defaults to the estimated field", () => {
    useTravelTimeStore.getState().activate();
    expect(useTravelTimeStore.getState().transitSurfaceKind).toBe("estimated");
  });

  it("switches to polygons and back", () => {
    useTravelTimeStore.getState().activate();
    useTravelTimeStore.getState().setTransitSurfaceKind("polygons");
    expect(useTravelTimeStore.getState().transitSurfaceKind).toBe("polygons");
    useTravelTimeStore.getState().setTransitSurfaceKind("estimated");
    expect(useTravelTimeStore.getState().transitSurfaceKind).toBe("estimated");
  });

  it("resets to the estimated field when the tool is deactivated", () => {
    useTravelTimeStore.getState().setTransitSurfaceKind("polygons");
    useTravelTimeStore.getState().deactivate();
    expect(useTravelTimeStore.getState().transitSurfaceKind).toBe("estimated");
  });

  it("resets to the estimated field when leaving transit mode", () => {
    useTravelTimeStore.getState().activate();
    useTravelTimeStore.getState().setMode("transit");
    useTravelTimeStore.getState().setTransitSurfaceKind("polygons");
    useTravelTimeStore.getState().setMode("walking");
    expect(useTravelTimeStore.getState().transitSurfaceKind).toBe("estimated");
    expect(useTravelTimeStore.getState().transitPolygonBbox).toBeNull();
  });
});

describe("transit polygon area", () => {
  it("does not sample until the area is explicitly requested", () => {
    useTravelTimeStore.getState().activate();
    useTravelTimeStore.getState().setMode("transit");
    useTravelTimeStore.getState().setTransitSurfaceKind("polygons");
    useTravelTimeStore.getState().setTransitPolygonViewport([13.3, 52.45, 13.5, 52.55]);
    expect(useTravelTimeStore.getState().transitPolygonBbox).toBeNull();
  });

  it("freezes the viewport at request time", () => {
    useTravelTimeStore.getState().setTransitPolygonViewport([13.3, 52.45, 13.5, 52.55]);
    useTravelTimeStore.getState().requestTransitPolygons();
    expect(useTravelTimeStore.getState().transitPolygonBbox).toEqual([13.3, 52.45, 13.5, 52.55]);
  });

  it("keeps the frozen area when the map moves afterwards, so panning cannot re-sample", () => {
    useTravelTimeStore.getState().setTransitPolygonViewport([13.3, 52.45, 13.5, 52.55]);
    useTravelTimeStore.getState().requestTransitPolygons();
    useTravelTimeStore.getState().setTransitPolygonViewport([1, 1, 2, 2]);
    expect(useTravelTimeStore.getState().transitPolygonBbox).toEqual([13.3, 52.45, 13.5, 52.55]);
  });

  it("drops the frozen area when switching back to the estimated field", () => {
    useTravelTimeStore.getState().setTransitPolygonViewport([13.3, 52.45, 13.5, 52.55]);
    useTravelTimeStore.getState().requestTransitPolygons();
    useTravelTimeStore.getState().setTransitSurfaceKind("estimated");
    expect(useTravelTimeStore.getState().transitPolygonBbox).toBeNull();
  });
});
