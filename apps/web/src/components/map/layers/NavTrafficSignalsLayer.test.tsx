import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/lib/navigation/useNavTrafficSignals", () => ({
  useNavTrafficSignals: () => [
    [8, 50],
    [8.01, 50.01],
  ],
}));
vi.mock("@/lib/trafficLightMarker", () => ({
  TRAFFIC_LIGHT_IMAGE_ID: "nav-traffic-light",
  loadTrafficLightImage: (map: {
    hasImage: (id: string) => boolean;
    addImage: (id: string, i: unknown) => void;
  }) => {
    if (!map.hasImage("nav-traffic-light")) map.addImage("nav-traffic-light", {});
  },
}));

import { NavTrafficSignalsLayer } from "./NavTrafficSignalsLayer";

const SOURCE = "nav-traffic-signals-source";

describe("NavTrafficSignalsLayer", () => {
  it("draws a point per signal", () => {
    render(<NavTrafficSignalsLayer />);
    const data = fake.state.sources.get(SOURCE)?.data as { features: unknown[] };
    expect(data.features).toHaveLength(2);
  });

  it("2D traffic-light icons hide while street objects draw signals", () => {
    render(<NavTrafficSignalsLayer />);
    const visibility = () => fake.map.getLayoutProperty("nav-traffic-signals", "visibility");
    expect(visibility()).not.toBe("none");
    act(() => {
      useNavigationSceneStore.getState().setActive(true);
      useNavigationSceneStore.getState().setStreetObjectsDrawn(true);
    });
    expect(visibility()).toBe("none");
    act(() => useNavigationSceneStore.getState().setActive(false));
    expect(visibility()).toBe("visible");
  });

  it("keeps the signals and re-registers the icon across a style change", () => {
    render(<NavTrafficSignalsLayer />);
    let imageWasPresentAtStyleLoad = false;
    fake.map.on("style.load", () => {
      imageWasPresentAtStyleLoad = fake.state.images.has("nav-traffic-light");
    });
    expectStyleSwapIsLossless(fake);
    expect(imageWasPresentAtStyleLoad).toBe(true);
    expect(fake.state.images.has("nav-traffic-light")).toBe(true);
  });
});
