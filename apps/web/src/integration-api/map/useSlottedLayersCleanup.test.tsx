import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeMap } from "@/test";
import { addLayerInSlot, layerRegistrations } from "./layerStack";
import { useSlottedLayersCleanup } from "./useSlottedLayersCleanup";

function Overlay({
  mapRef,
}: {
  mapRef: { current: ReturnType<typeof createFakeMap>["map"] | null };
}) {
  useSlottedLayersCleanup(mapRef as never, () => ({
    layerIds: ["owned-layer"],
    sourceIds: ["owned-source"],
  }));
  return null;
}

function install(fake: ReturnType<typeof createFakeMap>) {
  fake.map.addSource("owned-source", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  addLayerInSlot(
    fake.map,
    { id: "owned-layer", type: "circle", source: "owned-source" },
    "overlay-points",
    0,
  );
}

describe("useSlottedLayersCleanup", () => {
  it("removes the overlay's layers, sources and slots on unmount only", () => {
    const fake = createFakeMap();
    install(fake);
    const view = render(<Overlay mapRef={{ current: fake.map }} />);
    // A re-render with a new ref object is not an unmount.
    view.rerender(<Overlay mapRef={{ current: fake.map }} />);
    expect(fake.state.layers.has("owned-layer")).toBe(true);

    view.unmount();
    expect(fake.state.layers.has("owned-layer")).toBe(false);
    expect(fake.state.sources.has("owned-source")).toBe(false);
    expect(layerRegistrations().some(({ id }) => id === "owned-layer")).toBe(false);
  });

  it("releases the slots when the map is already gone", () => {
    const fake = createFakeMap();
    install(fake);
    const mapRef = { current: fake.map as typeof fake.map | null };
    const view = render(<Overlay mapRef={mapRef} />);
    mapRef.current = null;
    view.unmount();
    expect(layerRegistrations().some(({ id }) => id === "owned-layer")).toBe(false);
  });

  it("keeps a source another layer still reads from", () => {
    const fake = createFakeMap();
    install(fake);
    addLayerInSlot(
      fake.map,
      { id: "sibling-layer", type: "line", source: "owned-source" },
      "overlay-lines",
      0,
    );
    render(<Overlay mapRef={{ current: fake.map }} />).unmount();
    expect(fake.state.layers.has("owned-layer")).toBe(false);
    expect(fake.state.sources.has("owned-source")).toBe(true);
  });
});
