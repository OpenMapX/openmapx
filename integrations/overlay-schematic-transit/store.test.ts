import { describe, expect, it } from "vitest";
import { SCHEMATIC_LAYOUTS, SCHEMATIC_NETWORKS, useSchematicTransitStore } from "./store.js";

describe("schematic transit store", () => {
  it("defaults to the octilinear metro map", () => {
    const state = useSchematicTransitStore.getState();
    expect(state.network).toBe("subway-lightrail");
    expect(state.layout).toBe("octi");
  });

  it("switches network and layout", () => {
    useSchematicTransitStore.getState().setNetwork("tram");
    useSchematicTransitStore.getState().setLayout("orthorad");
    expect(useSchematicTransitStore.getState().network).toBe("tram");
    expect(useSchematicTransitStore.getState().layout).toBe("orthorad");
  });

  it("offers every supported variant exactly once, geo-octi excluded", () => {
    expect(SCHEMATIC_NETWORKS.map((n) => n.id)).toEqual([
      "tram",
      "subway-lightrail",
      "rail-commuter",
      "rail",
    ]);
    expect(SCHEMATIC_LAYOUTS.map((l) => l.id)).toEqual(["geo", "octi", "orthorad"]);
  });
});
