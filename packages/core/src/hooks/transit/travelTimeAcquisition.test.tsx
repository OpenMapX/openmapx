import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";
import { useIsochrone } from "../useIsochrone";
import { transitIsochroneKey, useTransitIsochrone } from "./useTransitIsochrone";
import { transitReachabilitySurfaceKey, useTransitReachability } from "./useTransitReachability";

vi.mock("../../api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
const request = {
  origin: { lng: 0, lat: 0 },
  queryTime: "2026-10-13T08:00:00Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [15],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
  bbox: [0, 0, 1, 1] as [number, number, number, number],
};
const polygon: GeoJSON.Feature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  properties: {},
};
beforeEach(() => vi.clearAllMocks());
describe("production travel time acquisition hooks", () => {
  it("stores sampled polygon receipt even if the independent estimated request fails", async () => {
    const receipt = {
      sourceId: "sample",
      name: "Sampled supplier",
      attributionText: "Original notice",
    };
    const response = {
      data: { featureCollection: { type: "FeatureCollection", features: [polygon] } },
      attributions: [receipt],
    };
    vi.mocked(apiClient.post).mockImplementation(async (url) => {
      if (url === API_ENDPOINTS.transitReachabilityIsochrone) return response;
      throw new Error("Independent reachability unavailable");
    });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        polygons: useTransitIsochrone(request, true),
        estimated: useTransitReachability(request, true),
      }),
      { wrapper: createQueryWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.polygons.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.estimated.isError).toBe(true));
    receipt.attributionText = "New registry notice";
    const cached = queryClient.getQueryData<{
      data: { featureCollection: GeoJSON.FeatureCollection };
    }>(transitIsochroneKey(request));
    expect(
      JSON.parse(cached?.data.featureCollection.features[0]?.properties?._mapAttributions),
    ).toEqual([{ ...receipt, attributionText: "Original notice" }]);
    expect(result.current.estimated.data).toBeUndefined();
  });
  it("captures seed-native receipts before estimated surface caching and preserves explicit []", async () => {
    const receipt = { sourceId: "geometry", name: "Geometry supplier" };
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        contributors: [],
        seeds: [{ lng: 0, lat: 0, arrivalSeconds: 10, contributors: [receipt] }],
      },
      attributions: [{ sourceId: "unrelated", name: "Unrelated" }],
    });
    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useTransitReachability(request, true), {
      wrapper: createQueryWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    receipt.name = "New metadata";
    const cached = queryClient.getQueryData<{
      data: { contributors: unknown[]; seeds: { contributors: unknown[] }[] };
    }>(transitReachabilitySurfaceKey(request));
    expect(cached?.data.contributors).toEqual([]);
    expect(cached?.data.seeds[0]?.contributors).toEqual([
      { sourceId: "geometry", name: "Geometry supplier" },
    ]);
  });
  it("captures the actual street routing response receipt and keeps canonical [] authoritative", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      origin: [0, 0],
      mode: "walking",
      contours: [],
      contributors: [],
      attributions: [{ sourceId: "legacy", name: "Legacy" }],
    });
    const { result } = renderHook(
      () => useIsochrone({ origin: [0, 0], mode: "walking", contourMinutes: [15] }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.contributors).toEqual([]);
  });
  it("keeps contour-native [] authoritative over its street response receipt", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      origin: [0, 0],
      mode: "walking",
      contours: [{ time: 15, geometry: polygon.geometry, contributors: [] }],
      contributors: [{ sourceId: "graph", name: "Graph supplier" }],
    });
    const { result } = renderHook(
      () => useIsochrone({ origin: [0, 0], mode: "walking", contourMinutes: [15] }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.contributors).toEqual([
      { sourceId: "graph", name: "Graph supplier" },
    ]);
    expect(result.current.data?.contours[0]?.contributors).toEqual([]);
  });
});
