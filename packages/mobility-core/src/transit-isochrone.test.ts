import { describe, expect, it } from "vitest";
import { parseTransitIsochroneRequest } from "./types/transit-isochrone.js";
import { TRANSIT_WALK_PROFILE } from "./types/transit-reachability.js";

const VALID = {
  origin: { lng: 13.4, lat: 52.5 },
  queryTime: "2026-09-01T08:00:00.000Z",
  direction: "depart-at",
  thresholdsMinutes: [15, 30, 45],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
  bbox: [13.2, 52.4, 13.6, 52.6],
};

describe("parseTransitIsochroneRequest", () => {
  it("accepts a valid request", () => {
    expect(parseTransitIsochroneRequest(VALID)).toMatchObject({
      direction: "depart-at",
      thresholdsMinutes: [15, 30, 45],
      bbox: [13.2, 52.4, 13.6, 52.6],
    });
  });

  it("normalizes the query time to an ISO instant", () => {
    const parsed = parseTransitIsochroneRequest({ ...VALID, queryTime: "2026-09-01T08:00:30Z" });
    expect(parsed.queryTime).toBe("2026-09-01T08:00:30.000Z");
  });

  it("rejects an unsupported walk profile", () => {
    expect(() => parseTransitIsochroneRequest({ ...VALID, walkProfileId: "foot-2.0" })).toThrow(
      /walkProfileId/,
    );
  });

  it("rejects arrive-by", () => {
    expect(() => parseTransitIsochroneRequest({ ...VALID, direction: "arrive-by" })).toThrow(
      /depart-at/,
    );
  });

  it("rejects a missing bbox", () => {
    const { bbox: _bbox, ...withoutBbox } = VALID;
    expect(() => parseTransitIsochroneRequest(withoutBbox)).toThrow(/bbox/);
  });

  it("rejects a bbox with inverted bounds", () => {
    expect(() =>
      parseTransitIsochroneRequest({ ...VALID, bbox: [13.6, 52.4, 13.2, 52.6] }),
    ).toThrow(/bbox/);
  });

  it("rejects a bbox spanning the antimeridian rather than drawing across the map", () => {
    expect(() => parseTransitIsochroneRequest({ ...VALID, bbox: [179, 52.4, -179, 52.6] })).toThrow(
      /bbox/,
    );
  });

  it("rejects a bbox outside WGS84", () => {
    expect(() => parseTransitIsochroneRequest({ ...VALID, bbox: [13.2, 52.4, 13.6, 95] })).toThrow(
      /bbox/,
    );
  });

  it("rejects unsorted thresholds", () => {
    expect(() => parseTransitIsochroneRequest({ ...VALID, thresholdsMinutes: [30, 15] })).toThrow(
      /sorted/,
    );
  });
});
