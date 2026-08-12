import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import type { WildfirePopupController } from "../popup-controller";
import { useWildfireStore } from "../store";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));
const popupState = vi.hoisted(() => ({
  instances: [] as Array<{
    html: string;
    lngLat: unknown;
    addToCalls: number;
    removeCalls: number;
  }>,
}));

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en-GB",
  useTranslations: () => (key: string, values?: { value?: string }) =>
    values?.value === undefined ? `[${key}]` : `[${key}:${values.value}]`,
}));

vi.mock("maplibre-gl", () => ({
  Popup: class {
    html = "";
    lngLat: unknown;
    addToCalls = 0;
    removeCalls = 0;

    constructor() {
      popupState.instances.push(this);
    }

    setLngLat(value: unknown) {
      this.lngLat = value;
      return this;
    }

    setHTML(value: string) {
      this.html = value;
      return this;
    }

    addTo() {
      this.addToCalls += 1;
      return this;
    }

    remove() {
      this.removeCalls += 1;
      return this;
    }
  },
}));

import { EffisBurnedAreaLayer } from "./effis-burned-area-layer";
import { NifcPerimeterLayer } from "./nifc-perimeter-layer";

const NIFC_SOURCE = "openmapx-wildfires-nifc-source";
const NIFC_FILL = "openmapx-wildfires-nifc-fill";
const NIFC_LINE = "openmapx-wildfires-nifc-line";
const EFFIS_SOURCE = "openmapx-wildfires-effis-source";
const EFFIS_FILL = "openmapx-wildfires-effis-fill";
const EFFIS_LINE = "openmapx-wildfires-effis-line";

const NIFC_COLLECTION = {
  type: "FeatureCollection" as const,
  source: "nifc" as const,
  fetchedAt: "2026-08-12T12:00:00.000Z",
  stale: false,
  truncated: false,
  features: [
    {
      type: "Feature" as const,
      id: "nifc:1",
      properties: {
        id: "nifc:1",
        kind: "reported-perimeter" as const,
        provider: "nifc" as const,
        coverage: "United States" as const,
        name: '<Pine & "Ridge">',
        areaAcres: 100,
        containmentPercent: 25,
        observedAt: "2026-08-12T11:00:00.000Z",
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [8, 50],
            [9, 50],
            [9, 51],
            [8, 50],
          ],
        ],
      },
    },
  ],
};

const EFFIS_COLLECTION = {
  type: "FeatureCollection" as const,
  source: "effis" as const,
  fetchedAt: "2026-08-12T11:30:00.000Z",
  stale: false,
  truncated: false,
  features: [
    {
      type: "Feature" as const,
      id: "effis:1",
      properties: {
        id: "effis:1",
        kind: "satellite-burned-area" as const,
        provider: "effis" as const,
        areaHectares: 250,
        locality: "Vila <Nova>",
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [8, 50],
            [9, 50],
            [9, 51],
            [8, 50],
          ],
        ],
      },
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

function successFor(url: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => (url.includes("perimeters/nifc") ? NIFC_COLLECTION : EFFIS_COLLECTION),
  } as Response;
}

function delegatedHandler(event: string, layerId: string) {
  const call = fake.state.listenerCalls.find(
    (entry) => entry.method === "on" && entry.event === event && entry.layerId === layerId,
  );
  if (!call) throw new Error(`Missing ${event} handler for ${layerId}`);
  return call.handler;
}

let fake: FakeMap;

beforeEach(() => {
  fake = createFakeMap({ zoom: 4, baseLayers: [{ id: "place-labels", type: "symbol" }] });
  mapContext.mapRef.current = fake.map;
  popupState.instances.length = 0;
  useWildfireStore.setState({
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wildfire perimeter layers", () => {
  it("creates independently sourced polygon layers in semantic stack order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successFor(url)),
    );
    const controller = popupController();

    render(
      <>
        <EffisBurnedAreaLayer active popupController={controller} />
        <NifcPerimeterLayer active popupController={controller} />
      </>,
    );

    await waitFor(() => expect(fake.state.sources.get(NIFC_SOURCE)?.data).toEqual(NIFC_COLLECTION));
    await waitFor(() =>
      expect(fake.state.sources.get(EFFIS_SOURCE)?.data).toEqual(EFFIS_COLLECTION),
    );
    expect(fake.state.layers.get(EFFIS_FILL)).toMatchObject({ type: "fill", minzoom: 3 });
    expect(fake.state.layers.get(EFFIS_LINE)).toMatchObject({ type: "line", minzoom: 3 });
    expect(fake.state.layers.get(NIFC_FILL)).toMatchObject({ type: "fill", minzoom: 3 });
    expect(fake.state.layers.get(NIFC_LINE)).toMatchObject({ type: "line", minzoom: 3 });
    expect(fake.state.paint.get(EFFIS_LINE)?.["line-dasharray"]).toEqual([3, 2]);
    expect(fake.state.paint.get(NIFC_LINE)?.["line-dasharray"]).toBeUndefined();
    expect(layerRegistrations()).toEqual(
      expect.arrayContaining([
        { id: EFFIS_FILL, slot: "area-overlays", order: 10 },
        { id: EFFIS_LINE, slot: "area-overlays", order: 11 },
        { id: NIFC_FILL, slot: "area-overlays", order: 20 },
        { id: NIFC_LINE, slot: "area-overlays", order: 21 },
      ]),
    );
    expect([...fake.state.layers.keys()]).toEqual([
      EFFIS_FILL,
      EFFIS_LINE,
      NIFC_FILL,
      NIFC_LINE,
      "place-labels",
    ]);
  });

  it("retains each last good collection when the other source fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("perimeters/nifc")
        ? successFor(url)
        : ({
            ok: false,
            status: 503,
            json: async () => ({ code: "effis_unavailable" }),
          } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <>
        <EffisBurnedAreaLayer active popupController={popupController()} />
        <NifcPerimeterLayer active popupController={popupController()} />
      </>,
    );

    await waitFor(() => expect(fake.state.sources.get(NIFC_SOURCE)?.data).toEqual(NIFC_COLLECTION));
    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.effis.error).toBe("unavailable"),
    );
    expect(useWildfireStore.getState().statuses.nifc.featureCount).toBe(1);
    expect(fake.state.sources.get(EFFIS_SOURCE)?.data).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("recreates both styles and replays retained data without a replacement fetch", async () => {
    const fetchMock = vi.fn(async (url: string) => successFor(url));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <EffisBurnedAreaLayer active popupController={popupController()} />
        <NifcPerimeterLayer active popupController={popupController()} />
      </>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.state.sources.get(NIFC_SOURCE)?.data).toEqual(NIFC_COLLECTION));

    act(() => fake.map.setStyle({} as never));
    await act(async () => {});

    expect(fake.state.layers.has(NIFC_FILL)).toBe(true);
    expect(fake.state.layers.has(EFFIS_FILL)).toBe(true);
    expect(fake.state.sources.get(NIFC_SOURCE)?.data).toEqual(NIFC_COLLECTION);
    expect(fake.state.sources.get(EFFIS_SOURCE)?.data).toEqual(EFFIS_COLLECTION);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders NIFC as a reported perimeter and EFFIS with its satellite-derived caveat", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successFor(url)),
    );
    const controller = popupController();
    const { unmount } = render(
      <>
        <EffisBurnedAreaLayer active popupController={controller} />
        <NifcPerimeterLayer active popupController={controller} />
      </>,
    );
    await waitFor(() => expect(fake.state.sources.get(NIFC_SOURCE)?.data).toEqual(NIFC_COLLECTION));

    act(() => {
      delegatedHandler(
        "click",
        NIFC_FILL,
      )({
        lngLat: { lng: 8.5, lat: 50.5 },
        features: [NIFC_COLLECTION.features[0] as unknown as MapGeoJSONFeature],
      });
    });
    const nifcPopup = popupState.instances.at(-1);
    expect(nifcPopup?.html).toContain("&lt;Pine &amp; &quot;Ridge&quot;&gt;");
    expect(nifcPopup?.html).toContain("[reportedArea]");
    expect(nifcPopup?.html).toContain("[acres:100]");
    expect(nifcPopup?.html).not.toContain("[effisBurnedAreaCaveat]");

    act(() => {
      delegatedHandler(
        "click",
        EFFIS_LINE,
      )({
        lngLat: { lng: 8.5, lat: 50.5 },
        features: [EFFIS_COLLECTION.features[0] as unknown as MapGeoJSONFeature],
      });
    });
    const effisPopup = popupState.instances.at(-1);
    expect(effisPopup?.html).toContain("[satelliteDerivedBurnedArea]");
    expect(effisPopup?.html).toContain("[effisBurnedAreaCaveat]");
    expect(effisPopup?.html).toContain("Vila &lt;Nova&gt;");
    expect(controller.open).toHaveBeenCalledTimes(2);
    const nifcLease = controller.open.mock.calls[0]?.[0];
    const effisLease = controller.open.mock.calls[1]?.[0];
    expect(nifcLease).toEqual(expect.any(Object));
    expect(effisLease).toEqual(expect.any(Object));
    expect(effisLease).not.toBe(nifcLease);

    unmount();
    expect(controller.close).toHaveBeenCalledWith(nifcLease);
    expect(controller.close).toHaveBeenCalledWith(effisLease);
  });

  it("registers fill and line interactions and removes every listener and registry entry", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successFor(url)),
    );
    const controller = popupController();
    const { unmount } = render(
      <>
        <EffisBurnedAreaLayer active popupController={controller} />
        <NifcPerimeterLayer active popupController={controller} />
      </>,
    );

    for (const layerId of [NIFC_FILL, NIFC_LINE, EFFIS_FILL, EFFIS_LINE]) {
      expect(INTERACTIVE_LAYER_IDS.has(layerId)).toBe(true);
      expect(delegatedHandler("click", layerId)).toBeTypeOf("function");
      expect(delegatedHandler("mouseenter", layerId)).toBeTypeOf("function");
      expect(delegatedHandler("mouseleave", layerId)).toBeTypeOf("function");
    }
    act(() => delegatedHandler("mouseenter", NIFC_LINE)({}));
    expect(fake.state.canvas.style.cursor).toBe("pointer");
    act(() => delegatedHandler("mouseleave", NIFC_LINE)({}));
    expect(fake.state.canvas.style.cursor).toBe("");

    unmount();

    for (const layerId of [NIFC_FILL, NIFC_LINE, EFFIS_FILL, EFFIS_LINE]) {
      expect(INTERACTIVE_LAYER_IDS.has(layerId)).toBe(false);
      expect(fake.state.layers.has(layerId)).toBe(false);
      expect(layerRegistrations().some((entry) => entry.id === layerId)).toBe(false);
    }
    expect(fake.state.sources.has(NIFC_SOURCE)).toBe(false);
    expect(fake.state.sources.has(EFFIS_SOURCE)).toBe(false);
    const registrations = fake.state.listenerCalls.filter((entry) => entry.method === "on");
    for (const registration of registrations) {
      expect(fake.state.listenerCalls).toContainEqual({ ...registration, method: "off" });
    }
    expect(controller.close).toHaveBeenCalledTimes(2);
    for (const [lease] of controller.close.mock.calls) {
      expect(lease).toEqual(expect.any(Object));
    }
  });

  it("removes only the toggled source and aborts only its in-flight request", async () => {
    const signals = new Map<string, AbortSignal>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        signals.set(
          url.includes("perimeters/nifc") ? "nifc" : "effis",
          init?.signal as AbortSignal,
        );
        return new Promise<Response>(() => {});
      }),
    );
    const controller = popupController();
    const { rerender } = render(
      <>
        <EffisBurnedAreaLayer active popupController={controller} />
        <NifcPerimeterLayer active popupController={controller} />
      </>,
    );
    await waitFor(() => expect(signals.size).toBe(2));

    rerender(
      <>
        <EffisBurnedAreaLayer active popupController={controller} />
        <NifcPerimeterLayer active={false} popupController={controller} />
      </>,
    );

    expect(signals.get("nifc")?.aborted).toBe(true);
    expect(signals.get("effis")?.aborted).toBe(false);
    expect(fake.state.sources.has(NIFC_SOURCE)).toBe(false);
    expect(fake.state.sources.has(EFFIS_SOURCE)).toBe(true);
  });

  it("removes polygon map content below zoom three and restores it after zooming in", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => successFor(url));
    vi.stubGlobal("fetch", fetchMock);
    render(<NifcPerimeterLayer active popupController={popupController()} />);
    await act(async () => {});
    expect(fake.state.sources.has(NIFC_SOURCE)).toBe(true);

    fake.state.zoom = 2.9;
    act(() => fake.emit("moveend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fake.state.sources.has(NIFC_SOURCE)).toBe(false);
    expect(fake.state.layers.has(NIFC_FILL)).toBe(false);
    expect(fake.state.layers.has(NIFC_LINE)).toBe(false);

    fake.state.zoom = 3;
    act(() => fake.emit("moveend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fake.state.sources.has(NIFC_SOURCE)).toBe(true);
    expect(fake.state.layers.has(NIFC_FILL)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
