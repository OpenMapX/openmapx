import type { AirQualityStationFeature, AirQualityStationsResponse } from "@openmapx/air-quality";
import { apiClient } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import {
  act,
  createFakeMap,
  expectStyleSwapIsLossless,
  type FakeMap,
  render,
  waitFor,
} from "@/test";

import { useAirQualityStore } from "../store";

const popupState = vi.hoisted(() => ({
  instances: [] as Array<{
    html: string;
    removeCalls: number;
    lngLat: [number, number] | null;
  }>,
}));
const attributionState = vi.hoisted(() => ({ sources: vi.fn() }));
const monitorHook = vi.hoisted(() => ({
  use: vi.fn(),
  actual: undefined as undefined | (() => void),
}));
const mapContext = vi.hoisted(() => ({
  mapRef: { current: null as FakeMap["map"] | null },
  mapReady: true,
  styleVersion: 0,
}));

vi.mock("@/lib/MapContext", () => ({ useMap: () => mapContext }));
vi.mock("@/lib/useIntegrationAttribution", () => ({
  useSourceAttributions: attributionState.sources,
}));
vi.mock("../use-monitor-stations", async (importOriginal) => {
  const original = await importOriginal<typeof import("../use-monitor-stations")>();
  monitorHook.actual = original.useMonitorStations;
  return { ...original, useMonitorStations: () => monitorHook.use() };
});
vi.mock("next-intl", () => ({
  useLocale: () => "en-GB",
  useTranslations: () => (key: string) => key,
}));
vi.mock("maplibre-gl", () => ({
  Popup: class {
    html = "";
    removeCalls = 0;
    lngLat: [number, number] | null = null;

    constructor() {
      popupState.instances.push(this);
    }

    setLngLat(value: [number, number]) {
      this.lngLat = value;
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

const {
  AirQualityLayer,
  CIVIDIS_CONCENTRATION_EXPRESSION,
  MONITOR_LAYER_ID,
  buildMonitorPopupHtml,
} = await import("../map-layer");
const { MONITOR_SOURCE_ID } = await import("../use-monitor-stations");

let fake: FakeMap;

const FEATURE = {
  type: "Feature",
  id: "stn_1_fixture",
  geometry: { type: "Point", coordinates: [13.4, 52.5] },
  properties: {
    stationId: "stn_1_fixture",
    name: "<script>Central & North</script>",
    pollutant: "pm25",
    value: 137.25,
    unit: "ug/m3",
    intervalStart: "2026-08-30T11:00:00.000Z",
    intervalEnd: "2026-08-30T12:00:00.000Z",
    freshness: "stale",
    qualityStatus: "preliminary",
    observedAt: "2026-08-30T12:00:00.000Z",
    stationClass: "reference",
    mobile: false,
    completenessPercent: 75,
    estimated: true,
    gapFilled: true,
    owner: "Fixture <owner>",
    providerId: "fixture-provider",
    sourceIds: ["fixture-source", "other-source"],
    localIndex: null,
  },
} as unknown as MapGeoJSONFeature;

const POPUP_LABELS = {
  concentration: "Raw concentration",
  observed: "Observed",
  interval: "Interval",
  freshness: "Freshness",
  quality: "Quality",
  stationClass: "Station class",
  completeness: "Completeness",
  provider: "Provider",
  sources: "Sources",
  owner: "Owner",
  mobile: "Mobile",
  fixed: "Fixed",
  estimated: "Estimated",
  gapFilled: "Gap-filled",
  unknown: "Unknown",
  freshnessValues: { fresh: "Fresh", stale: "Stale", unknown: "Unknown" },
  qualityValues: {
    "regulatory-certified": "Regulatory certified",
    "quality-assured": "Quality assured",
    preliminary: "Preliminary",
    estimated: "Estimated",
    unknown: "Unknown",
  },
  stationClassValues: {
    reference: "Reference",
    regulatory: "Regulatory",
    indicative: "Indicative",
    "low-cost": "Low-cost",
    unknown: "Unknown",
  },
} as const;

function show(): void {
  useAirQualityStore.setState({
    panelOpen: true,
    layerVisible: true,
    mode: { kind: "monitors", pollutant: "pm25" },
    activeSourceIds: ["fixture-source"],
  });
}

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true });
  mapContext.mapRef.current = fake.map;
  mapContext.mapReady = true;
  mapContext.styleVersion = 0;
  popupState.instances.length = 0;
  attributionState.sources.mockClear();
  monitorHook.use.mockReset();
  monitorHook.use.mockImplementation(() => undefined);
  useAirQualityStore.getState().reset();
  show();
  INTERACTIVE_LAYER_IDS.delete(MONITOR_LAYER_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => useAirQualityStore.getState().reset());
  INTERACTIVE_LAYER_IDS.delete(MONITOR_LAYER_ID);
});

describe("canonical air-quality monitor layer", () => {
  it("owns one namespaced GeoJSON source and a raw concentration circle layer", () => {
    render(<AirQualityLayer />);

    expect(monitorHook.use).toHaveBeenCalled();
    expect([...fake.state.sources.keys()]).toEqual([MONITOR_SOURCE_ID]);
    expect([...fake.state.layers.keys()]).toEqual([MONITOR_LAYER_ID]);
    expect(fake.state.layers.get(MONITOR_LAYER_ID)).toMatchObject({
      type: "circle",
      source: MONITOR_SOURCE_ID,
      minzoom: 5,
    });
    expect(fake.state.paint.get(MONITOR_LAYER_ID)?.["circle-color"]).toEqual(
      CIVIDIS_CONCENTRATION_EXPRESSION,
    );
    expect(fake.state.paint.get(MONITOR_LAYER_ID)?.["circle-radius"]).toEqual([
      "interpolate",
      ["linear"],
      ["min", ["get", "value"], 100],
      0,
      5,
      100,
      14,
    ]);
    expect(JSON.stringify(fake.state.paint.get(MONITOR_LAYER_ID)?.["circle-opacity"])).toContain(
      "freshness",
    );
    expect(
      JSON.stringify(fake.state.paint.get(MONITOR_LAYER_ID)?.["circle-stroke-width"]),
    ).toContain("stationClass");
  });

  it("renders an unclamped, escaped popup with source and evidence status text", () => {
    const html = buildMonitorPopupHtml(FEATURE.properties, POPUP_LABELS, "en-GB");

    expect(html).toContain("137.3 µg/m³");
    expect(html).not.toContain("100.0 µg/m³");
    for (const text of [
      "Raw concentration",
      "PM₂.₅",
      "Stale",
      "Preliminary",
      "Reference",
      "75%",
      "Estimated",
      "Gap-filled",
      "fixture-provider",
      "fixture-source, other-source",
      "Fixture &lt;owner&gt;",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("AQI");
    expect(html).not.toContain("Good");
  });

  it("supports pointer and keyboard popup activation and owns only one popup", () => {
    render(<AirQualityLayer />);
    fake.setRenderedFeatures(MONITOR_LAYER_ID, [FEATURE]);

    act(() => fake.emit("click", { features: [FEATURE] }));
    expect(popupState.instances).toHaveLength(1);
    expect(popupState.instances[0]?.lngLat).toEqual([13.4, 52.5]);

    act(() => {
      fake.state.canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(popupState.instances).toHaveLength(2);
    expect(popupState.instances[0]?.removeCalls).toBe(1);
    expect(INTERACTIVE_LAYER_IDS.has(MONITOR_LAYER_ID)).toBe(true);
  });

  it("removes sources, layers, popup, pointer state, listeners, and attribution when hidden", () => {
    render(<AirQualityLayer />);
    act(() => fake.emit("click", { features: [FEATURE] }));

    act(() => useAirQualityStore.getState().setLayerVisible(false));

    expect(fake.state.sources.size).toBe(0);
    expect(fake.state.layers.size).toBe(0);
    expect(fake.state.handlers.get("click")?.size ?? 0).toBe(0);
    expect(fake.state.handlers.get("mousemove")?.size ?? 0).toBe(0);
    expect(fake.state.canvas.style.cursor).toBe("");
    expect(popupState.instances[0]?.removeCalls).toBe(1);
    expect(INTERACTIVE_LAYER_IDS.has(MONITOR_LAYER_ID)).toBe(false);
    expect(attributionState.sources).toHaveBeenLastCalledWith("air-quality", []);
  });

  it("survives repeated and full style replacement without losing source data or stacking handlers", () => {
    render(<AirQualityLayer />);
    expectStyleSwapIsLossless(fake);
    act(() => fake.emit("style.load"));
    act(() => fake.emit("style.load"));

    expect(fake.state.sources.size).toBe(1);
    expect(fake.state.layers.size).toBe(1);
    expect(fake.state.handlers.get("click")?.size).toBe(1);
    expect(fake.state.handlers.get("mousemove")?.size).toBe(1);
  });

  it("replays a fetched station snapshot through a full style replacement", async () => {
    monitorHook.use.mockImplementation(() => monitorHook.actual?.());
    vi.spyOn(apiClient, "get").mockResolvedValue({
      type: "FeatureCollection",
      features: [FEATURE as unknown as AirQualityStationFeature],
      nextCursor: null,
      meta: {
        generatedAt: "2026-08-30T12:00:00.000Z",
        cache: "miss",
        providersCandidate: ["fixture-provider"],
        providersServed: ["fixture-provider"],
        providersFailed: [],
        providersPolicyExcluded: [],
        truncated: false,
        warnings: ["stale_evidence"],
        candidateCount: 1,
        servedCount: 1,
        skippedCount: 0,
      },
    } satisfies AirQualityStationsResponse);

    render(<AirQualityLayer />);
    await waitFor(() => {
      const data = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as
        | { features?: unknown[] }
        | undefined;
      expect(data?.features).toHaveLength(1);
    });

    expectStyleSwapIsLossless(fake);
    const replayed = fake.state.sources.get(MONITOR_SOURCE_ID)?.data as {
      features: AirQualityStationFeature[];
    };
    expect(replayed.features[0]?.properties.value).toBe(137.25);
  });

  it("is Strict Mode safe and reaches zero owned resources on detach", () => {
    const view = render(
      <StrictMode>
        <AirQualityLayer />
      </StrictMode>,
    );
    expect(fake.state.sources.size).toBe(1);
    expect(fake.state.layers.size).toBe(1);
    expect(fake.state.handlers.get("style.load")?.size).toBe(1);
    expect(fake.state.handlers.get("click")?.size).toBe(1);

    view.unmount();
    expect(fake.state.sources.size).toBe(0);
    expect(fake.state.layers.size).toBe(0);
    for (const handlers of fake.state.handlers.values()) expect(handlers.size).toBe(0);
    expect(INTERACTIVE_LAYER_IDS.has(MONITOR_LAYER_ID)).toBe(false);
  });

  it("waits for map readiness and removes monitor resources during a rapid mode switch", () => {
    mapContext.mapReady = false;
    const view = render(<AirQualityLayer />);
    expect(fake.state.sources.size).toBe(0);

    mapContext.mapReady = true;
    mapContext.styleVersion += 1;
    view.rerender(<AirQualityLayer />);
    expect(fake.state.sources.size).toBe(1);

    act(() => useAirQualityStore.getState().setRasterFrame(null));
    expect(fake.state.sources.size).toBe(0);
    expect(fake.state.layers.size).toBe(0);
    expect(attributionState.sources).toHaveBeenLastCalledWith("air-quality", []);

    act(() => useAirQualityStore.getState().setMonitorPollutant("o3"));
    expect(fake.state.sources.size).toBe(1);
    expect(fake.state.layers.size).toBe(1);
  });
});
