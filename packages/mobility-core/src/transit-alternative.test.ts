import { describe, expect, it } from "vitest";
import { composeTransitAlternative } from "./transit-alternative.js";
import type { TripItinerary, TripLeg } from "./types/transit.js";

const place = { name: "station", lat: 50, lng: 6, stopId: "mo:a" };
const leg = (mode: TripLeg["mode"], start: string, end: string, distanceMeters = 0): TripLeg => ({
  mode,
  from: place,
  to: place,
  startTime: `2026-11-06T${start}:00Z`,
  endTime: `2026-11-06T${end}:00Z`,
  distanceMeters,
  geometry: { type: "LineString", coordinates: [[6, 50]] },
  ...(mode === "rail" ? { route: { shortName: "RE1", longName: "" }, tripId: "mo:re1" } : {}),
});
export const replacement = [
  leg("walking", "20:50", "20:51", 10),
  leg("rail", "20:51", "21:44", 70000),
  leg("walking", "21:44", "21:45", 15),
];
const parent = (): TripItinerary => ({
  id: "parent",
  source: "mo",
  instance: "mo",
  datasetEpoch: "epoch",
  refreshToken: "parent-token",
  co2Grams: 42,
  refreshedAt: "stale",
  invalidRequirements: ["old"],
  startTime: "2026-11-06T20:42:00Z",
  endTime: "2026-11-06T21:23:00Z",
  duration: 2460,
  walkDistance: 5,
  transfers: 0,
  fare: { totalAmount: 20 } as never,
  legs: [
    leg("walking", "20:42", "20:44"),
    {
      ...leg("rail", "20:44", "21:22"),
      alternatives: [
        {
          startTime: replacement[1].startTime,
          endTime: replacement[1].endTime,
          routeShortName: "RE1",
          regionalOnly: true,
          replaces: { fromLegIndex: 0, toLegIndex: 2 },
          legs: replacement,
        },
      ],
    },
    leg("walking", "21:22", "21:23"),
  ],
});
describe("composeTransitAlternative", () => {
  it("selects the complete overtaken RE1, recomputes totals, and drops parent identity/fare/token", () => {
    const result = composeTransitAlternative(parent(), 1, 0)!;
    expect(result).toMatchObject({
      startTime: "2026-11-06T20:50:00Z",
      endTime: "2026-11-06T21:45:00Z",
      duration: 3300,
      transfers: 0,
      walkDistance: 25,
      distanceMeters: 70025,
      regionalOnly: true,
      source: "mo",
      datasetEpoch: "epoch",
    });
    for (const k of [
      "id",
      "refreshToken",
      "fare",
      "co2Grams",
      "invalidRequirements",
      "refreshedAt",
    ])
      expect(result).not.toHaveProperty(k);
    expect(result.legs[1].tripId).toBe("mo:re1");
  });
  it("does not compose legacy compact alternatives or out-of-bounds spans", () => {
    const p = parent();
    delete p.legs[1].alternatives![0].legs;
    expect(composeTransitAlternative(p, 1, 0)).toBeNull();
    p.legs[1].alternatives![0].legs = replacement;
    p.legs[1].alternatives![0].replaces!.toLegIndex = 99;
    expect(composeTransitAlternative(p, 1, 0)).toBeNull();
  });
  it("rejects overlapping timing and mismatched connection places", () => {
    const p = parent();
    p.legs[1].alternatives![0].legs = [
      ...replacement,
      { ...replacement[2], startTime: "2026-11-06T21:43:00Z" },
    ];
    expect(composeTransitAlternative(p, 1, 0)).toBeNull();
  });
  it("strips fare indices and alternative trees from retained legs and credits only chosen legs", () => {
    const p = parent();
    replacement[1].contributors = [
      { sourceId: "regional", name: "Regional", url: "https://example.com" },
    ];
    p.contributors = [{ sourceId: "eurostar", name: "Eurostar", url: "https://example.com" }];
    const result = composeTransitAlternative(p, 1, 0)!;
    expect(result.contributors?.map((a) => a.sourceId)).toEqual(["regional"]);
    expect(result.legs.every((l) => !l.alternatives && l.fareTransferIndex === undefined)).toBe(
      true,
    );
  });
});
