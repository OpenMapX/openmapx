import { beforeEach, describe, expect, it } from "vitest";
import { useStreetLevelStore } from "./streetLevelStore";

const PANORAMAX = { providerId: "panoramax", imageId: "abc" };

describe("streetLevelStore", () => {
  beforeEach(() => {
    useStreetLevelStore.setState({
      activeImage: null,
      pendingImage: null,
      acceptedProviders: [],
    });
  });

  it("holds a request pending until the provider is accepted", () => {
    useStreetLevelStore.getState().requestImageLoad(PANORAMAX);
    expect(useStreetLevelStore.getState().pendingImage).toEqual(PANORAMAX);
    expect(useStreetLevelStore.getState().activeImage).toBeNull();
  });

  it("activates immediately once the provider is accepted", () => {
    useStreetLevelStore.setState({ acceptedProviders: ["panoramax"] });
    useStreetLevelStore.getState().requestImageLoad(PANORAMAX);
    expect(useStreetLevelStore.getState().activeImage).toEqual(PANORAMAX);
    expect(useStreetLevelStore.getState().pendingImage).toBeNull();
  });

  it("remembers acceptance per provider", () => {
    useStreetLevelStore.getState().requestImageLoad(PANORAMAX);
    useStreetLevelStore.getState().confirmPendingImageLoad();
    expect(useStreetLevelStore.getState().acceptedProviders).toEqual(["panoramax"]);
    expect(useStreetLevelStore.getState().activeImage).toEqual(PANORAMAX);
  });

  it("still gates a different provider after one is accepted", () => {
    useStreetLevelStore.setState({ acceptedProviders: ["panoramax"] });
    const mapillary = { providerId: "mapillary", imageId: "999" };
    useStreetLevelStore.getState().requestImageLoad(mapillary);
    expect(useStreetLevelStore.getState().pendingImage).toEqual(mapillary);
    expect(useStreetLevelStore.getState().activeImage).toBeNull();
  });

  it("clears both refs on close", () => {
    useStreetLevelStore.setState({ activeImage: PANORAMAX, pendingImage: PANORAMAX });
    useStreetLevelStore.getState().closeViewer();
    expect(useStreetLevelStore.getState().activeImage).toBeNull();
    expect(useStreetLevelStore.getState().pendingImage).toBeNull();
  });

  it("cancels a pending request without accepting", () => {
    useStreetLevelStore.getState().requestImageLoad(PANORAMAX);
    useStreetLevelStore.getState().cancelPendingImageLoad();
    expect(useStreetLevelStore.getState().pendingImage).toBeNull();
    expect(useStreetLevelStore.getState().acceptedProviders).toEqual([]);
  });
});
