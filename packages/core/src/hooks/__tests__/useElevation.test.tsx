import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { Route } from "../../types/routing";
import { useElevation } from "../useElevation";

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    distance: 1000,
    duration: 600,
    geometry: [
      [13.4, 52.5],
      [13.45, 52.55],
      [13.5, 52.6],
    ],
    legs: [],
    steps: [],
    mode: "driving",
    ...overrides,
  };
}

describe("useElevation", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches an elevation profile for a driving route via POST", async () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({
      points: [
        { distance: 0, elevation: 30 },
        { distance: 500, elevation: 45 },
        { distance: 1000, elevation: 40 },
      ],
    } as never);

    const route = makeRoute();
    const { result } = renderHook(() => useElevation({ route }), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.points).toHaveLength(3);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.elevation, {
      coordinates: route.geometry,
      routeDistance: route.distance,
    });
  });

  it("uses inline elevation for non-driving routes without fetching", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({ points: [] } as never);

    const route = makeRoute({ mode: "walking", elevation: [10, 20, 30], elevationInterval: 30 });
    const { result } = renderHook(() => useElevation({ route }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.data?.points).toHaveLength(3);
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fetch when there is no route", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({ points: [] } as never);

    const { result } = renderHook(() => useElevation({ route: null }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.data).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fetch when disabled", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({ points: [] } as never);

    const { result } = renderHook(() => useElevation({ route: makeRoute(), enabled: false }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
