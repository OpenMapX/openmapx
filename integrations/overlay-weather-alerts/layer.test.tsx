import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useWeatherAlertStore } from "./store";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));
vi.mock("@/integration-api/overlay/useIntegrationAttribution", () => ({
  useSourceAttributions: vi.fn(),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
vi.mock("maplibre-gl", () => ({ Popup: class {} }));

import { ALERT_DISPLAY_MAX_AGE_MS, WeatherAlertLayer } from "./map-layer";

const SOURCE_ID = "openmapx-weather-alerts-source";
const T = Date.parse("2026-10-09T12:00:00Z");

function feature(id: string, expires: string | null) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [8, 50] },
    properties: { id, severity: "Severe", geometryType: "point", expires },
  };
}

const ALERTS = {
  type: "FeatureCollection",
  features: [
    feature("current", "2026-10-09T18:00:00Z"),
    feature("open-ended", null),
    feature("ended", "2026-10-09T11:59:00Z"),
  ],
  sources: ["eu-meteoalarm-alerts"],
};

let fake: FakeMap;
let now = T;
let answer: () => Response;

const drawn = () =>
  (
    fake.state.sources.get(SOURCE_ID)?.data as
      | { features: { properties: { id: string } }[] }
      | undefined
  )?.features.map((f) => f.properties.id);

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  mapContext.mapRef.current = fake.map;
  now = T;
  useMapAttributionStore.setState({ byLayer: {} });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  answer = () => new Response(JSON.stringify(ALERTS), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => answer()),
  );
  useWeatherAlertStore.setState({ layerVisible: true, alertCount: 0, unavailable: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function becomeVisible() {
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("WeatherAlertLayer freshness", () => {
  it("drops the alerts whose expiry passed when it draws them", async () => {
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(drawn()).toEqual(["current", "open-ended"]));
    expect(useWeatherAlertStore.getState().alertCount).toBe(2);
  });

  it("keeps the last alerts through a failed refresh while they are recent", async () => {
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(drawn()).toEqual(["current", "open-ended"]));

    now = T + ALERT_DISPLAY_MAX_AGE_MS - 1_000;
    answer = () => new Response("{}", { status: 503 });
    becomeVisible();
    await waitFor(() => expect(useWeatherAlertStore.getState().unavailable).toBe(true));
    expect(drawn()).toEqual(["current", "open-ended"]);
  });

  it("clears the layer once its last successful load is older than the bound", async () => {
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(drawn()).toEqual(["current", "open-ended"]));

    now = T + ALERT_DISPLAY_MAX_AGE_MS + 1_000;
    answer = () => new Response("{}", { status: 503 });
    becomeVisible();
    await waitFor(() => expect(drawn()).toEqual([]));
    expect(useWeatherAlertStore.getState()).toMatchObject({ alertCount: 0, unavailable: true });
  });

  it("clears the layer when the bound passes, with no refresh in between", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(drawn()).toEqual(["current", "open-ended"]));
    const clear = timers.mock.calls.find(([, delay]) => (delay ?? 0) > ALERT_DISPLAY_MAX_AGE_MS);
    expect(clear?.[1]).toBeLessThanOrEqual(ALERT_DISPLAY_MAX_AGE_MS + 1_000);
    const expire = clear?.[0] as () => void;

    now = T + ALERT_DISPLAY_MAX_AGE_MS + 1;
    act(() => {
      expire();
    });
    expect(drawn()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches at once when the tab becomes visible", async () => {
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(drawn()).toEqual(["current", "open-ended"]));
    becomeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("shows the service as unavailable when the route answers 503 from the start", async () => {
    answer = () => new Response("{}", { status: 503 });
    render(<WeatherAlertLayer />);
    await waitFor(() => expect(useWeatherAlertStore.getState().unavailable).toBe(true));
    expect(drawn() ?? []).toEqual([]);
  });
});

it("captures per-feature receipts before last-good retention and keeps them through a failed refresh", async () => {
  const a = { sourceId: "a", name: "Captured A" };
  answer = () =>
    new Response(
      JSON.stringify({
        ...ALERTS,
        sources: ["a", "offscreen"],
        features: [
          {
            ...feature("a", null),
            properties: { ...feature("a", null).properties, contributors: [a], sources: ["a"] },
          },
        ],
      }),
    );
  render(<WeatherAlertLayer />);
  await waitFor(() => expect(drawn()).toEqual(["a"]));
  const data = fake.state.sources.get(SOURCE_ID)?.data as {
    features: { properties: Record<string, unknown> }[];
  };
  expect(JSON.parse(String(data.features[0]?.properties._mapAttributions))).toEqual([a]);
  now += 60_000;
  answer = () => new Response("{}", { status: 503 });
  becomeVisible();
  await waitFor(() => expect(useWeatherAlertStore.getState().unavailable).toBe(true));
  expect(
    (fake.state.sources.get(SOURCE_ID)?.data as typeof data).features[0]?.properties
      ._mapAttributions,
  ).toBe(data.features[0]?.properties._mapAttributions);
});

it("credits only rendered unexpired severity-filtered alerts during panning, worker lag and no idle", async () => {
  const supplied = (id: string, expires: string | null, severity = "Severe") => ({
    ...feature(id, expires),
    properties: {
      ...feature(id, expires).properties,
      severity,
      sources: [id],
      contributors: [{ sourceId: id, name: `Publisher ${id}` }],
    },
  });
  answer = () =>
    new Response(
      JSON.stringify({
        type: "FeatureCollection",
        sources: ["a", "b", "offscreen"],
        features: [
          supplied("a", new Date(T + 60_000).toISOString()),
          supplied("b", null),
          supplied("offscreen", null, "Minor"),
        ],
      }),
    );
  render(<WeatherAlertLayer />);
  await waitFor(() => expect(drawn()).toEqual(["a", "b", "offscreen"]));
  const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection;
  const hits = (ids: string[]) => {
    fake.state.renderedFeatures.set(
      "openmapx-weather-alerts-points",
      data.features
        .filter((f) => ids.includes(String(f.properties?.id)))
        .map(
          (f) =>
            ({
              ...f,
              layer: { id: "openmapx-weather-alerts-points", type: "circle" },
            }) as MapGeoJSONFeature,
        ),
    );
    fake.emit("render");
  };
  const credits = () => Object.values(useMapAttributionStore.getState().byLayer).flat().sort();
  act(() => hits(["a", "b"]));
  await waitFor(() => expect(credits()).toEqual(["Publisher a", "Publisher b"]));
  fake.state.styleLoaded = false; // A pending unrelated source never reaches idle.
  act(() => hits(["a"]));
  await waitFor(() => expect(credits()).toEqual(["Publisher a"]));
  now = T + 61_000;
  answer = () => new Response("{}", { status: 503 });
  becomeVisible();
  await waitFor(() => expect(drawn()).toEqual(["b", "offscreen"]));
  // The old worker snapshot still paints A until source processing catches up.
  expect(credits()).toEqual(["Publisher a"]);
  act(() => hits(["b"]));
  await waitFor(() => expect(credits()).toEqual(["Publisher b"]));
  act(() => hits([]));
  await waitFor(() => expect(credits()).toEqual([]));
});
