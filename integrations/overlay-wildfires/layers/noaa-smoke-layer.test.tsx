import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import type { WildfirePopupController } from "../popup-controller";
import { useWildfireStore } from "../store";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));
const popupState = vi.hoisted(() => ({
  instances: [] as Array<{ html: string; removeCalls: number }>,
}));
let mapReady = true;
let styleVersion = 0;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady, styleVersion }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en-GB",
  useTranslations: () => (key: string) => `[${key}]`,
}));

vi.mock("maplibre-gl", () => ({
  Popup: class {
    html = "";
    removeCalls = 0;

    constructor() {
      popupState.instances.push(this);
    }

    setLngLat() {
      return this;
    }

    setHTML(value: string) {
      this.html = value;
      return this;
    }

    addTo() {
      return this;
    }

    remove() {
      this.removeCalls += 1;
      return this;
    }
  },
}));

import {
  isNoaaSmokeFeatureCollection,
  NOAA_SMOKE_FILL,
  NOAA_SMOKE_LINE,
  NOAA_SMOKE_SOURCE,
  NoaaSmokeLayer,
} from "./noaa-smoke-layer";

const POLYGON = {
  type: "Polygon" as const,
  coordinates: [
    [
      [8, 50],
      [9, 50],
      [9, 51],
      [8, 50],
    ],
  ],
};

function smokeCollection(overrides: Record<string, unknown> = {}) {
  return {
    type: "FeatureCollection" as const,
    source: "noaa-hms" as const,
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    truncated: false,
    features: [
      {
        type: "Feature" as const,
        id: "noaa-hms:7",
        properties: {
          id: "noaa-hms:7",
          kind: "observed-smoke" as const,
          provider: "noaa-hms" as const,
          density: "heavy" as const,
          satellite: '<GOES & "West">',
          startedAt: "2026-08-12T10:00:00.000Z",
          endedAt: "2026-08-12T11:00:00.000Z",
        },
        geometry: POLYGON,
      },
    ],
    ...overrides,
  };
}

function popupController() {
  return {
    open: vi.fn(),
    close: vi.fn(),
  } as unknown as WildfirePopupController & {
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => body } as Response;
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
  fake = createFakeMap({ baseLayers: [{ id: "place-labels", type: "symbol" }] });
  mapContext.mapRef.current = fake.map;
  mapReady = true;
  styleVersion = 0;
  popupState.instances.length = 0;
  useWildfireStore.getState().resetSourceStatus("noaa-hms");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NOAA smoke response validation", () => {
  it("accepts the complete normalized NOAA cache envelope", () => {
    expect(isNoaaSmokeFeatureCollection(smokeCollection())).toBe(true);
  });

  it.each([
    ["wrong source", { source: "nifc" }],
    ["non-canonical fetchedAt", { fetchedAt: "2026-08-12T12:00:00Z" }],
    ["missing stale", { stale: undefined }],
    ["missing truncated", { truncated: undefined }],
  ])("rejects an envelope with %s", (_label, overrides) => {
    expect(isNoaaSmokeFeatureCollection(smokeCollection(overrides))).toBe(false);
  });

  it.each([
    ["mismatched stable ID", { id: "noaa-hms:8" }],
    ["wrong provider", { provider: "nifc" }],
    ["wrong kind", { kind: "forecast-smoke" }],
    ["unknown density", { density: "extreme" }],
    ["invalid optional satellite", { satellite: 42 }],
    ["invalid optional timestamp", { startedAt: "2026-08-12" }],
  ])("rejects NOAA properties with %s", (_label, propertyOverride) => {
    const collection = smokeCollection();
    collection.features[0] = {
      ...collection.features[0],
      properties: { ...collection.features[0].properties, ...propertyOverride },
    } as (typeof collection.features)[number];
    expect(isNoaaSmokeFeatureCollection(collection)).toBe(false);
  });

  it.each([
    { type: "Point", coordinates: [8, 50] },
    {
      type: "Polygon",
      coordinates: [
        [
          [8, 50],
          [9, 50],
          [9, 51],
          [8.5, 50],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [181, 50],
          [9, 50],
          [9, 51],
          [181, 50],
        ],
      ],
    },
  ])("rejects invalid smoke geometry %#", (geometry) => {
    const collection = smokeCollection();
    collection.features[0] = {
      ...collection.features[0],
      geometry,
    } as (typeof collection.features)[number];
    expect(isNoaaSmokeFeatureCollection(collection)).toBe(false);
  });
});

describe("NoaaSmokeLayer", () => {
  it("does not fetch or register smoke while disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active={false} popupController={popupController()} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.state.sources.has(NOAA_SMOKE_SOURCE)).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has(NOAA_SMOKE_FILL)).toBe(false);
  });

  it("fetches globally and registers density-styled smoke below burned areas and perimeters", async () => {
    const fetchMock = vi.fn(async () => response(smokeCollection()));
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active popupController={popupController()} />);

    await waitFor(() =>
      expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(smokeCollection()),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/integrations/overlay-wildfires/smoke/noaa",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fake.state.paint.get(NOAA_SMOKE_FILL)?.["fill-opacity"]).toEqual([
      "match",
      ["get", "density"],
      "light",
      0.08,
      "medium",
      0.15,
      "heavy",
      0.24,
      0.08,
    ]);
    expect(fake.state.paint.get(NOAA_SMOKE_FILL)?.["fill-color"]).toEqual([
      "match",
      ["get", "density"],
      "light",
      "#cbd5e1",
      "medium",
      "#94a3b8",
      "heavy",
      "#64748b",
      "#94a3b8",
    ]);
    expect(fake.state.layers.get(NOAA_SMOKE_FILL)?.type).toBe("fill");
    expect(fake.state.layers.get(NOAA_SMOKE_LINE)?.type).toBe("line");
    expect(layerRegistrations()).toEqual(
      expect.arrayContaining([
        { id: NOAA_SMOKE_FILL, slot: "area-overlays", order: 0 },
        { id: NOAA_SMOKE_LINE, slot: "area-overlays", order: 1 },
      ]),
    );
    expect([...fake.state.layers.keys()]).toEqual([
      NOAA_SMOKE_FILL,
      NOAA_SMOKE_LINE,
      "place-labels",
    ]);
    expect(useWildfireStore.getState().statuses["noaa-hms"]).toMatchObject({
      loading: false,
      fetchedAt: Date.parse("2026-08-12T12:00:00.000Z"),
      stale: false,
      truncated: false,
      error: null,
      featureCount: 1,
    });
  });

  it("starts exactly one initial fetch when the map becomes ready after mount", async () => {
    mapReady = false;
    mapContext.mapRef.current = null;
    const fetchMock = vi.fn(async () => response(smokeCollection()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = popupController();
    const view = render(<NoaaSmokeLayer active popupController={controller} />);

    expect(fetchMock).not.toHaveBeenCalled();

    mapContext.mapRef.current = fake.map;
    mapReady = true;
    view.rerender(<NoaaSmokeLayer active popupController={controller} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(smokeCollection()),
    );

    styleVersion += 1;
    view.rerender(<NoaaSmokeLayer active popupController={controller} />);
    act(() => fake.emit("styledata"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes every ten minutes and retains the last good collection on failure", async () => {
    vi.useFakeTimers();
    const first = smokeCollection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response({ code: "noaa_hms_unavailable" }, false));
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active popupController={popupController()} />);
    await vi.waitFor(() => expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(first));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(first);
    expect(useWildfireStore.getState().statuses["noaa-hms"]).toMatchObject({
      loading: false,
      error: "unavailable",
      featureCount: 1,
    });
  });

  it("rejects malformed refresh data without replacing the rendered collection", async () => {
    vi.useFakeTimers();
    const first = smokeCollection();
    const malformed = smokeCollection({ fetchedAt: "yesterday" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(malformed));
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active popupController={popupController()} />);
    await vi.waitFor(() => expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(first));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    await vi.waitFor(() =>
      expect(useWildfireStore.getState().statuses["noaa-hms"].error).toBe("unavailable"),
    );

    expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(first);
  });

  it("aborts the previous refresh and publishes only the newest response", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const newest = smokeCollection({ fetchedAt: "2026-08-12T12:10:00.000Z", features: [] });
    const fetchMock = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response(newest));
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active popupController={popupController()} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    await vi.waitFor(() => expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(newest));

    await act(async () => {
      resolveFirst(response(smokeCollection()));
      await Promise.resolve();
    });
    expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(newest);
  });

  it("replays retained smoke after a style replacement without refetching", async () => {
    const collection = smokeCollection();
    const fetchMock = vi.fn(async () => response(collection));
    vi.stubGlobal("fetch", fetchMock);

    render(<NoaaSmokeLayer active popupController={popupController()} />);
    await waitFor(() =>
      expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(collection),
    );

    act(() => fake.map.setStyle({ version: 8, sources: {}, layers: [] }));

    await waitFor(() =>
      expect(fake.state.sources.get(NOAA_SMOKE_SOURCE)?.data).toEqual(collection),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens a safe localized observed-smoke popup with both caveats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(smokeCollection())),
    );
    const controller = popupController();
    const { unmount } = render(<NoaaSmokeLayer active popupController={controller} />);
    await waitFor(() => expect(fake.state.layers.has(NOAA_SMOKE_FILL)).toBe(true));

    const feature = smokeCollection().features[0] as unknown as MapGeoJSONFeature;
    act(() => {
      delegatedHandler(
        "click",
        NOAA_SMOKE_FILL,
      )({ features: [feature], lngLat: { lng: 8, lat: 50 } });
    });

    expect(controller.open).toHaveBeenCalledTimes(1);
    const lease = controller.open.mock.calls[0]?.[0];
    expect(lease).toEqual(expect.any(Object));
    expect(controller.open).toHaveBeenCalledWith(lease, expect.anything());
    const html = popupState.instances[0]?.html ?? "";
    expect(html).toContain("[observedSmoke]");
    expect(html).toContain("[noaaObservedSmokeCaveat]");
    expect(html).toContain("[noaaSmokeDensityCaveat]");
    expect(html).toContain("&lt;GOES &amp; &quot;West&quot;&gt;");
    expect(html).not.toContain('<GOES & "West">');

    unmount();
    expect(controller.close).toHaveBeenCalledWith(lease);
  });

  it("aborts, removes layers and listeners, closes the popup, and resets status when disabled", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }),
    );
    const controller = popupController();
    const view = render(<NoaaSmokeLayer active popupController={controller} />);
    await waitFor(() =>
      expect(useWildfireStore.getState().statuses["noaa-hms"].loading).toBe(true),
    );
    expect(INTERACTIVE_LAYER_IDS.has(NOAA_SMOKE_FILL)).toBe(true);

    view.rerender(<NoaaSmokeLayer active={false} popupController={controller} />);

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(fake.state.sources.has(NOAA_SMOKE_SOURCE)).toBe(false);
    expect(fake.state.layers.has(NOAA_SMOKE_FILL)).toBe(false);
    expect(fake.state.layers.has(NOAA_SMOKE_LINE)).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has(NOAA_SMOKE_FILL)).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has(NOAA_SMOKE_LINE)).toBe(false);
    expect(useWildfireStore.getState().statuses["noaa-hms"]).toMatchObject({
      loading: false,
      fetchedAt: null,
      error: null,
      featureCount: null,
    });
    expect(controller.close).toHaveBeenCalledWith(expect.any(Object));
    for (const event of ["styledata", "click", "mouseenter", "mouseleave"]) {
      const ons = fake.state.listenerCalls.filter(
        (call) => call.method === "on" && call.event === event,
      );
      const offs = fake.state.listenerCalls.filter(
        (call) => call.method === "off" && call.event === event,
      );
      expect(offs.length).toBe(ons.length);
    }
  });
});
