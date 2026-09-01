import { afterEach, describe, expect, it } from "vitest";
import {
  anchorMapLayers,
  registerLayerSlot,
  unregisterLayerSlot,
} from "@/integration-api/map/layerStack";
import { createFakeMap } from "@/test";

/**
 * The reported failure: satellite imagery and wildfires both anchored below the
 * first symbol layer, so whichever re-anchored last won and the satellite raster
 * repainted over the wildfire markers with its user-set opacity.
 */
describe("raster overlays under data overlays", () => {
  it("keeps a raster overlay below a heatmap and its circles whatever order they were added in", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "omx-wildfires-heat", type: "heatmap" } as never);
    map.addLayer({ id: "omx-wildfires-circle", type: "circle" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);
    map.addLayer({ id: "omx-satellite", type: "raster" } as never);

    registerLayerSlot("omx-satellite", "raster-overlays", 0);
    registerLayerSlot("omx-wildfires-heat", "area-overlays", 4);
    registerLayerSlot("omx-wildfires-circle", "overlay-points", 4);
    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual([
      "omx-satellite",
      "omx-wildfires-heat",
      "omx-wildfires-circle",
      "place-labels",
    ]);

    for (const id of ["omx-satellite", "omx-wildfires-heat", "omx-wildfires-circle"]) {
      unregisterLayerSlot(id);
    }
  });

  it("keeps the nautical charts in their declared sequence", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "seamark", type: "raster" } as never);
    map.addLayer({ id: "depth-relief", type: "raster" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);
    registerLayerSlot("depth-relief", "raster-overlays", 10);
    registerLayerSlot("seamark", "raster-overlays", 14);
    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual(["depth-relief", "seamark", "place-labels"]);
    unregisterLayerSlot("depth-relief");
    unregisterLayerSlot("seamark");
  });
});

describe("overlay bands", () => {
  it("stacks lines under points under markers regardless of create order", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "omx-live-transit-label", type: "symbol" } as never);
    map.addLayer({ id: "omx-cycling-tracks", type: "line" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);
    map.addLayer({ id: "omx-air-quality", type: "circle" } as never);

    registerLayerSlot("omx-cycling-tracks", "overlay-lines", 0);
    registerLayerSlot("omx-air-quality", "overlay-points", 0);
    registerLayerSlot("omx-live-transit-label", "overlay-markers", 10);
    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual([
      "omx-cycling-tracks",
      "omx-air-quality",
      "omx-live-transit-label",
      "place-labels",
    ]);

    for (const id of ["omx-cycling-tracks", "omx-air-quality", "omx-live-transit-label"]) {
      unregisterLayerSlot(id);
    }
  });

  it("keeps overlay lines below the route and overlay markers above it", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "route-active-line", type: "line" } as never);
    map.addLayer({ id: "omx-transit-line", type: "line" } as never);
    map.addLayer({ id: "omx-road-conditions-markers", type: "symbol" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);

    registerLayerSlot("omx-transit-line", "overlay-lines", 4);
    registerLayerSlot("route-active-line", "route-active", 1);
    registerLayerSlot("omx-road-conditions-markers", "overlay-markers", 0);
    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual([
      "omx-transit-line",
      "route-active-line",
      "omx-road-conditions-markers",
      "place-labels",
    ]);

    for (const id of ["omx-transit-line", "route-active-line", "omx-road-conditions-markers"]) {
      unregisterLayerSlot(id);
    }
  });
});

describe("heatmaps over their own points", () => {
  afterEach(() => {
    for (const id of ["omx-wildfires-heat", "omx-wildfires-circle", "omx-live-transit-icon"]) {
      unregisterLayerSlot(id);
    }
  });

  it("keeps a heatmap above the circles drawn from the same features", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "omx-wildfires-heat", type: "heatmap" } as never);
    map.addLayer({ id: "omx-wildfires-circle", type: "circle" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);

    registerLayerSlot("omx-wildfires-heat", "overlay-heat", 0);
    registerLayerSlot("omx-wildfires-circle", "overlay-points", 4);
    anchorMapLayers(map);

    // The circles sit exactly on the heat maxima, so underneath they would hide
    // the density peak and leave only the cool halo visible.
    expect([...state.layers.keys()]).toEqual([
      "omx-wildfires-circle",
      "omx-wildfires-heat",
      "place-labels",
    ]);
  });

  it("still keeps a heatmap below overlay markers", () => {
    const { map, state } = createFakeMap({ styleLoaded: true });
    map.addLayer({ id: "omx-live-transit-icon", type: "symbol" } as never);
    map.addLayer({ id: "omx-wildfires-heat", type: "heatmap" } as never);
    map.addLayer({ id: "place-labels", type: "symbol" } as never);

    registerLayerSlot("omx-wildfires-heat", "overlay-heat", 0);
    registerLayerSlot("omx-live-transit-icon", "overlay-markers", 9);
    anchorMapLayers(map);

    expect([...state.layers.keys()]).toEqual([
      "omx-wildfires-heat",
      "omx-live-transit-icon",
      "place-labels",
    ]);
  });
});
