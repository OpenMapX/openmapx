import { describe, expect, it } from "vitest";
import {
  resolvePrimaryTransitStopId,
  resolvePrimaryTransitStopIdFromLinkedStops,
} from "../hooks/transit/resolvePrimaryTransitStopId";
import { createPlace } from "../types/placeIds";

describe("resolvePrimaryTransitStopId", () => {
  it("prefers a direct entur stop id on the place", () => {
    const place = createPlace({
      primaryScheme: "entur",
      ids: { entur: "NSR:StopPlace:337" },
      name: "Oslo S",
      address: "Oslo S",
      coordinates: [10.753276, 59.910925],
    });

    expect(resolvePrimaryTransitStopId(place)).toBe("entur:NSR:StopPlace:337");
  });

  it("normalizes nsr ids to entur-prefixed stop ids", () => {
    const place = createPlace({
      primaryScheme: "nsr",
      ids: { nsr: "Quay:2276" },
      name: "Nygårdshaugen",
      address: "Nygårdshaugen",
      coordinates: [11.173759, 59.270847],
    });

    expect(resolvePrimaryTransitStopId(place)).toBe("entur:NSR:Quay:2276");
  });

  it("falls back to stored entur and nsr ids when the primary id is unrelated", () => {
    const place = createPlace({
      primaryScheme: "osm",
      ids: {
        osm: "node/1",
        entur: "NSR:StopPlace:59872",
        nsr: "StopPlace:59872",
      },
      name: "Oslo S",
      address: "Oslo S",
      coordinates: [10.753, 59.91],
    });

    expect(resolvePrimaryTransitStopId(place)).toBe("entur:NSR:StopPlace:59872");
  });
});

describe("resolvePrimaryTransitStopIdFromLinkedStops", () => {
  it("prefers entur stop places over quays and non-entur stops", () => {
    expect(
      resolvePrimaryTransitStopIdFromLinkedStops([
        {
          id: "db:123",
          name: "Other provider",
          lat: 0,
          lng: 0,
          modes: ["rail"],
          provider: "db",
        },
        {
          id: "entur:NSR:Quay:2276",
          name: "Platform",
          lat: 59.27,
          lng: 11.17,
          modes: ["bus"],
          provider: "entur",
        },
        {
          id: "entur:NSR:StopPlace:1367",
          name: "Nygårdshaugen",
          lat: 59.27,
          lng: 11.17,
          modes: ["bus"],
          provider: "entur",
        },
      ]),
    ).toBe("entur:NSR:StopPlace:1367");
  });
});
