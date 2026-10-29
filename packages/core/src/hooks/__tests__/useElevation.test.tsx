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

it("keeps geometry and inline height snapshots on a non-driving computed profile", () => {
  const geometry = { sourceId: "geometry", name: "Geometry", attributionText: "Geometry notice" };
  const height = { sourceId: "height", name: "Height", attributionText: "Height notice" };
  const unused = { sourceId: "unused", name: "Unused route metric" };
  const route = makeRoute({
    mode: "walking",
    elevation: [10, 20, 30],
    fieldContributors: { geometry: [geometry], elevation: [height], distance: [unused] },
  });
  const { result } = renderHook(() => useElevation({ route }), { wrapper: createQueryWrapper() });
  expect(result.current.data?.contributors).toEqual([geometry, height]);
  height.attributionText = "Changed";
  expect(result.current.data?.contributors?.[1].attributionText).toBe("Height notice");
});

it("fetches driving height receipts and preserves the exact requested geometry before await", async () => {
  const geometry = { sourceId: "geometry", name: "Geometry", attributionText: "Before request" };
  const height = { sourceId: "height", name: "Height" };
  const ignored = { sourceId: "ignored", name: "Ignored inline height" };
  let resolve!: (value: unknown) => void;
  vi.spyOn(apiClient, "post").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never,
  );
  const route = makeRoute({
    elevation: [100, 200],
    fieldContributors: { geometry: [geometry], elevation: [ignored] },
  });
  const { result } = renderHook(() => useElevation({ route }), { wrapper: createQueryWrapper() });
  geometry.attributionText = "After request";
  resolve({
    points: [
      { distance: 0, elevation: 1 },
      { distance: 50, elevation: 2 },
    ],
    interval: 50,
    contributors: [height],
    contributorCoverage: "partial",
  });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  expect(result.current.data?.contributors).toEqual([
    { ...geometry, attributionText: "Before request" },
    height,
  ]);
  expect(result.current.data?.contributorCoverage).toBe("partial");
});

it("does not reuse a cached computed profile for a different interior shape or historical receipt", async () => {
  const request = vi.spyOn(apiClient, "post").mockResolvedValue({
    points: [
      { distance: 0, elevation: 1 },
      { distance: 50, elevation: 2 },
    ],
    interval: 50,
    contributors: [],
  } as never);
  const a = { sourceId: "same", name: "Route", attributionText: "A" };
  const b = { sourceId: "same", name: "Route", attributionText: "B" };
  const geometry: [number, number][] = [
    [0, 0],
    [0.1, 0.1],
    [0.2, 0.2],
    [0.3, 0.3],
    [0.4, 0.4],
  ];
  const { result, rerender } = renderHook(({ route }) => useElevation({ route }), {
    initialProps: { route: makeRoute({ geometry, contributors: [a] }) },
    wrapper: createQueryWrapper(),
  });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  rerender({
    route: makeRoute({
      geometry: geometry.map((p, i) => (i === 1 ? [0.15, 0.15] : p)),
      contributors: [b],
    }),
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.data?.contributors).toEqual([b]));
});
