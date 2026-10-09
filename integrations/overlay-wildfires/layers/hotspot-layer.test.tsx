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

import { DENSITY_LAYER_ID, DENSITY_SOURCE_ID, HotspotLayer } from "./hotspot-layer";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const HEATMAP_LAYER_ID = "openmapx-wildfires-heatmap";
const EMPTY = { type: "FeatureCollection", features: [] };
const BOUNDS = { west: -121, south: 37.5, east: -120, north: 38.5 };
const VIEW_QUERY = "west=-121&south=37.5&east=-120&north=38.5";

const HOTSPOT_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "N20:38.1234,-120.4567:2026-10-09T0930",
      properties: {
        latitude: 38.1234,
        longitude: -120.4567,
        brightness: 300,
        frp: 10,
        confidence: "nominal",
        satellite: "N20",
        acqDate: "2026-10-09",
        acqTime: "0930",
        dayNight: "D",
        ageMs: 60_000,
        instrument: "viirs",
      },
      geometry: { type: "Point" as const, coordinates: [-120.4567, 38.1234] },
    },
  ],
};

const MODIS_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      id: "T:38.2,-120.3:2026-10-09T1000",
      properties: {
        latitude: 38.2,
        longitude: -120.3,
        brightness: null,
        frp: 100,
        confidence: "20",
        satellite: "T",
        acqDate: "2026-10-09",
        acqTime: "1000",
        dayNight: "N",
        ageMs: 1_000,
        instrument: "modis",
      },
      geometry: { type: "Point" as const, coordinates: [-120.3, 38.2] },
    },
  ],
};

const DENSITY_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-120.25, 38.25] },
      properties: { count: 3, frpSum: 21.5, frpMax: 12.1 },
    },
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-119.75, 38.25] },
      properties: { count: 2, frpSum: 4, frpMax: 2.5 },
    },
  ],
  sources: ["nasa-firms-viirs-fires"],
};

const FRESH_HEADERS = {
  "X-OpenMapX-Fetched-At": "2026-10-09T10:00:00.000Z",
  "X-OpenMapX-Stale": "false",
  "X-OpenMapX-Truncated": "false",
  "X-OpenMapX-Sources": "nasa-firms-viirs-fires",
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

/** Answers the points or the density route, whichever is asked. */
function routeFetch() {
  return vi.fn(async (url: string) =>
    String(url).includes("/wildfires/density?")
      ? response(DENSITY_COLLECTION, FRESH_HEADERS)
      : response(HOTSPOT_COLLECTION, FRESH_HEADERS),
  );
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, zoom: 8, bounds: BOUNDS });
  mapContext.mapRef.current = fake.map;
  styleVersion = 0;
  useWildfireStore.setState({ dayRange: 1, source: "viirs", showHeatmap: false });
  useWildfireStore.getState().resetSourceStatus("firms");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HotspotLayer", () => {
  it("does not start a request while inactive", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<HotspotLayer active={false} popupController={popupController()} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(fake.state.sources.has(DENSITY_SOURCE_ID)).toBe(false);
  });

  it("loads the detections in the view from zoom 7", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.test/api/integrations/overlay-wildfires/wildfires?dayRange=1&instrument=viirs&${VIEW_QUERY}&zoom=8`,
    );
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });
    expect(fake.state.sources.get(DENSITY_SOURCE_ID)?.data).toEqual(EMPTY);
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      loading: false,
      fetchedAt: Date.parse("2026-10-09T10:00:00.000Z"),
      stale: false,
      truncated: false,
      error: null,
      featureCount: 1,
      sources: ["nasa-firms-viirs-fires"],
    });
  });

  it("loads density cells below zoom 7 and switches to detections when zoomed in", async () => {
    fake.state.zoom = 4;
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.test/api/integrations/overlay-wildfires/wildfires/density?dayRange=1&instrument=viirs&${VIEW_QUERY}&zoom=4`,
    );
    await waitFor(() => {
      expect(fake.state.sources.get(DENSITY_SOURCE_ID)?.data).toEqual(DENSITY_COLLECTION);
    });
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(EMPTY);
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      featureCount: 5,
      sources: ["nasa-firms-viirs-fires"],
    });

    act(() => {
      fake.state.zoom = 7.4;
      fake.emit("moveend");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/overlay-wildfires/wildfires?");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("zoom=7");
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });
    expect(fake.state.sources.get(DENSITY_SOURCE_ID)?.data).toEqual(EMPTY);
  });

  it("registers density cells below the detections in the points slot", () => {
    vi.stubGlobal("fetch", routeFetch());

    render(<HotspotLayer active popupController={popupController()} />);

    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.type).toBe("circle");
    expect(fake.state.layers.get(DENSITY_LAYER_ID)).toMatchObject({
      type: "circle",
      source: DENSITY_SOURCE_ID,
    });
    expect(layerRegistrations()).toContainEqual({
      id: CIRCLE_LAYER_ID,
      slot: "overlay-points",
      order: 4,
    });
    expect(layerRegistrations()).toContainEqual({
      id: DENSITY_LAYER_ID,
      slot: "overlay-points",
      order: 3.5,
    });
  });

  it("adds the heatmap only when enabled in the heat slot at order zero", () => {
    vi.stubGlobal("fetch", routeFetch());
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

  it("keeps the exact detection circle and heatmap visual contract", () => {
    vi.stubGlobal("fetch", routeFetch());
    useWildfireStore.setState({ showHeatmap: true });
    render(<HotspotLayer active popupController={popupController()} />);

    const frpRadius = [
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
    ];
    expect(fake.state.layers.get(CIRCLE_LAYER_ID)).toMatchObject({
      id: CIRCLE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
    });
    expect(fake.state.paint.get(CIRCLE_LAYER_ID)).toEqual({
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        2,
        ["*", frpRadius, 0.5],
        5,
        ["*", frpRadius, 0.8],
        8,
        frpRadius,
        12,
        ["*", frpRadius, 1.6],
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
      type: "heatmap",
      source: SOURCE_ID,
    });
    expect(fake.state.paint.get(HEATMAP_LAYER_ID)).toMatchObject({
      "heatmap-weight": ["interpolate", ["linear"], ["get", "frp"], 0, 0, 1000, 1],
    });
  });

  it("aborts and replaces the request when the sensor or the hotspot age changes", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      useWildfireStore.getState().setSource("modis");
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);

    act(() => {
      useWildfireStore.getState().setDayRange(3);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(signals[1]?.aborted).toBe(true);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("dayRange=3&instrument=modis");
  });

  it("keeps the drawn detections while a changed sensor's request is pending", async () => {
    let resolveSecond: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetchMock = vi.fn(() => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve(response(HOTSPOT_COLLECTION, FRESH_HEADERS));
      }
      return new Promise<ReturnType<typeof response>>((resolve) => {
        resolveSecond = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });

    act(() => useWildfireStore.getState().setSource("modis"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);

    await act(async () => {
      resolveSecond?.(response(MODIS_COLLECTION, FRESH_HEADERS));
    });
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(MODIS_COLLECTION);
    });
  });

  it("reports a stale and truncated answer from the response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(HOTSPOT_COLLECTION, {
          ...FRESH_HEADERS,
          "X-OpenMapX-Stale": "true",
          "X-OpenMapX-Truncated": "true",
        }),
      ),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms).toMatchObject({
        stale: true,
        truncated: true,
      }),
    );
  });

  it.each([
    [
      "an out-of-range Point geometry",
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
        features: [{ ...HOTSPOT_COLLECTION.features[0], properties: { frp: 10, ageMs: 60_000 } }],
      },
    ],
    ["detections of the other sensor", MODIS_COLLECTION],
  ])("rejects %s before publishing to MapLibre", async (_case, data) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(data, FRESH_HEADERS)),
    );

    render(<HotspotLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(EMPTY);
  });

  it("retains the last good detections and status after a malformed refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(HOTSPOT_COLLECTION, FRESH_HEADERS))
      .mockResolvedValueOnce(response({ type: "FeatureCollection", features: "broken" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<HotspotLayer active popupController={popupController()} />);
    await waitFor(() =>
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION),
    );

    act(() => useWildfireStore.getState().setSource("modis"));

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      fetchedAt: Date.parse("2026-10-09T10:00:00.000Z"),
      featureCount: 1,
    });
  });

  it("aborts its request, removes its layers and resets its status when hidden", async () => {
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
    await waitFor(() => expect(useWildfireStore.getState().statuses.firms.loading).toBe(true));

    rerender(<HotspotLayer active={false} popupController={controller} />);

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(useWildfireStore.getState().statuses.firms).toMatchObject({
      loading: false,
      featureCount: null,
      sources: [],
    });
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(fake.state.sources.has(DENSITY_SOURCE_ID)).toBe(false);
    expect(fake.state.layers.has(DENSITY_LAYER_ID)).toBe(false);
    expect(controller.close).toHaveBeenCalledWith(expect.any(Object));
  });

  it("registers its click and hover listeners once and removes them all on unmount", () => {
    vi.stubGlobal("fetch", routeFetch());
    const { unmount } = render(<HotspotLayer active popupController={popupController()} />);

    for (const layerId of [CIRCLE_LAYER_ID, DENSITY_LAYER_ID]) {
      for (const event of ["click", "mouseenter", "mouseleave"]) {
        expect(
          fake.state.listenerCalls.filter(
            (call) => call.method === "on" && call.event === event && call.layerId === layerId,
          ),
        ).toHaveLength(1);
      }
      expect(INTERACTIVE_LAYER_IDS.has(layerId)).toBe(true);
    }

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
    expect(INTERACTIVE_LAYER_IDS.has(CIRCLE_LAYER_ID)).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has(DENSITY_LAYER_ID)).toBe(false);
  });

  it("escapes external hotspot strings in the popup", () => {
    vi.stubGlobal("fetch", routeFetch());
    const controller = popupController();
    render(<HotspotLayer active popupController={controller} />);
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

    const click = fake.state.listenerCalls.find(
      (call) => call.method === "on" && call.event === "click" && call.layerId === CIRCLE_LAYER_ID,
    );
    act(() => {
      (click?.handler as (e: unknown) => void)({ features: [feature] });
    });

    const popup = controller.open.mock.calls[0]?.[1] as { html?: string } | undefined;
    expect(popup?.html).toContain("&lt;svg onload=&quot;alert(2)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(3)&quot;&gt;");
    expect(popup?.html).not.toContain('<svg onload="alert(2)">');
  });

  it("shows a density cell's count and fire power in its popup", () => {
    vi.stubGlobal("fetch", routeFetch());
    const controller = popupController();
    render(<HotspotLayer active popupController={controller} />);
    const cell = {
      type: "Feature",
      properties: { count: 3, frpSum: 21.5, frpMax: 12.1 },
      geometry: { type: "Point", coordinates: [-120.25, 38.25] },
    } as unknown as MapGeoJSONFeature;

    const click = fake.state.listenerCalls.find(
      (call) => call.method === "on" && call.event === "click" && call.layerId === DENSITY_LAYER_ID,
    );
    act(() => {
      (click?.handler as (e: unknown) => void)({ features: [cell] });
    });

    const popup = controller.open.mock.calls[0]?.[1] as { html?: string } | undefined;
    expect(popup?.html).toContain(">3</span>");
    expect(popup?.html).toContain("maxFirePower: 12.1 MW");
    expect(popup?.html).toContain("totalFirePower: 21.5 MW");
  });
});
