import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, renderHook, waitFor } from "@/test";
import { useWildfireStore, type WildfireSourceId } from "../store";
import type { WildfireFeatureCollection } from "../types";
import { useViewportWildfireSource } from "./use-viewport-wildfire-source";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));

const EMPTY_COLLECTION: WildfireFeatureCollection = {
  type: "FeatureCollection",
  features: [],
  source: "nifc",
  fetchedAt: "2026-08-12T12:00:00.000Z",
  stale: false,
  truncated: false,
};

function response(
  data: WildfireFeatureCollection = EMPTY_COLLECTION,
  options: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => data,
  } as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountSource(
  options: Partial<{
    active: boolean;
    sourceId: WildfireSourceId;
    endpoint: string;
    refreshMs: number;
    publish: (data: WildfireFeatureCollection) => void;
    clear: () => void;
  }> = {},
) {
  const params = {
    active: true,
    sourceId: "nifc" as const,
    endpoint: "https://api.test/api/integrations/overlay-wildfires/perimeters/nifc",
    minZoom: 3,
    refreshMs: 300_000,
    publish: vi.fn<(data: WildfireFeatureCollection) => void>(),
    clear: vi.fn<() => void>(),
    ...options,
  };
  const hook = renderHook((props) => useViewportWildfireSource(props), {
    initialProps: params,
  });
  return { ...hook, params };
}

let fake: FakeMap;

beforeEach(() => {
  fake = createFakeMap({ zoom: 3 });
  mapContext.mapRef.current = fake.map;
  useWildfireStore.setState({
    statuses: {
      firms: {
        loading: false,
        fetchedAt: null,
        stale: false,
        truncated: false,
        error: null,
        featureCount: null,
      },
      nifc: {
        loading: false,
        fetchedAt: null,
        stale: false,
        truncated: false,
        error: null,
        featureCount: null,
      },
      effis: {
        loading: false,
        fetchedAt: null,
        stale: false,
        truncated: false,
        error: null,
        featureCount: null,
      },
      "noaa-hms": {
        loading: false,
        fetchedAt: null,
        stale: false,
        truncated: false,
        error: null,
        featureCount: null,
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useViewportWildfireSource", () => {
  it("fetches the exact viewport at zoom three and preserves an antimeridian crossing", async () => {
    vi.spyOn(fake.map, "getBounds").mockReturnValue({
      getWest: () => 170,
      getSouth: () => -10,
      getEast: () => -170,
      getNorth: () => 10,
    } as ReturnType<FakeMap["map"]["getBounds"]>);
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    mountSource();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      west: "170",
      south: "-10",
      east: "-170",
      north: "10",
      zoom: "3",
    });
  });

  it("suppresses requests below zoom three", () => {
    fake.state.zoom = 2.99;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { params } = mountSource();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(params.clear).toHaveBeenCalledTimes(1);
  });

  it("debounces moveend, floors zoom, and deduplicates an unchanged request URL", async () => {
    vi.useFakeTimers();
    fake.state.zoom = 3.9;
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    mountSource();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      fake.emit("moveend");
      fake.emit("moveend");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("zoom")).toBe("3");
  });

  it("aborts and clears when a viewport move crosses below the zoom threshold", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const { params } = mountSource();
    await act(async () => {});

    fake.state.zoom = 2;
    act(() => fake.emit("moveend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(signal?.aborted).toBe(true);
    expect(params.clear).toHaveBeenCalledTimes(1);
    expect(useWildfireStore.getState().statuses.nifc.loading).toBe(false);
  });

  it("refetches a changed viewport after moveend and lets the newest response win", async () => {
    vi.useFakeTimers();
    const first = deferredResponse();
    const second = deferredResponse();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const bounds = { west: -5, east: 5 };
    vi.spyOn(fake.map, "getBounds").mockImplementation(
      () =>
        ({
          getWest: () => bounds.west,
          getSouth: () => 40,
          getEast: () => bounds.east,
          getNorth: () => 50,
        }) as ReturnType<FakeMap["map"]["getBounds"]>,
    );
    const { params } = mountSource();
    await act(async () => {});

    bounds.west = -4;
    bounds.east = 6;
    act(() => fake.emit("moveend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);

    const newest = { ...EMPTY_COLLECTION, fetchedAt: "2026-08-12T12:05:00.000Z" };
    await act(async () => second.resolve(response(newest)));
    await act(async () => first.resolve(response(EMPTY_COLLECTION)));

    expect(params.publish).toHaveBeenCalledTimes(1);
    expect(params.publish).toHaveBeenCalledWith(newest);
  });

  it("keeps cancellation source-local across two hook instances", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => {});
      }),
    );
    mountSource();
    mountSource({
      sourceId: "effis",
      endpoint: "https://api.test/api/integrations/overlay-wildfires/burned-areas/effis",
      refreshMs: 1_800_000,
    });
    await act(async () => {});

    fake.state.zoom = 2;
    act(() => fake.emit("moveend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(useWildfireStore.getState().statuses.nifc.loading).toBe(false);
    expect(useWildfireStore.getState().statuses.effis.loading).toBe(false);
  });

  it.each([
    ["nifc" as const, 300_000],
    ["effis" as const, 1_800_000],
  ])(
    "refreshes %s at its source interval even when the viewport URL is unchanged",
    async (sourceId, refreshMs) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => response({ ...EMPTY_COLLECTION, source: sourceId }));
      vi.stubGlobal("fetch", fetchMock);
      mountSource({ sourceId, refreshMs });
      await act(async () => {});

      await act(async () => {
        await vi.advanceTimersByTimeAsync(refreshMs);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("publishes valid empty data and propagates cache metadata to source status", async () => {
    const data = {
      ...EMPTY_COLLECTION,
      fetchedAt: "2026-08-12T11:30:00.000Z",
      stale: true,
      truncated: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(data)),
    );
    const { params } = mountSource();

    await waitFor(() => expect(params.publish).toHaveBeenCalledWith(data));
    expect(useWildfireStore.getState().statuses.nifc).toEqual({
      loading: false,
      fetchedAt: Date.parse("2026-08-12T11:30:00.000Z"),
      stale: true,
      truncated: true,
      error: null,
      featureCount: 0,
    });
  });

  it("marks a 503 unavailable without replacing the last good collection", async () => {
    vi.useFakeTimers();
    const good = { ...EMPTY_COLLECTION, features: [{ type: "Feature" } as GeoJSON.Feature] };
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(response(good))
      .mockResolvedValueOnce(response(EMPTY_COLLECTION, { ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { params } = mountSource();
    await act(async () => {});
    expect(params.publish).toHaveBeenCalledWith(good);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(params.publish).toHaveBeenCalledTimes(1);
    expect(useWildfireStore.getState().statuses.nifc).toMatchObject({
      loading: false,
      error: "unavailable",
      featureCount: 1,
    });
  });

  it("aborts on deactivation, clears rendered data, and resets only its source status", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    useWildfireStore.getState().setSourceStatus("effis", { featureCount: 9 });
    const { params, rerender } = mountSource();
    await act(async () => {});

    rerender({ ...params, active: false });

    expect(signal?.aborted).toBe(true);
    expect(params.clear).toHaveBeenCalledTimes(1);
    expect(useWildfireStore.getState().statuses.nifc.featureCount).toBeNull();
    expect(useWildfireStore.getState().statuses.effis.featureCount).toBe(9);
  });
});
