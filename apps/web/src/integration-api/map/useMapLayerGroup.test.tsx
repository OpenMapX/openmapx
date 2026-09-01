import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));

import { unregisterLayerSlot } from "./layerStack";
import type { MapLayerGroup } from "./mapLayerGroup";
import { useMapLayerGroup } from "./useMapLayerGroup";

function points(lng: number) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [lng, 50] },
      },
    ],
  };
}

function Probe({ lng }: { lng: number | null }) {
  const group: MapLayerGroup | null =
    lng === null
      ? null
      : {
          sources: { "probe-src": { type: "geojson", data: points(lng) } as never },
          layers: [
            {
              id: "probe-layer",
              type: "circle",
              source: "probe-src",
              slot: "overlay-points",
              order: 0,
            } as never,
          ],
        };
  useMapLayerGroup(group);
  return null;
}

afterEach(() => {
  unregisterLayerSlot("probe-layer");
});

describe("useMapLayerGroup", () => {
  it("draws the group on mount", () => {
    render(<Probe lng={8} />);
    expect(fake.state.layers.has("probe-layer")).toBe(true);
    expect(fake.state.sources.get("probe-src")?.data).toEqual(points(8));
  });

  it("rebuilds with its data after a style change", () => {
    render(<Probe lng={8} />);
    expectStyleSwapIsLossless(fake);
  });

  it("restores the group before setStyle returns", () => {
    render(<Probe lng={8} />);
    // MapLibre fires style.load synchronously inside setStyle, so a rebuild that
    // waits for a React commit shows a blank frame. This one does not.
    act(() => {
      fake.map.setStyle({} as never);
      expect(fake.state.layers.has("probe-layer")).toBe(true);
    });
  });

  it("pushes new data on re-render", () => {
    const { rerender } = render(<Probe lng={8} />);
    rerender(<Probe lng={9} />);
    expect(fake.state.sources.get("probe-src")?.data).toEqual(points(9));
  });

  it("tears the group down when it becomes null", () => {
    const { rerender } = render(<Probe lng={8} />);
    rerender(<Probe lng={null} />);
    expect(fake.state.layers.has("probe-layer")).toBe(false);
    expect(fake.state.sources.has("probe-src")).toBe(false);
  });

  it("tears the group down on unmount", () => {
    const { unmount } = render(<Probe lng={8} />);
    unmount();
    expect(fake.state.layers.has("probe-layer")).toBe(false);
    expect(fake.state.sources.has("probe-src")).toBe(false);
  });

  it("stops rebuilding after unmount", () => {
    const { unmount } = render(<Probe lng={8} />);
    unmount();
    act(() => {
      fake.map.setStyle({} as never);
    });
    expect(fake.state.layers.has("probe-layer")).toBe(false);
  });
});
