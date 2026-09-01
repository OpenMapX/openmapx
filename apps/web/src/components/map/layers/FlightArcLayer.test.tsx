import { useDirectionsStore, useFlightStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, expectStyleSwapIsLossless, type FakeMap, render } from "@/test";

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
  it("registers the geojson source plus line/point/label layers on the map", () => {
    render(<FlightArcLayer />);

    expect(fake.state.sources.has("flight-arc-source")).toBe(true);
    expect(fake.state.sources.get("flight-arc-source")?.type).toBe("geojson");
    expect(fake.state.layers.has("flight-arc-line")).toBe(true);
    expect(fake.state.layers.has("flight-arc-points")).toBe(true);
    expect(fake.state.layers.has("flight-arc-labels")).toBe(true);
  });

  it("does not register layers twice when the source already exists", () => {
    render(<FlightArcLayer />);
    const firstLine = fake.state.layers.get("flight-arc-line");
    fake.emit("styledata");
    // setup() bails early when the source is present, so the layer object is the
    // same reference (it was never re-added).
    expect(fake.state.layers.get("flight-arc-line")).toBe(firstLine);
  });

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
    expect(fitBounds).toHaveBeenCalled();
  });

  it("clears the arc geometry when not in flying mode", () => {
    render(<FlightArcLayer />);

    act(() => {
      useDirectionsStore.setState({ mode: "walking" });
    });

    const data = fake.state.sources.get("flight-arc-source")?.data as { features: unknown[] };
    expect(data.features).toEqual([]);
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it("keeps the arc across a style change", () => {
    act(() => {
      useFlightStore.setState({
        from: { iata: "BER", name: "Berlin", coordinates: [13.5, 52.36] },
        to: { iata: "JFK", name: "New York", coordinates: [-73.78, 40.64] },
      });
      useDirectionsStore.setState({ mode: "flying" });
    });
    render(<FlightArcLayer />);
    const before = fake.state.sources.get("flight-arc-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});
