import { describe, expect, it } from "vitest";
import {
  MAX_TRANSIT_REACHABILITY_DESTINATIONS,
  parseTransitReachabilityCheckRequest,
  parseTransitReachabilitySurfaceRequest,
  TRANSIT_WALK_PROFILE,
} from "./types/transit-reachability.js";

const valid = {
  origin: { lng: 13.405, lat: 52.52 },
  queryTime: "2026-08-29T10:31:44+02:00",
  direction: "depart-at",
  thresholdsMinutes: [15, 30, 60],
  transitModes: ["TRAM", "BUS", "TRAM"],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
} as const;

describe("transit reachability request parsing", () => {
  it("normalizes a valid surface request", () => {
    expect(parseTransitReachabilitySurfaceRequest(valid)).toMatchObject({
      queryTime: "2026-08-29T08:31:44.000Z",
      thresholdsMinutes: [15, 30, 60],
      transitModes: ["BUS", "TRAM"],
    });
  });

  it.each([
    { ...valid, origin: { lng: 181, lat: 0 } },
    { ...valid, queryTime: "not-a-date" },
    { ...valid, thresholdsMinutes: [30, 15] },
    { ...valid, thresholdsMinutes: [15, 15] },
    { ...valid, thresholdsMinutes: [15, 30, 60, 75, 90] },
    { ...valid, walkProfileId: "different" },
  ])("rejects malformed surface input", (input) => {
    expect(() => parseTransitReachabilitySurfaceRequest(input)).toThrow();
  });

  it("accepts ordered unique exact destinations", () => {
    const request = parseTransitReachabilityCheckRequest({
      ...valid,
      destinations: [
        { id: "a", lng: 13.4, lat: 52.5 },
        { id: "b", lng: 13.41, lat: 52.51 },
      ],
    });
    expect(request.destinations.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("rejects duplicate and excessive exact destinations", () => {
    expect(() =>
      parseTransitReachabilityCheckRequest({
        ...valid,
        destinations: [
          { id: "same", lng: 13.4, lat: 52.5 },
          { id: "same", lng: 13.41, lat: 52.51 },
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      parseTransitReachabilityCheckRequest({
        ...valid,
        destinations: Array.from({ length: MAX_TRANSIT_REACHABILITY_DESTINATIONS + 1 }, (_, i) => ({
          id: String(i),
          lng: 13.4,
          lat: 52.5,
        })),
      }),
    ).toThrow(/at most/);
  });
});
