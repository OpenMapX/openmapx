import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLayerSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { createFakeMap } from "@/test";
import { MapLayerStack } from "./MapLayerStack";

const fake = createFakeMap({ styleLoaded: true });

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));

describe("MapLayerStack", () => {
  afterEach(() => {
    unregisterLayerSlot("omx-road-conditions-line");
    unregisterLayerSlot("route-active-line");
  });

  it("re-asserts the canonical order when the style settles", () => {
    fake.map.addLayer({ id: "omx-road-conditions-line", type: "line" } as never);
    fake.map.addLayer({ id: "place-labels", type: "symbol" } as never);
    fake.map.addLayer({ id: "route-active-line", type: "line" } as never);
    registerLayerSlot("omx-road-conditions-line", "conditions-lines", 0);
    registerLayerSlot("route-active-line", "route-active", 1);

    render(<MapLayerStack />);
    fake.emit("idle");

    expect([...fake.state.layers.keys()]).toEqual([
      "route-active-line",
      "omx-road-conditions-line",
      "place-labels",
    ]);
  });
});
