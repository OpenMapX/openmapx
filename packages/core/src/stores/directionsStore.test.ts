import { beforeEach, describe, expect, it } from "vitest";
import { useDirectionsStore } from "./directionsStore";

function reset() {
  // close() restores the initial transit-options state.
  useDirectionsStore.getState().close();
}

describe("directionsStore transit options", () => {
  beforeEach(reset);

  it("defaults to no preferred modes and 'best' route preference", () => {
    const s = useDirectionsStore.getState();
    expect(s.transitPreferredModes).toEqual([]);
    expect(s.transitRoutePreference).toBe("best");
  });

  it("toggleTransitPreferredMode adds then removes a mode", () => {
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus"]);
    useDirectionsStore.getState().toggleTransitPreferredMode("subway");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["bus", "subway"]);
    useDirectionsStore.getState().toggleTransitPreferredMode("bus");
    expect(useDirectionsStore.getState().transitPreferredModes).toEqual(["subway"]);
  });

  it("toggling a preference resets the active itinerary index", () => {
    useDirectionsStore.setState({ activeItineraryIndex: 2 });
    useDirectionsStore.getState().toggleTransitPreferredMode("tram");
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  });

  it("setTransitRoutePreference updates and resets the active itinerary index", () => {
    useDirectionsStore.setState({ activeItineraryIndex: 3 });
    useDirectionsStore.getState().setTransitRoutePreference("fewerTransfers");
    expect(useDirectionsStore.getState().transitRoutePreference).toBe("fewerTransfers");
    expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  });

  it("keeps wheelchair and hard planner controls independent from ranking", () => {
    useDirectionsStore.getState().setWheelchairRequired(true);
    useDirectionsStore.getState().setMaxTransfers(2);
    useDirectionsStore.getState().setTransferBuffer("relaxed");
    expect(useDirectionsStore.getState()).toMatchObject({
      transitRoutePreference: "best",
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
    });
  });

  it("defaults deutschlandticketOnly to false and toggles it", () => {
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(false);
    useDirectionsStore.getState().setDeutschlandticketOnly(true);
    expect(useDirectionsStore.getState().deutschlandticketOnly).toBe(true);
  });

  it("close() resets transit options back to defaults", () => {
    useDirectionsStore.getState().toggleTransitPreferredMode("train");
    useDirectionsStore.getState().setTransitRoutePreference("lessWalking");
    useDirectionsStore.getState().setDeutschlandticketOnly(true);
    useDirectionsStore.getState().close();
    const s = useDirectionsStore.getState();
    expect(s.transitPreferredModes).toEqual([]);
    expect(s.transitRoutePreference).toBe("best");
    expect(s.deutschlandticketOnly).toBe(false);
  });
});
