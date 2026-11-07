import { useDirectionsStore, useFlightStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, render } from "@/test";

let fake: FakeMap;
const fitBounds = vi.fn();

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds,
  }),
}));

import { FlightArcLayer } from "./FlightArcLayer";

beforeEach(() => {
  fake = createFakeMap({
    baseLayers: [{ id: "place-labels", type: "symbol" }],
  });
  fitBounds.mockClear();
  useFlightStore.setState({ from: null, to: null });
  useDirectionsStore.setState({ mode: "driving" });
});

describe("FlightArcLayer", () => {
  it("draws the great-circle arc and fits bounds when flying with both airports", () => {
    render(<FlightArcLayer />);

    act(() => {
      useFlightStore.setState({
        from: { iata: "BER", name: "Berlin", coordinates: [13.5, 52.36] },
        to: { iata: "JFK", name: "New York", coordinates: [-73.78, 40.64] },
      });
      useDirectionsStore.setState({ mode: "flying" });
    });

    const data = fake.state.sources.get("flight-arc-source")?.data as {
      features: Array<{ properties: { kind: string } }>;
    };
    expect(data.features.length).toBe(3);
    expect(data.features.map((f) => f.properties.kind)).toEqual(["line", "point", "point"]);
    const layers = [...fake.state.layers.values()].filter(
      (layer) => "source" in layer && layer.source === "flight-arc-source",
    );
    expect(layers.map((layer) => layer.type).sort()).toEqual(["circle", "line", "symbol"]);
    for (const layer of layers) {
      expect(layer).toMatchObject({
        filter: ["==", ["get", "kind"], layer.type === "line" ? "line" : "point"],
      });
    }
    expect(layers.find((layer) => layer.type === "symbol")).toMatchObject({
      layout: { "text-field": ["get", "label"] },
    });
    expect(fitBounds).toHaveBeenCalled();
    const fitCallCount = fitBounds.mock.calls.length;
    act(() => {
      useDirectionsStore.setState({ mode: "walking" });
    });
    const cleared = fake.state.sources.get("flight-arc-source")?.data as { features: unknown[] };
    expect(cleared.features).toEqual([]);
    expect(fitBounds).toHaveBeenCalledTimes(fitCallCount);
  });
});
