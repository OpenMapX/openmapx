import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap, render, waitFor } from "@/test";
import { useRoadConditionsStore } from "../store";

let fake: FakeMap;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("maplibre-gl", () => ({
  default: {
    Popup: class FakePopup {
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
        return this;
      }
    },
  },
}));

import { RoadConditionsLayer } from "../map-layer";

const MARKER_SOURCE = "omx-road-conditions-markers";
const LINE_SOURCE = "omx-road-conditions-lines";
const MARKER_LAYER = "omx-road-conditions-markers";
const LINE_LAYER = "omx-road-conditions-line";

const fetchMock = vi.fn();

function inDays(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString();
}

function respondWith(features: unknown[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features }),
  });
}

/** The URL of the most recent /events fetch. */
function lastUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  fake = createFakeMap();
  fetchMock.mockReset();
  respondWith([]);
  vi.stubGlobal("fetch", fetchMock);
  useRoadConditionsStore.setState({ panelOpen: true, layerVisible: true });
  useRoadConditionsStore.getState().resetFilters();
});

describe("RoadConditionsLayer horizon query", () => {
  it("requests horizonDays=0 under the default Active horizon", async () => {
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).toContain("horizonDays=0");
  });

  it("requests horizonDays=7 for the week step and omits the param for all", async () => {
    useRoadConditionsStore.setState({ horizon: "week" });
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(lastUrl()).toContain("horizonDays=7"));

    fetchMock.mockClear();
    useRoadConditionsStore.setState({ horizon: "all" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).not.toContain("horizonDays");
  });
});

describe("RoadConditionsLayer future styling", () => {
  it("stamps a `future` flag from either isForecast or a future validFrom", async () => {
    respondWith([
      {
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        properties: { id: "flagged", type: "roadworks", severity: "low", isForecast: true },
      },
      {
        geometry: { type: "Point", coordinates: [13.41, 52.51] },
        properties: {
          id: "dated",
          type: "roadworks",
          severity: "low",
          validFrom: inDays(3),
        },
      },
      {
        geometry: { type: "Point", coordinates: [13.42, 52.52] },
        properties: {
          id: "current",
          type: "roadworks",
          severity: "low",
          validFrom: inDays(-3),
        },
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.sources.get(MARKER_SOURCE)?.data).toBeDefined());

    const data = fake.state.sources.get(MARKER_SOURCE)?.data as {
      features: { properties: Record<string, unknown> }[];
    };
    const byId = new Map(data.features.map((f) => [f.properties._id, f.properties.future]));
    expect(byId.get("flagged")).toBe(true);
    expect(byId.get("dated")).toBe(true);
    expect(byId.get("current")).toBe(false);
  });

  it("carries the future flag onto line features too", async () => {
    respondWith([
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [13.4, 52.5],
            [13.41, 52.51],
          ],
        },
        properties: { id: "line", type: "roadworks", severity: "low", validFrom: inDays(3) },
      },
    ]);

    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.sources.get(LINE_SOURCE)?.data).toBeDefined());

    const data = fake.state.sources.get(LINE_SOURCE)?.data as {
      features: { properties: Record<string, unknown> }[];
    };
    expect(data.features[0]?.properties.future).toBe(true);
  });

  it("de-emphasises future features in the layer paint expressions", async () => {
    render(<RoadConditionsLayer />);
    await waitFor(() => expect(fake.state.layers.has(MARKER_LAYER)).toBe(true));

    const markerPaint = fake.state.layers.get(MARKER_LAYER)?.paint as Record<string, unknown>;
    expect(markerPaint["icon-opacity"]).toEqual(["case", ["get", "future"], 0.55, 1]);

    const linePaint = fake.state.layers.get(LINE_LAYER)?.paint as Record<string, unknown>;
    expect(linePaint["line-opacity"]).toEqual(["case", ["get", "future"], 0.45, 0.7]);
    expect(linePaint["line-dasharray"]).toEqual([
      "case",
      ["get", "future"],
      ["literal", [2, 1.5]],
      ["literal", [1]],
    ]);
  });
});
