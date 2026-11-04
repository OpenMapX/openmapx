import { describe, expect, it } from "vitest";
import { createPlace } from "../../types/placeIds";
import {
  hasTransitOsmTags,
  isTransitEligiblePlace,
  isTransitName,
  isTransitRawCategory,
} from "./transitEligibility";

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

describe("transit OSM tags", () => {
  it("accepts a station whose OSM object is its listed building", () => {
    const place = createPlace({
      ...basePlace,
      name: "Hamburg Hauptbahnhof",
      address: "Hamburg Hauptbahnhof",
      category: "Heritage",
      osmTags: { historic: "heritage", heritage: "4", building: "train_station" },
    });
    expect(isTransitEligiblePlace(place)).toBe(true);
  });

  it("recognises stations and stops by their tags, not former or unrelated ones", () => {
    expect(hasTransitOsmTags({ public_transport: "station" })).toBe(true);
    expect(hasTransitOsmTags({ railway: "tram_stop" })).toBe(true);
    expect(hasTransitOsmTags({ amenity: "bus_station" })).toBe(true);
    expect(hasTransitOsmTags({ railway: "disused_station" })).toBe(false);
    expect(hasTransitOsmTags({ historic: "railway_station" })).toBe(false);
    expect(hasTransitOsmTags({ building: "yes", shop: "stationery" })).toBe(false);
    expect(hasTransitOsmTags(undefined)).toBe(false);
  });

  it("keeps rejecting a heritage place without transit tags", () => {
    const place = createPlace({
      ...basePlace,
      category: "Heritage",
      osmTags: { historic: "heritage", building: "yes" },
    });
    expect(isTransitEligiblePlace(place)).toBe(false);
  });
});
