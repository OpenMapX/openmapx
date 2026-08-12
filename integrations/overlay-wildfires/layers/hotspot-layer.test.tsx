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

  it("recreates the source and layers then republishes FIRMS data after a style reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const controller = popupController();
    useWildfireStore.setState({ showHeatmap: true });
    const { rerender } = render(<HotspotLayer active popupController={controller} />);
    await waitFor(() => {
      expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
    });

    act(() => {
      fake.map.setStyle({} as never);
      styleVersion = 1;
      rerender(<HotspotLayer active popupController={controller} />);
    });
    await act(async () => {});

    expect(fake.state.layers.get(CIRCLE_LAYER_ID)?.type).toBe("circle");
    expect(fake.state.layers.get(HEATMAP_LAYER_ID)?.type).toBe("heatmap");
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(HOTSPOT_COLLECTION);
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
