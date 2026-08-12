import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useWildfireStore } from "../store";

let fake: FakeMap;
let styleVersion = 0;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

import { HotspotLayer, type WildfirePopupController } from "./hotspot-layer";

const SOURCE_ID = "openmapx-wildfires-source";
const CIRCLE_LAYER_ID = "openmapx-wildfires-circles";
const HEATMAP_LAYER_ID = "openmapx-wildfires-heatmap";

const HOTSPOT_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { frp: 10, ageMs: 60_000 },
      geometry: { type: "Point" as const, coordinates: [8, 50] },
    },
  ],
};

const REPLACEMENT_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { frp: 100, ageMs: 1_000 },
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

function response(data = HOTSPOT_COLLECTION) {
  return { ok: true, json: async () => data };
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  styleVersion = 0;
  useWildfireStore.setState({
    loading: false,
    dayRange: 1,
    source: "VIIRS_SNPP_NRT",
    showHeatmap: false,
    lastUpdated: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("changes the hotspot cursor on entry, clears it on leave, and unregisters listeners on unmount", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const { unmount } = render(<HotspotLayer active popupController={popupController()} />);
    fake.setRenderedFeatures(CIRCLE_LAYER_ID, [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [8, 50] },
      } as MapGeoJSONFeature,
    ]);

    act(() => {
      fake.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(fake.state.canvas.style.cursor).toBe("pointer");

    fake.setRenderedFeatures(CIRCLE_LAYER_ID, []);
    act(() => {
      fake.emit("mousemove", { point: { x: 1, y: 1 } });
    });
    expect(fake.state.canvas.style.cursor).toBe("");

    unmount();
    expect(fake.state.handlers.get("click")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("mousemove")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("styledata")?.size ?? 0).toBe(0);
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

    act(() => {
      fake.emit("click", { features: [feature] });
    });

    expect(controller.open).toHaveBeenCalledTimes(1);
    const popup = controller.open.mock.calls[0]?.[0] as { html?: string } | undefined;
    expect(popup?.html).toContain("&lt;svg onload=&quot;alert(2)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(popup?.html).toContain("&lt;img src=x onerror=&quot;alert(3)&quot;&gt;");
    expect(popup?.html).not.toContain('<svg onload="alert(2)">');
  });
});
