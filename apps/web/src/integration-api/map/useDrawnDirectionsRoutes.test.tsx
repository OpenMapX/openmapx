import type { Waypoint } from "@openmapx/core";
import { useDirectionsStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test";

// Spy on the real `useDirections` (rather than mocking the whole ground-engine
// query away) so a test can assert exactly what waypoints array the hook
// forwards — the only way to isolate the transit/flying/EV/navigating gate
// from the "waypoints aren't filled yet" case, which produces the same empty
// `routes` output for an unrelated reason.
const useDirectionsMock = vi.fn(() => ({ data: undefined }));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useDirections: (...args: unknown[]) => useDirectionsMock(...args),
  };
});

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

import { useDrawnDirectionsRoutes } from "./useDrawnDirectionsRoutes";

const FILLED_WAYPOINTS: Waypoint[] = [
  { id: "origin", coords: [13.4, 52.5], label: "Origin", type: "origin" },
  { id: "destination", coords: [13.5, 52.6], label: "Destination", type: "destination" },
];

describe("useDrawnDirectionsRoutes", () => {
  beforeEach(() => {
    useDirectionsMock.mockClear();
  });

  afterEach(() => {
    useDirectionsStore.getState().close();
    act(() => {
      useDirectionsStore.setState({ mode: "driving" });
    });
  });

  it("draws nothing while no waypoint has coordinates", () => {
    const { result } = renderHook(() => useDrawnDirectionsRoutes(), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.routes).toEqual([]);
    expect(result.current.navigating).toBe(false);
  });

  it("reports the transit mode and withholds waypoints from the ground-engine query", () => {
    act(() => {
      useDirectionsStore.setState({ mode: "transit", waypoints: FILLED_WAYPOINTS });
    });
    const { result } = renderHook(() => useDrawnDirectionsRoutes(), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.mode).toBe("transit");
    expect(result.current.routes).toEqual([]);
    // Waypoints are filled, so an empty result here can only come from the
    // transit gate — not from "nothing to route yet" — because the ground
    // engine was handed an empty waypoints array despite real coordinates
    // being set.
    expect(useDirectionsMock).toHaveBeenCalledWith(expect.objectContaining({ waypoints: [] }));
  });

  it("keeps routes and evStops referentially stable across an unrelated re-render", () => {
    const { result, rerender } = renderHook(() => useDrawnDirectionsRoutes(), {
      wrapper: createQueryWrapper(),
    });
    const firstRoutes = result.current.routes;
    const firstEvStops = result.current.evStops;

    // Nothing about the underlying store or query data changes here — this
    // re-render exists purely to catch a hook that hands out a fresh `[]`
    // literal each render, which would otherwise re-trigger effects that
    // depend on `routes`/`evStops` (map layer + EV pin sync in RouteLayer)
    // on every unrelated re-render.
    rerender();

    expect(result.current.routes).toBe(firstRoutes);
    expect(result.current.evStops).toBe(firstEvStops);
  });
});
