import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
