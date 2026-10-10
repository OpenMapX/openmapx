import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useWildfireStore } from "../store";

const attributionState = vi.hoisted(() => ({ filtered: vi.fn() }));
const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));
const popupState = vi.hoisted(() => ({
  instances: [] as Array<{ removeCalls: number }>,
}));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useSourceAttributions: attributionState.filtered,
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en-GB",
  useTranslations: () => (key: string) => `[${key}]`,
}));

vi.mock("maplibre-gl", () => ({
  Popup: class {
    removeCalls = 0;

    constructor() {
      popupState.instances.push(this);
    }

    setLngLat() {
      return this;
    }

    setHTML() {
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

import { WildfireLayer } from "../map-layer";

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

const FEED = {
  nifc: "us-nifc-fires",
  effis: "eu-effis-fires",
  "noaa-hms": "us-noaa-hms-smoke",
} as const;
const VIIRS = "nasa-firms-viirs-fires";

function providerCollection(source: "nifc" | "effis" | "noaa-hms") {
  const id = `${source}:1`;
  return {
    type: "FeatureCollection" as const,
    source,
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    truncated: false,
    sources: [FEED[source]],
    features: [
      {
        type: "Feature" as const,
        id,
        properties:
          source === "nifc"
            ? {
                id,
                kind: "reported-perimeter" as const,
                provider: FEED.nifc,
                name: "Pine Fire",
              }
            : source === "effis"
              ? {
                  id,
                  kind: "satellite-burned-area" as const,
                  provider: FEED.effis,
                  areaHectares: 42,
                }
              : {
                  id,
                  kind: "observed-smoke" as const,
                  provider: FEED["noaa-hms"],
                  density: "medium" as const,
                },
        geometry: POLYGON,
      },
    ],
  };
}

/** At the test's zoom 4 hotspots load as density cells. */
const DENSITY_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [8.25, 50.25] },
      properties: { count: 2, frpSum: 20, frpMax: 12 },
    },
  ],
  sources: [VIIRS],
};

const HOTSPOT_FEATURE = {
  type: "Feature",
  properties: {
    latitude: 50,
    longitude: 8,
    frp: 12,
    brightness: 301,
    confidence: "high",
    satellite: "VIIRS",
    ageMs: 60_000,
    dayNight: "D",
    acqDate: "2026-08-12",
    acqTime: "1234",
    instrument: "viirs",
  },
  geometry: { type: "Point", coordinates: [8, 50] },
} as unknown as MapGeoJSONFeature;

function successfulResponse(url: string): Response {
  const data = url.includes("perimeters/nifc")
    ? providerCollection("nifc")
    : url.includes("burned-areas/effis")
      ? providerCollection("effis")
      : url.includes("smoke/noaa")
        ? providerCollection("noaa-hms")
        : DENSITY_COLLECTION;
  return { ok: true, status: 200, json: async () => data } as Response;
}

function handler(event: string, layerId: string) {
  const call = fake.state.listenerCalls.find(
    (entry) => entry.method === "on" && entry.event === event && entry.layerId === layerId,
  );
  if (!call) throw new Error(`Missing ${event} handler for ${layerId}`);
  return call.handler;
}

let fake: FakeMap;

beforeEach(() => {
  fake = createFakeMap({ zoom: 4 });
  mapContext.mapRef.current = fake.map;
  popupState.instances.length = 0;
  attributionState.filtered.mockClear();
  useWildfireStore.setState({
    layerVisible: true,
    showHotspots: true,
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
    showNoaaSmoke: false,
    showHeatmap: false,
    dayRange: 1,
    source: "viirs",
  });
  for (const sourceId of ["firms", "nifc", "effis", "noaa-hms"] as const) {
    useWildfireStore.getState().resetSourceStatus(sourceId);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WildfireLayer source orchestration", () => {
  it("fetches hotspots and both default polygon sources but leaves NOAA smoke off", async () => {
    const fetchMock = vi.fn(async (url: string) => successfulResponse(url));
    vi.stubGlobal("fetch", fetchMock);

    render(<WildfireLayer />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/wildfires/density?"))).toBe(true);
    expect(urls.some((url) => url.includes("/perimeters/nifc?"))).toBe(true);
    expect(urls.some((url) => url.includes("/burned-areas/effis?"))).toBe(true);
    expect(urls.some((url) => url.includes("/smoke/noaa"))).toBe(false);
    expect(fake.state.sources.has("openmapx-wildfires-noaa-smoke-source")).toBe(false);
  });

  it("mounts opt-in smoke and the master toggle tears down every selected source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successfulResponse(url)),
    );
    useWildfireStore.setState({ showNoaaSmoke: true });
    render(<WildfireLayer />);

    await waitFor(() => expect(fake.state.sources.size).toBe(5));
    const layerIds = [...fake.state.layers.keys()];
    expect(layerIds.indexOf("openmapx-wildfires-noaa-smoke-fill")).toBeLessThan(
      layerIds.indexOf("openmapx-wildfires-effis-fill"),
    );
    expect(layerIds.indexOf("openmapx-wildfires-effis-fill")).toBeLessThan(
      layerIds.indexOf("openmapx-wildfires-nifc-fill"),
    );
    expect(layerIds.indexOf("openmapx-wildfires-nifc-fill")).toBeLessThan(
      layerIds.indexOf("openmapx-wildfires-circles"),
    );
    act(() => useWildfireStore.setState({ layerVisible: false }));
    await waitFor(() => expect(fake.state.sources.size).toBe(0));

    expect(useWildfireStore.getState()).toMatchObject({
      showHotspots: true,
      showNifcPerimeters: true,
      showEffisBurnedAreas: true,
      showNoaaSmoke: true,
    });
    for (const status of Object.values(useWildfireStore.getState().statuses)) {
      expect(status).toMatchObject({ loading: false, fetchedAt: null, featureCount: null });
    }
  });

  it("keeps successful sources rendered when one provider returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("burned-areas/effis")
          ? ({
              ok: false,
              status: 503,
              json: async () => ({ code: "effis_unavailable" }),
            } as Response)
          : successfulResponse(url),
      ),
    );
    render(<WildfireLayer />);

    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.effis.error).toBe("unavailable"),
    );
    expect(fake.state.sources.get("openmapx-wildfires-nifc-source")?.data).toEqual(
      providerCollection("nifc"),
    );
    expect(fake.state.sources.has("openmapx-wildfires-source")).toBe(true);
    expect(fake.state.layers.has("openmapx-wildfires-nifc-fill")).toBe(true);
  });

  it("keeps the hotspot age range scoped to hotspots without refreshing NOAA smoke", async () => {
    const fetchMock = vi.fn(async (url: string) => successfulResponse(url));
    vi.stubGlobal("fetch", fetchMock);
    useWildfireStore.setState({
      showNifcPerimeters: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: true,
    });
    render(<WildfireLayer />);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/smoke/noaa")),
      ).toHaveLength(1);
    });

    act(() => useWildfireStore.getState().setDayRange(3));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/wildfires/density?dayRange=3&instrument=viirs"),
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/smoke/noaa")),
    ).toHaveLength(1);
  });

  it("credits exactly the sources the enabled layers drew", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successfulResponse(url)),
    );
    useWildfireStore.setState({ showEffisBurnedAreas: false, showNoaaSmoke: true });
    render(<WildfireLayer />);

    await waitFor(() =>
      expect(attributionState.filtered).toHaveBeenLastCalledWith("wildfires", [
        VIIRS,
        FEED.nifc,
        FEED["noaa-hms"],
      ]),
    );
    expect(
      attributionState.filtered.mock.calls.some(([, ids]) =>
        (ids as string[]).includes(FEED.effis),
      ),
    ).toBe(false);
  });

  it("credits hotspot sources once drawn and drops them when hotspots are hidden", async () => {
    let resolveRequest!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    );
    useWildfireStore.setState({
      showNifcPerimeters: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: false,
    });
    render(<WildfireLayer />);

    await waitFor(() =>
      expect(attributionState.filtered).toHaveBeenLastCalledWith("wildfires", []),
    );

    await act(async () => {
      resolveRequest(successfulResponse("https://api.test/wildfires/density?dayRange=1"));
    });
    await waitFor(() =>
      expect(attributionState.filtered).toHaveBeenLastCalledWith("wildfires", [VIIRS]),
    );

    act(() => useWildfireStore.getState().setShowHotspots(false));
    await waitFor(() =>
      expect(attributionState.filtered).toHaveBeenLastCalledWith("wildfires", []),
    );
  });

  it("keeps hotspot attribution after a failed refresh retains last-good data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulResponse("https://api.test/wildfires/density?dayRange=1"))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    useWildfireStore.setState({
      showNifcPerimeters: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: false,
    });
    render(<WildfireLayer />);

    await waitFor(() => expect(useWildfireStore.getState().statuses.firms.featureCount).toBe(2));
    act(() => useWildfireStore.getState().setDayRange(2));
    await waitFor(() =>
      expect(useWildfireStore.getState().statuses.firms.error).toBe("unavailable"),
    );

    expect(attributionState.filtered).toHaveBeenLastCalledWith("wildfires", [VIIRS]);
  });

  it("removes the first popup when a different source opens the next one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successfulResponse(url)),
    );
    useWildfireStore.setState({ showEffisBurnedAreas: false });
    render(<WildfireLayer />);
    await waitFor(() => expect(fake.state.layers.has("openmapx-wildfires-nifc-fill")).toBe(true));

    act(() => {
      handler("click", "openmapx-wildfires-circles")({ features: [HOTSPOT_FEATURE] });
    });
    expect(popupState.instances).toHaveLength(1);
    act(() => {
      handler(
        "click",
        "openmapx-wildfires-nifc-fill",
      )({
        features: [providerCollection("nifc").features[0]],
        lngLat: { lng: 8, lat: 50 },
      });
    });

    expect(popupState.instances).toHaveLength(2);
    expect(popupState.instances[0]?.removeCalls).toBe(1);
    expect(popupState.instances[1]?.removeCalls).toBe(0);
  });

  it("does not close a perimeter popup when inactive smoke cleans up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successfulResponse(url)),
    );
    useWildfireStore.setState({
      showHotspots: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: true,
    });
    render(<WildfireLayer />);
    await waitFor(() =>
      expect(fake.state.layers.has("openmapx-wildfires-noaa-smoke-fill")).toBe(true),
    );

    act(() => {
      handler(
        "click",
        "openmapx-wildfires-nifc-fill",
      )({
        features: [providerCollection("nifc").features[0]],
        lngLat: { lng: 8, lat: 50 },
      });
    });
    expect(popupState.instances).toHaveLength(1);

    act(() => useWildfireStore.getState().setShowNoaaSmoke(false));
    await waitFor(() =>
      expect(fake.state.layers.has("openmapx-wildfires-noaa-smoke-fill")).toBe(false),
    );
    expect(popupState.instances[0]?.removeCalls).toBe(0);
  });

  it("ignores old-owner cleanup after replacement and lets the current owner close", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successfulResponse(url)),
    );
    useWildfireStore.setState({
      showHotspots: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: true,
    });
    render(<WildfireLayer />);
    await waitFor(() =>
      expect(fake.state.layers.has("openmapx-wildfires-noaa-smoke-fill")).toBe(true),
    );

    act(() => {
      handler(
        "click",
        "openmapx-wildfires-nifc-fill",
      )({
        features: [providerCollection("nifc").features[0]],
        lngLat: { lng: 8, lat: 50 },
      });
      handler(
        "click",
        "openmapx-wildfires-noaa-smoke-fill",
      )({
        features: [providerCollection("noaa-hms").features[0]],
        lngLat: { lng: 8, lat: 50 },
      });
    });
    expect(popupState.instances).toHaveLength(2);
    expect(popupState.instances[0]?.removeCalls).toBe(1);

    act(() => useWildfireStore.getState().setShowNifcPerimeters(false));
    await waitFor(() => expect(fake.state.layers.has("openmapx-wildfires-nifc-fill")).toBe(false));
    expect(popupState.instances[1]?.removeCalls).toBe(0);

    act(() => useWildfireStore.getState().setShowNoaaSmoke(false));
    await waitFor(() => expect(popupState.instances[1]?.removeCalls).toBe(1));
  });
});
