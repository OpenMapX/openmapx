import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import type { WildfirePopupController } from "../popup-controller";
import { useWildfireStore } from "../store";

const translations = vi.hoisted(() => ({ t: (key: string) => key }));
const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));
const env = vi.hoisted(() => ({ apiUrl: "https://api.test" }));

let fake: FakeMap;
let styleVersion = 0;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: mapContext.mapRef,
    mapReady: true,
    styleVersion,
  }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => env,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => translations.t,
}));

vi.mock("maplibre-gl", () => ({
  Popup: class {
    html = "";

    setLngLat() {
      return this;
    }

    setHTML(html: string) {
      this.html = html;
      return this;
    }

    addTo() {
      return this;
    }

    remove() {
      return this;
    }
  },
}));

import { HotspotLayer } from "./hotspot-layer";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const HEATMAP_LAYER_ID = "openmapx-wildfires-heatmap";

const HOTSPOT_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {
        latitude: 50,
        longitude: 8,
        brightness: 300,
        frp: 10,
        confidence: "nominal",
        satellite: "N",
        acqDate: "2026-08-12",
        acqTime: "1200",
        dayNight: "D",
        ageMs: 60_000,
        source: "VIIRS_SNPP_NRT",
      },
      geometry: { type: "Point" as const, coordinates: [8, 50] },
    },
  ],
};

const REPLACEMENT_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {
        latitude: 51,
        longitude: 9,
        brightness: 320,
        frp: 100,
        confidence: "80",
        satellite: "T",
        acqDate: "2026-08-12",
        acqTime: "1230",
        dayNight: "N",
        ageMs: 1_000,
        source: "MODIS_NRT",
      },
      geometry: { type: "Point" as const, coordinates: [9, 51] },
    },
  ],
};

function popupController() {
  return {
    open: vi.fn(),
    close: vi.fn(),
  } as unknown as WildfirePopupController & {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function response(data: unknown = HOTSPOT_COLLECTION, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), json: async () => data };
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  mapContext.mapRef.current = fake.map;
  styleVersion = 0;
  useWildfireStore.setState({
    loading: false,
    dayRange: 1,
    source: "VIIRS_SNPP_NRT",
    showHeatmap: false,
    lastUpdated: null,
  });
  useWildfireStore.getState().resetSourceStatus("firms");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HotspotLayer", () => {
  it("does not start a FIRMS request while inactive", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<HotspotLayer active={false} popupController={popupController()} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
  });

  it("loads FIRMS hotspots once when activated", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.test/api/integrations/overlay-wildfires/wildfires?dayRange=1&source=VIIRS_SNPP_NRT",
    );
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });
  });

  it("registers circles in the points slot at order four", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.type).toBe("circle");
    expect(layerRegistrations()).toContainEqual({
      id: CIRCLE_LAYER_ID,
      slot: "overlay-points",
      order: 4,
    });
  });

  it("adds the heatmap only when enabled in the heat slot at order zero", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const { rerender } = render(<HotspotLayer active popupController={popupController()} />);

    expect(fake.state.layers.has(HEATMAP_LAYER_ID)).toBe(false);

    act(() => {
      useWildfireStore.getState().setShowHeatmap(true);
    });
    rerender(<HotspotLayer active popupController={popupController()} />);

    expect(fake.state.layers.get(HEATMAP_LAYER_ID)?.type).toBe("heatmap");
    expect(layerRegistrations()).toContainEqual({
      id: HEATMAP_LAYER_ID,
      slot: "overlay-heat",
      order: 0,
    });
  });

  it("keeps the exact FIRMS circle and heatmap visual contract", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    useWildfireStore.setState({ showHeatmap: true });
    render(<HotspotLayer active popupController={popupController()} />);

    expect(fake.state.sources.get(SOURCE_ID)).toMatchObject({ type: "geojson" });
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)).toMatchObject({
      id: CIRCLE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
    });
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)).not.toHaveProperty("minzoom");
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)).not.toHaveProperty("maxzoom");
    expect(fake.state.paint.get(CIRCLE_LAYER_ID)).toEqual({
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        2,
        [
          "*",
          [
            "interpolate",
            ["linear"],
            ["get", "frp"],
            0,
            3,
            10,
            5,
            50,
            8,
            200,
            13,
            500,
            18,
            1000,
            24,
          ],
          0.5,
        ],
        5,
        [
          "*",
          [
            "interpolate",
            ["linear"],
            ["get", "frp"],
            0,
            3,
            10,
            5,
            50,
            8,
            200,
            13,
            500,
            18,
            1000,
            24,
          ],
          0.8,
        ],
        8,
        ["interpolate", ["linear"], ["get", "frp"], 0, 3, 10, 5, 50, 8, 200, 13, 500, 18, 1000, 24],
        12,
        [
          "*",
          [
            "interpolate",
            ["linear"],
            ["get", "frp"],
            0,
            3,
            10,
            5,
            50,
            8,
            200,
            13,
            500,
            18,
            1000,
            24,
          ],
          1.6,
        ],
      ],
      "circle-color": [
        "interpolate",
        ["linear"],
        ["get", "ageMs"],
        0,
        "#ef4444",
        3_600_000,
        "#f97316",
        21_600_000,
        "#fb923c",
        43_200_000,
        "#fbbf24",
        86_400_000,
        "#fcd34d",
        172_800_000,
        "#fde68a",
      ],
      "circle-opacity": 0.8,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 0.8,
    });
    expect(fake.state.layers.get(HEATMAP_LAYER_ID)).toMatchObject({
      id: HEATMAP_LAYER_ID,
      type: "heatmap",
      source: SOURCE_ID,
    });
    expect(fake.state.layers.get(HEATMAP_LAYER_ID)).not.toHaveProperty("minzoom");
    expect(fake.state.layers.get(HEATMAP_LAYER_ID)).not.toHaveProperty("maxzoom");
    expect(fake.state.paint.get(HEATMAP_LAYER_ID)).toEqual({
      "heatmap-weight": ["interpolate", ["linear"], ["get", "frp"], 0, 0, 1000, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 3],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,0,0)",
        0.2,
        "#ffffb2",
        0.4,
        "#fecc5c",
        0.6,
        "#fd8d3c",
        0.8,
        "#f03b20",
        1.0,
        "#bd0026",
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 9, 30],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 12, 0],
    });
  });

  it("aborts and replaces the FIRMS request when sensor or hotspot age changes", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      useWildfireStore.getState().setSource("MODIS_NRT");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);

    act(() => {
      useWildfireStore.getState().setDayRange(3);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(signals[1]?.aborted).toBe(true);
    expect(String(fetchMock.mock.calls[2][0])).toContain("dayRange=3&source=MODIS_NRT");
  });

  it("replays retained FIRMS data immediately through a style reload while a replacement waits", async () => {
    const pendingResponses: Array<(value: ReturnType<typeof response>) => void> = [];
    const fetchMock = vi.fn(() => {
      if (fetchMock.mock.calls.length === 1) return Promise.resolve(response(HOTSPOT_COLLECTION));
      return new Promise<ReturnType<typeof response>>((resolve) => pendingResponses.push(resolve));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = popupController();
    useWildfireStore.setState({ showHeatmap: true });
    const { rerender } = render(<HotspotLayer active popupController={controller} />);
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });

    act(() => {
      useWildfireStore.getState().setSource("MODIS_NRT");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => {
      fake.map.setStyle({} as never);
      styleVersion = 1;
      rerender(<HotspotLayer active popupController={controller} />);
    });
    await act(async () => {});

    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.type).toBe("circle");
    expect(fake.state.layers.get(HEATMAP_LAYER_ID)?.type).toBe("heatmap");
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pendingResponses).toHaveLength(2);

    await act(async () => {
      pendingResponses[1]?.(response(REPLACEMENT_COLLECTION));
    });
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(REPLACEMENT_COLLECTION);
    });
  });

  it("uses exact delegated FIRMS listener signatures and replaces them without duplicates", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const controller = popupController();
    const { rerender, unmount } = render(<HotspotLayer active popupController={controller} />);
    const mountedCalls = [...fake.state.listenerCalls];
    const clickRegistration = mountedCalls.find(
      (call) => call.method === "on" && call.event === "click" && call.layerId === CIRCLE_LAYER_ID,
    );
    const enterRegistration = mountedCalls.find(
      (call) =>
        call.method === "on" && call.event === "mouseenter" && call.layerId === CIRCLE_LAYER_ID,
    );
    const leaveRegistration = mountedCalls.find(
      (call) =>
        call.method === "on" && call.event === "mouseleave" && call.layerId === CIRCLE_LAYER_ID,
    );
    const styleRegistrations = mountedCalls.filter(
      (call) => call.method === "on" && call.event === "styledata" && call.layerId === undefined,
    );

    expect(clickRegistration).toBeDefined();
    expect(enterRegistration).toBeDefined();
    expect(leaveRegistration).toBeDefined();
    expect(styleRegistrations).toHaveLength(2);
    expect(INTERACTIVE_LAYER_IDS.has(CIRCLE_LAYER_ID)).toBe(true);
    expect(fake.state.handlers.get("click")?.size).toBe(1);
    expect(fake.state.handlers.get("mouseenter")?.size).toBe(1);
    expect(fake.state.handlers.get("mouseleave")?.size).toBe(1);
    expect(fake.state.handlers.get("styledata")?.size).toBe(2);

    const callsBeforePlainRerender = fake.state.listenerCalls.length;
    rerender(<HotspotLayer active popupController={controller} />);
    expect(fake.state.listenerCalls).toHaveLength(callsBeforePlainRerender);

    act(() => {
      fake.emit("mouseenter");
    });
    expect(fake.state.canvas.style.cursor).toBe("pointer");
    act(() => {
      fake.emit("mouseleave");
    });
    expect(fake.state.canvas.style.cursor).toBe("");

    styleVersion = 1;
    rerender(<HotspotLayer active popupController={controller} />);
    for (const registration of [
      clickRegistration,
      enterRegistration,
      leaveRegistration,
      ...styleRegistrations,
    ]) {
      expect(fake.state.listenerCalls).toContainEqual({
        method: "off",
        event: registration?.event,
        layerId: registration?.layerId,
        handler: registration?.handler,
      });
    }
    expect(fake.state.handlers.get("click")?.size).toBe(1);
    expect(fake.state.handlers.get("mouseenter")?.size).toBe(1);
    expect(fake.state.handlers.get("mouseleave")?.size).toBe(1);
    expect(fake.state.handlers.get("styledata")?.size).toBe(2);

    unmount();
    const onCalls = fake.state.listenerCalls.filter((call) => call.method === "on");
    for (const registration of onCalls) {
      expect(fake.state.listenerCalls).toContainEqual({
        method: "off",
        event: registration.event,
        layerId: registration.layerId,
        handler: registration.handler,
      });
    }
    expect(fake.state.handlers.get("click")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("mouseenter")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("mouseleave")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("styledata")?.size ?? 0).toBe(0);
    expect(INTERACTIVE_LAYER_IDS.has(CIRCLE_LAYER_ID)).toBe(false);
  });

  it("aborts an active request and clears loading when hidden", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const controller = popupController();
    const { rerender } = render(<HotspotLayer active popupController={controller} />);
    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(true));

    rerender(<HotspotLayer active={false} popupController={controller} />);

    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(false));
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(controller.close).toHaveBeenCalledWith(expect.any(Object));
  });

  it("aborts an active request and clears loading when unmounted", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const { unmount } = render(<HotspotLayer active popupController={popupController()} />);
    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(true));

    unmount();

    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(false));
  });

  it("clears loading without updating the timestamp when FIRMS responds non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => HOTSPOT_COLLECTION })),
    );
    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(false));
    expect(useWildfireStore.getState().lastUpdated).toBeNull();
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("clears loading without updating the timestamp when FIRMS JSON decoding fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => Promise.reject(new Error("invalid JSON")),
      })),
    );
    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(useWildfireStore.getState().loading).toBe(false));
    expect(useWildfireStore.getState().lastUpdated).toBeNull();
  });

  it("sets lastUpdated only after a current successful FIRMS response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(useWildfireStore.getState().lastUpdated).not.toBeNull());
    expect(useWildfireStore.getState().loading).toBe(false);
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      loading: false,
      fetchedAt: expect.any(Number),
      stale: false,
      truncated: false,
      error: null,
      featureCount: 1,
    });
  });

  it("uses the server's original fetched time and fresh status headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(HOTSPOT_COLLECTION, {
          "X-OpenMapX-Fetched-At": "2026-08-12T10:00:00.000Z",
          "X-OpenMapX-Stale": "false",
        }),
      ),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        fetchedAt: Date.parse("2026-08-12T10:00:00.000Z"),
        stale: false,
      }),
    );
    expect(useWildfireStore.getState().lastUpdated).toBe(Date.parse("2026-08-12T10:00:00.000Z"));
  });

  it("preserves the original fetched time when FIRMS serves stale fallback data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(HOTSPOT_COLLECTION, {
          "X-OpenMapX-Fetched-At": "2026-08-12T09:00:00.000Z",
          "X-OpenMapX-Stale": "true",
        }),
      ),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        fetchedAt: Date.parse("2026-08-12T09:00:00.000Z"),
        stale: true,
      }),
    );
  });

  it("falls back to receipt time and fresh status for legacy servers without metadata headers", async () => {
    const receiptTime = Date.parse("2026-08-12T12:34:56.789Z");
    vi.spyOn(Date, "now").mockReturnValue(receiptTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        fetchedAt: receiptTime,
        stale: false,
      }),
    );
  });

  it("falls back safely when either FIRMS metadata header is malformed", async () => {
    const receiptTime = Date.parse("2026-08-12T12:34:56.789Z");
    vi.spyOn(Date, "now").mockReturnValue(receiptTime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(HOTSPOT_COLLECTION, {
          "X-OpenMapX-Fetched-At": "not-a-date",
          "X-OpenMapX-Stale": "true",
        }),
      ),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        fetchedAt: receiptTime,
        stale: false,
      }),
    );
  });

  it.each([
    [
      "out-of-range Point geometry",
      {
        ...HOTSPOT_COLLECTION,
        features: [
          {
            ...HOTSPOT_COLLECTION.features[0],
            geometry: { type: "Point", coordinates: [181, 50] },
          },
        ],
      },
    ],
    [
      "missing required properties",
      {
        ...HOTSPOT_COLLECTION,
        features: [
          {
            ...HOTSPOT_COLLECTION.features[0],
            properties: { frp: 10, ageMs: 60_000 },
          },
        ],
      },
    ],
    [
      "a mixed valid and invalid collection",
      {
        ...HOTSPOT_COLLECTION,
        features: [
          HOTSPOT_COLLECTION.features[0],
          {
            ...HOTSPOT_COLLECTION.features[0],
            geometry: { type: "Point", coordinates: [8, Number.POSITIVE_INFINITY] },
          },
        ],
      },
    ],
  ])("rejects %s before publishing to MapLibre", async (_case, data) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(data)),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual({
      type: "FeatureCollection",
      features: [],
    });
    expect(useWildfireStore.getState().lastUpdated).toBeNull();
  });

  it("accepts and publishes a valid empty FIRMS collection", async () => {
    const empty = { type: "FeatureCollection" as const, features: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(empty)),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(empty));
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      error: null,
      featureCount: 0,
    });
  });

  it("retains last-good FIRMS data and status metadata after a malformed refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(HOTSPOT_COLLECTION, {
          "X-OpenMapX-Fetched-At": "2026-08-12T10:00:00.000Z",
          "X-OpenMapX-Stale": "false",
        }),
      )
      .mockResolvedValueOnce(
        response({
          ...REPLACEMENT_COLLECTION,
          features: [
            {
              ...REPLACEMENT_COLLECTION.features[0],
              geometry: { type: "LineString", coordinates: [[9, 51]] },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);
    await waitFor(() =>
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION),
    );

    act(() => useWildfireStore.getState().setSource("MODIS_NRT"));

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      fetchedAt: Date.parse("2026-08-12T10:00:00.000Z"),
      stale: false,
      featureCount: 1,
    });
  });

  it("reports a FIRMS failure independently and resets its status when hidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    const view = render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );
    expect(useWildfireStore.getState().statuses.nifc.error).toBeNull();

    view.rerender(<HotspotLayer active={false} popupController={popupController()} />);
    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        loading: false,
        fetchedAt: null,
        error: null,
        featureCount: null,
      }),
    );
  });

  it("suppresses a stale FIRMS response after a newer request publishes", async () => {
    let resolveFirst: ((value: ReturnType<typeof response>) => void) | undefined;
    let resolveSecond: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetchMock = vi.fn(
      (_url: string) =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          if (resolveFirst) resolveSecond = resolve;
          else resolveFirst = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      useWildfireStore.getState().setSource("MODIS_NRT");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    if (!resolveFirst || !resolveSecond) throw new Error("both FIRMS requests did not start");

    await act(async () => {
      resolveSecond?.(response(REPLACEMENT_COLLECTION));
    });
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(REPLACEMENT_COLLECTION);
    });
    const latestUpdated = useWildfireStore.getState().lastUpdated;

    await act(async () => {
      resolveFirst?.(response(HOTSPOT_COLLECTION));
    });
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(REPLACEMENT_COLLECTION);
    expect(useWildfireStore.getState().lastUpdated).toBe(latestUpdated);
  });

  it("escapes external hotspot strings before handing popup HTML to the coordinator", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const controller = popupController();
    const { unmount } = render(<HotspotLayer active popupController={controller} />);
    const feature = {
      type: "Feature",
      properties: {
        frp: 12,
        brightness: 301,
        confidence: '<img src=x onerror="alert(1)">',
        satellite: '<svg onload="alert(2)">',
        ageMs: 60_000,
        dayNight: "D",
        acqDate: '<img src=x onerror="alert(3)">',
        acqTime: "1234",
      },
      geometry: { type: "Point", coordinates: [8, 50] },
    } as unknown as MapGeoJSONFeature;

    act(() => {
      fake.emit("click", { features: [feature] });
    });

    expect(controller.open).toHaveBeenCalledTimes(1);
    const lease = controller.open.mock.calls[0]?.[0];
    expect(lease).toEqual(expect.any(Object));
    expect(controller.open).toHaveBeenCalledWith(lease, expect.anything());
    const popup = controller.open.mock.calls[0]?.[1] as { html?: string } | undefined;
    expect(popup?.html).toContain("&lt;svg onload=&quot;alert(2)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(3)&quot;&gt;");
    expect(popup?.html).not.toContain('<svg onload="alert(2)">');

    unmount();
    expect(controller.close).toHaveBeenCalledWith(lease);
  });
});
