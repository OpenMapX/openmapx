import type { MapLayerMouseEvent } from "maplibre-gl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMapOverlayInteraction } from "@/components/map/overlay/mapInteractionArbiter";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { createFakeMap, type FakeMap, render } from "@/test";
import { useTrafficFlowStore } from "../store";

let fake: FakeMap;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ martinBaseUrl: "https://api.test/martin" }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// `t(key)` under the mock above returns "trafficFlow.<key>" — assertions below
// check for those stable keys rather than the real translated copy.
const popupState = vi.hoisted(() => ({ html: "" }));
vi.mock("maplibre-gl", () => ({
  Popup: class FakePopup {
    setLngLat() {
      return this;
    }
    setHTML(html: string) {
      popupState.html = html;
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

import { TrafficFlowLayer } from "../map-layer";

const SRC = "omx-traffic-flow-src";
const CASING = "omx-traffic-flow-casing";
const COLOR = "omx-traffic-flow-color";
const INCIDENT = "test-incident-layer";

const COLOR_EXPR = [
  "case",
  ["==", ["get", "speed_ratio"], null],
  [
    "match",
    ["get", "los"],
    "queuing",
    "#e8112d",
    "stationary",
    "#7e0023",
    "blocked",
    "#7e0023",
    "heavy",
    "#ff8c00",
    "#2ecc40",
  ],
  [
    "interpolate",
    ["linear"],
    ["get", "speed_ratio"],
    0.0,
    "#7e0023",
    0.25,
    "#e8112d",
    0.5,
    "#ff8c00",
    0.75,
    "#ffd500",
    1.0,
    "#2ecc40",
  ],
];

beforeEach(() => {
  fake = createFakeMap();
  useTrafficFlowStore.setState({ panelOpen: false, layerVisible: false });
  popupState.html = "";
  INTERACTIVE_LAYER_IDS.delete(COLOR);
  INTERACTIVE_LAYER_IDS.delete(INCIDENT);
});

describe("TrafficFlowLayer", () => {
  it("does not register the source/layers while hidden", () => {
    render(<TrafficFlowLayer />);

    expect(fake.state.sources.has(SRC)).toBe(false);
    expect(fake.state.layers.has(COLOR)).toBe(false);
    expect(fake.state.layers.has(CASING)).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has(COLOR)).toBe(false);
  });

  it("registers a vector source plus casing + color line layers when visible", () => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
    render(<TrafficFlowLayer />);

    const source = fake.state.sources.get(SRC);
    expect(source?.type).toBe("vector");
    expect(source?.tiles).toEqual(["https://api.test/martin/segment_flow/{z}/{x}/{y}"]);

    const casing = fake.state.layers.get(CASING);
    expect(casing?.type).toBe("line");
    expect(casing?.source).toBe(SRC);
    expect(casing?.["source-layer"]).toBe("segment_flow");

    const color = fake.state.layers.get(COLOR);
    expect(color?.type).toBe("line");
    expect(color?.source).toBe(SRC);
    expect(color?.["source-layer"]).toBe("segment_flow");

    const paint = color?.paint as Record<string, unknown>;
    expect(paint["line-color"]).toEqual(COLOR_EXPR);
  });

  it("registers COLOR as an interactive layer and opens a popup with speed/LOS/confidence on click", () => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
    const { unmount } = render(<TrafficFlowLayer />);

    expect(INTERACTIVE_LAYER_IDS.has(COLOR)).toBe(true);

    const clickEvent = {
      lngLat: { lng: 5, lat: 52 },
      point: { x: 10, y: 10 },
      features: [
        {
          properties: {
            highway: "motorway",
            speed_ratio: 0.42,
            los: "heavy",
            confidence: "measured",
            current_kph: 42,
            free_flow_kph: 100,
          },
        },
      ],
    } as unknown as MapLayerMouseEvent;
    (
      fake.map as unknown as {
        queryRenderedFeatures: (point: unknown, options?: { layers?: string[] }) => unknown[];
      }
    ).queryRenderedFeatures = () => clickEvent.features ?? [];
    fake.emit("click", clickEvent);

    expect(popupState.html).toContain("42 km/h");
    expect(popupState.html).toContain("100 km/h");
    expect(popupState.html).toContain("42%");
    expect(popupState.html).toContain("trafficFlow.los.heavy");
    expect(popupState.html).toContain("trafficFlow.confidence.measured");

    unmount();
    expect(INTERACTIVE_LAYER_IDS.has(COLOR)).toBe(false);
  });

  it("does not open a popup when the click carries no feature", () => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
    render(<TrafficFlowLayer />);

    fake.emit("click", {
      lngLat: { lng: 5, lat: 52 },
      features: [],
    } as unknown as MapLayerMouseEvent);

    expect(popupState.html).toBe("");
  });

  it("lets incident interaction win over flow and still opens flow by itself", () => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
    const { unmount } = render(<TrafficFlowLayer />);
    fake.state.layers.set(INCIDENT, { id: INCIDENT, type: "line" });

    const flowFeature = {
      type: "Feature",
      properties: { highway: "primary", speed_ratio: 0.5, los: "heavy" },
      geometry: {
        type: "LineString",
        coordinates: [
          [5, 52],
          [5.01, 52],
        ],
      },
      layer: { id: COLOR, type: "line" },
    };
    const incidentFeature = {
      ...flowFeature,
      properties: { headline: "Roadworks" },
      layer: { id: INCIDENT, type: "line" },
    };
    (
      fake.map as unknown as {
        queryRenderedFeatures: (point: unknown, options?: { layers?: string[] }) => unknown[];
      }
    ).queryRenderedFeatures = (_point, options) =>
      options?.layers?.includes(INCIDENT) ? [incidentFeature] : [flowFeature];

    const incidentClick = vi.fn();
    const unregisterIncident = registerMapOverlayInteraction(fake.map, {
      id: "test-incident",
      layerIds: [INCIDENT],
      priority: 100,
      onClick: incidentClick,
    });

    fake.emit("click", { point: { x: 10, y: 10 }, lngLat: { lng: 5, lat: 52 } });
    expect(incidentClick).toHaveBeenCalledOnce();
    expect(popupState.html).toBe("");

    unregisterIncident();
    fake.emit("click", { point: { x: 10, y: 10 }, lngLat: { lng: 5, lat: 52 } });
    expect(popupState.html).toContain("50%");

    fake.emit("mousemove", { point: { x: 10, y: 10 } });
    expect(fake.map.getCanvasContainer().style.cursor).toBe("pointer");

    unmount();
  });
});
