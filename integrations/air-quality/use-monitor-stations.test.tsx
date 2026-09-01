import type {
  AirQualityStationFeature,
  AirQualityStationsResponse,
  AirQualityWarningCode,
} from "@openmapx/air-quality";
import { ApiClientError, apiClient } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, renderHook, waitFor } from "@/test";

import { useAirQualityStore } from "./store";

let fake: FakeMap;
let styleVersion = 0;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion }),
}));

const { MONITOR_SOURCE_ID, useMonitorStations } = await import("./use-monitor-stations");

const AT = "2026-08-30T12:00:00.000Z";

function feature(id: string, value = 12.5): AirQualityStationFeature {
  return {
    type: "Feature",
    id: `stn_1_${id.padEnd(48, "a")}`,
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    properties: {
      stationId: `stn_1_${id.padEnd(48, "a")}`,
      name: `Station ${id}`,
      pollutant: "pm25",
      value,
      unit: "ug/m3",
      intervalStart: "2026-08-30T11:00:00.000Z",
      intervalEnd: AT,
      freshness: "fresh",
      qualityStatus: "quality-assured",
      observedAt: AT,
      stationClass: "reference",
      mobile: false,
      completenessPercent: 100,
      estimated: false,
      gapFilled: false,
      owner: "Fixture owner",
      providerId: "fixture-provider",
      sourceIds: ["fixture-source"],
      localIndex: null,
    },
  };
}

function page(
  input: {
    features?: AirQualityStationFeature[];
    nextCursor?: string | null;
    warnings?: AirQualityWarningCode[];
    truncated?: boolean;
  } = {},
): AirQualityStationsResponse {
  const features = input.features ?? [];
  return {
    type: "FeatureCollection",
    features,
    nextCursor: input.nextCursor ?? null,
    meta: {
      generatedAt: AT,
      cache: "miss",
      providersCandidate: ["fixture-provider"],
      providersServed: ["fixture-provider"],
      providersFailed: [],
      providersPolicyExcluded: [],
      truncated: input.truncated ?? false,
      warnings: input.warnings ?? [],
      candidateCount: features.length,
      servedCount: features.length,
      skippedCount: 0,
    },
  };
}

function mountSource(): void {
  fake.map.addSource(MONITOR_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
}

function showMonitors(): void {
  useAirQualityStore.setState({
    panelOpen: true,
    layerVisible: true,
    mode: { kind: "monitors", pollutant: "pm25" },
  });
}

beforeEach(() => {
  styleVersion = 0;
  fake = createFakeMap({
    zoom: 8,
    bounds: { west: 13, south: 52, east: 14, north: 53 },
  });
  mountSource();
  useAirQualityStore.getState().reset();
  showMonitors();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  useAirQualityStore.getState().reset();
});

describe("useMonitorStations", () => {
  it("does not request below zoom 5", async () => {
    fake.state.zoom = 4.9;
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(page());
    renderHook(() => useMonitorStations());
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it("requests the canonical bounded route with viewport, zoom, pollutant, and abort", async () => {
    fake = createFakeMap({
      zoom: 7,
      bounds: { west: 170, south: -10, east: -170, north: 10 },
    });
    mountSource();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(page({ features: [feature("one")] }));
    renderHook(() => useMonitorStations());

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith(
      "/api/integrations/air-quality/stations",
      {
        south: "-10",
        west: "170",
        north: "10",
        east: "-170",
        zoom: "7",
        pollutant: "pm25",
        limit: "500",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(JSON.stringify(get.mock.calls)).not.toContain("overlay-air-quality");
  });

  it("paginates one immutable snapshot and publishes only after the final page", async () => {
    const get = vi.spyOn(apiClient, "get");
    get.mockResolvedValueOnce(page({ features: [feature("one")], nextCursor: "cursor-1" }));
    get.mockResolvedValueOnce(
      page({
        features: [feature("two", 24)],
        warnings: ["partial_providers"],
        truncated: true,
      }),
    );

    renderHook(() => useMonitorStations());
    await waitFor(() => expect(useAirQualityStore.getState().hasData).toBe(true));

    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/integrations/air-quality/stations",
      expect.objectContaining({ cursor: "cursor-1" }),
      { signal: expect.any(AbortSignal) },
    );
    const data = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as {
      features: AirQualityStationFeature[];
    };
    expect(data.features.map(({ properties }) => properties.value)).toEqual([12.5, 24]);
    expect(fake.state.counts.setData.get(MONITOR_SOURCE_ID)).toBe(1);
    expect(useAirQualityStore.getState()).toMatchObject({
      warnings: ["partial_providers"],
      truncated: true,
      activeSourceIds: ["fixture-source"],
      error: null,
    });
  });

  it("restarts once without a cursor when an immutable snapshot expires", async () => {
    const get = vi.spyOn(apiClient, "get");
    get.mockResolvedValueOnce(page({ features: [feature("old")], nextCursor: "expired" }));
    get.mockRejectedValueOnce(new ApiClientError(409, { code: "CURSOR_EXPIRED" }, null));
    get.mockResolvedValueOnce(page({ features: [feature("new", 33)] }));

    renderHook(() => useMonitorStations());
    await waitFor(() => expect(useAirQualityStore.getState().hasData).toBe(true));

    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[2]?.[1]).not.toHaveProperty("cursor");
    const data = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as {
      features: AirQualityStationFeature[];
    };
    expect(data.features).toHaveLength(1);
    expect(data.features[0]?.properties.value).toBe(33);
  });

  it("caps accumulation at 2,000 and records that the viewport is truncated", async () => {
    const get = vi.spyOn(apiClient, "get").mockImplementation(async (_path, query) => {
      const pageIndex = query?.cursor ? Number(query.cursor.slice(1)) : 0;
      return page({
        features: Array.from({ length: 500 }, (_, index) =>
          feature(`${pageIndex}-${index}`, pageIndex * 500 + index),
        ),
        nextCursor: `c${pageIndex + 1}`,
      });
    });

    renderHook(() => useMonitorStations());
    await waitFor(() => expect(useAirQualityStore.getState().hasData).toBe(true));

    expect(get).toHaveBeenCalledTimes(4);
    const data = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as { features: unknown[] };
    expect(data.features).toHaveLength(2_000);
    expect(useAirQualityStore.getState().truncated).toBe(true);
  });

  it("debounces moves, aborts the old request, and lets only the newest request publish", async () => {
    vi.useFakeTimers();
    const pending: Array<{
      signal: AbortSignal;
      resolve: (response: AirQualityStationsResponse) => void;
    }> = [];
    vi.spyOn(apiClient, "get").mockImplementation(
      (_path, _query, options) =>
        new Promise((resolve) => pending.push({ signal: options?.signal as AbortSignal, resolve })),
    );
    renderHook(() => useMonitorStations());
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    act(() => {
      fake.emit("moveend");
      fake.emit("moveend");
      vi.advanceTimersByTime(799);
    });
    expect(pending).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.signal.aborted).toBe(true);

    await act(async () => pending[1]?.resolve(page({ features: [feature("newest", 44)] })));
    await act(async () => pending[0]?.resolve(page({ features: [feature("stale", 1)] })));
    const data = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as {
      features: AirQualityStationFeature[];
    };
    expect(data.features[0]?.properties.value).toBe(44);
  });

  it("aborts on hide and unmount and clears active attribution immediately", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(apiClient, "get").mockImplementation((_path, _query, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const view = renderHook(() => useMonitorStations());
    await waitFor(() => expect(signal).toBeDefined());

    act(() => useAirQualityStore.getState().setLayerVisible(false));
    expect(signal?.aborted).toBe(true);
    expect(useAirQualityStore.getState().activeSourceIds).toEqual([]);

    showMonitors();
    await waitFor(() => expect(signal?.aborted).toBe(false));
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("preserves the last markers and source credits on a transient error", async () => {
    const get = vi.spyOn(apiClient, "get");
    get.mockResolvedValueOnce(page({ features: [feature("retained", 19)] }));
    renderHook(() => useMonitorStations());
    await waitFor(() => expect(useAirQualityStore.getState().hasData).toBe(true));
    const prior = fake.state.sources.get(MONITOR_SOURCE_ID)?.data;

    get.mockRejectedValueOnce(new ApiClientError(503, null, null));
    act(() => fake.emit("moveend"));
    await new Promise((resolve) => setTimeout(resolve, 850));
    await waitFor(() => expect(useAirQualityStore.getState().error).toBe("unavailable"));

    expect(fake.state.sources.get(MONITOR_SOURCE_ID)?.data).toBe(prior);
    expect(useAirQualityStore.getState()).toMatchObject({
      hasData: true,
      activeSourceIds: ["fixture-source"],
    });
  });

  it("clears old-pollutant markers before publishing the replacement snapshot", async () => {
    let resolveReplacement: ((response: AirQualityStationsResponse) => void) | undefined;
    const get = vi.spyOn(apiClient, "get");
    get.mockResolvedValueOnce(page({ features: [feature("pm25", 19)] }));
    get.mockImplementationOnce(() => new Promise((resolve) => (resolveReplacement = resolve)));
    renderHook(() => useMonitorStations());
    await waitFor(() => expect(useAirQualityStore.getState().hasData).toBe(true));

    act(() => useAirQualityStore.getState().setMonitorPollutant("o3"));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const cleared = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as { features: unknown[] };
    expect(cleared.features).toEqual([]);
    expect(useAirQualityStore.getState()).toMatchObject({ hasData: false, activeSourceIds: [] });

    await act(async () => resolveReplacement?.(page({ features: [feature("o3", 27)] })));
    const replaced = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as {
      features: AirQualityStationFeature[];
    };
    expect(replaced.features[0]?.properties.value).toBe(27);
  });
});
