import { describe, expect, it } from "vitest";
import { createPlace } from "../../types/placeIds";
import { isTransitEligiblePlace, isTransitName, isTransitRawCategory } from "./transitEligibility";

const basePlace = {
  primaryScheme: "stylePoi",
  ids: { stylePoi: "poi-1" },
  name: "Archimo",
  address: "Archimo",
  coordinates: [6.0839, 50.774] as [number, number],
};

describe("isTransitRawCategory", () => {
  it("matches transit category tokens and phrases across provider formats", () => {
    expect(isTransitRawCategory("railway/station")).toBe(true);
    expect(isTransitRawCategory("bus_station")).toBe(true);
    expect(isTransitRawCategory("public_transport/platform")).toBe(true);
    expect(isTransitRawCategory("railStation")).toBe(true);
    expect(isTransitRawCategory("Ferry Terminal")).toBe(true);
  });

  it("does not match transit keywords inside unrelated category words", () => {
    expect(isTransitRawCategory("stationery")).toBe(false);
    expect(isTransitRawCategory("stationary")).toBe(false);
    expect(isTransitRawCategory("shop/stationery")).toBe(false);
    expect(isTransitRawCategory("business")).toBe(false);
    expect(isTransitRawCategory("training")).toBe(false);
  });

  it("keeps known non-transit station categories blocked", () => {
    expect(isTransitRawCategory("fire_station")).toBe(false);
    expect(isTransitRawCategory("Fire Station")).toBe(false);
    expect(isTransitRawCategory("amenity/police_station")).toBe(false);
    expect(isTransitRawCategory("emergency/ambulance_station")).toBe(false);
    expect(isTransitRawCategory("power/substation")).toBe(false);
  });
});

describe("isTransitName", () => {
  it("matches transit names by token or phrase", () => {
    expect(isTransitName("Aachen train station")).toBe(true);
    expect(isTransitName("ZOB Aachen")).toBe(true);
    expect(isTransitName("U-Bahn Sendlinger Tor")).toBe(true);
  });

  it("does not match transit keywords inside unrelated name words", () => {
    expect(isTransitName("Stationery shop")).toBe(false);
    expect(isTransitName("Stationary store")).toBe(false);
    expect(isTransitName("Business Center")).toBe(false);
  });
});

describe("isTransitEligiblePlace", () => {
  it("rejects a stationery store from style POI categories", () => {
    const place = createPlace({
      ...basePlace,
      category: "stationery",
      rawCategory: "shop/stationery",
    });

    expect(isTransitEligiblePlace(place)).toBe(false);
  });

  it("accepts an actual transit stop category", () => {
    const place = createPlace({
      ...basePlace,
      name: "Aachen Hbf",
      address: "Aachen Hbf",
      category: "station",
      rawCategory: "railway/station",
    });

    expect(isTransitEligiblePlace(place)).toBe(true);
  });
});
