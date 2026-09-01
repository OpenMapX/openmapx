import { afterEach, describe, expect, it } from "vitest";
import {
  addLayerInSlot,
  anchorMapLayers,
  unregisterLayerSlot,
} from "@/integration-api/map/layerStack";
import { createFakeMap } from "@/test";

const IDS = ["under-line", "over-line", "top-marker"];

afterEach(() => {
  for (const id of IDS) unregisterLayerSlot(id);
});

function buildMap(order: "ascending" | "descending") {
  const { map, state } = createFakeMap({ styleLoaded: true });
  map.addLayer({ id: "place-labels", type: "symbol" } as never);

  const adds = [
    () => addLayerInSlot(map, { id: "under-line", type: "line" } as never, "overlay-lines", 0),
    () => addLayerInSlot(map, { id: "over-line", type: "line" } as never, "route-active", 0),
    () => addLayerInSlot(map, { id: "top-marker", type: "symbol" } as never, "route-markers", 0),
  ];
  for (const add of order === "ascending" ? adds : [...adds].reverse()) add();

  return { map, state };
}

function build(order: "ascending" | "descending"): string[] {
  return [...buildMap(order).state.layers.keys()];
}

describe("addLayerInSlot", () => {
  it("lands every layer in declared order whichever order the layers are added in", () => {
    // Layers rebuild from independent hooks after a style change, so the order
    // they are added in is React effect order, not slot order. Both must converge.
    const ascending = build("ascending");
    for (const id of IDS) unregisterLayerSlot(id);
    const descending = build("descending");

    expect(ascending).toEqual(["under-line", "over-line", "place-labels", "top-marker"]);
    expect(descending).toEqual(ascending);
  });

  it("repairs a stack whose below-label layers ended up above the labels", () => {
    // The repair pass has to converge, not just move things: while it keeps
    // returning a non-empty plan, MapLayerStack's idle handler re-runs it on
    // every idle frame for the rest of the session.
    const { map, state } = buildMap("descending");
    anchorMapLayers(map);
    expect([...state.layers.keys()]).toEqual([
      "under-line",
      "over-line",
      "place-labels",
      "top-marker",
    ]);
    const before = [...state.movedLayers].length;
    anchorMapLayers(map);
    expect(state.movedLayers.length).toBe(before);
  });
});
