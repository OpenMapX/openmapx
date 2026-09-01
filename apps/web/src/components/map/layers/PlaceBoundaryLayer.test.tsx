import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeMap, expectStyleSwapIsLossless } from "@/test";

const fake = createFakeMap({
  styleLoaded: true,
  baseLayers: [{ id: "place-labels", type: "symbol" }],
});

const selectedPlace = {
  id: "area:1",
  name: "Neuss",
  category: "region",
  coordinates: [6.6879, 51.198] as [number, number],
  primaryScheme: "osm",
  address: "Neuss",
};

const boundary = {
  type: "Polygon" as const,
  coordinates: [
    [
      [6.6, 51.1],
      [6.8, 51.1],
      [6.8, 51.3],
      [6.6, 51.3],
      [6.6, 51.1],
    ],
  ],
};

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
  }),
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlaceStore: (selector: (s: { selectedPlace: typeof selectedPlace }) => unknown) =>
    selector({ selectedPlace }),
  usePlaceDetails: () => ({ data: { boundary, boundingBox: [6.6, 51.1, 6.8, 51.3] } }),
}));

import { PlaceBoundaryLayer } from "./PlaceBoundaryLayer";

describe("PlaceBoundaryLayer across a style change", () => {
  it("keeps the boundary outline", () => {
    render(<PlaceBoundaryLayer />);
    const before = fake.state.sources.get("place-boundary-source")?.data as { features: unknown[] };
    expect(before.features.length).toBeGreaterThan(0);
    expectStyleSwapIsLossless(fake);
  });
});
