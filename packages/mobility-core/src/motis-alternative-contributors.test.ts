import { describe, expect, it } from "vitest";
import { annotateLegsWithAttribution, wrapMotisWithFeedAttribution } from "./motis-contributors.js";
import { composeTransitAlternative } from "./transit-alternative.js";
import { captureTransitContributors } from "./transit-contributors.js";
import type { TripItinerary } from "./types/transit.js";

const a = { sourceId: "feed_a", name: "A" },
  b = { sourceId: "feed_b", name: "B" };
const index = {
  listMotisFeedTags: () => ["feed_a", "feed_b"],
  getById: (id: string) => (id === "feed_a" ? a : id === "feed_b" ? b : undefined),
};
function journey(): TripItinerary {
  const place = { name: "Stop", lat: 50, lng: 6, stopId: "ms:feed_a_stop" };
  const leg = {
    mode: "rail" as const,
    startTime: "2026-11-06T20:00:00Z",
    endTime: "2026-11-06T21:00:00Z",
    tripId: "ms:feed_a_trip",
    route: { shortName: "EST", longName: "" },
    from: place,
    to: place,
    geometry: { type: "LineString" as const, coordinates: [] },
  };
  const regional = {
    ...leg,
    tripId: "ms:feed_b_trip",
    from: { ...place, stopId: undefined },
    to: { ...place, stopId: undefined },
    route: { shortName: "RE1", longName: "" },
  };
  return {
    startTime: leg.startTime,
    endTime: leg.endTime,
    duration: 3600,
    walkDistance: 0,
    transfers: 0,
    legs: [
      {
        ...leg,
        alternatives: [
          {
            startTime: leg.startTime,
            endTime: leg.endTime,
            replaces: { fromLegIndex: 0, toLegIndex: 0 },
            legs: [regional],
          },
        ],
      },
    ],
  };
}
describe("alternative contributor boundaries", () => {
  it("captures the selected local feed without charging its credits to the unused parent", () => {
    const mapped = annotateLegsWithAttribution([journey()], index);
    const parent = wrapMotisWithFeedAttribution(mapped, index).data[0];
    expect(parent.legs[0].contributors?.map((c) => c.sourceId)).toEqual(["feed_a"]);
    expect(parent.legs[0].alternatives?.[0].legs?.[0].contributors?.map((c) => c.sourceId)).toEqual(
      ["feed_b"],
    );
    expect(composeTransitAlternative(parent, 0, 0)?.contributors?.map((c) => c.sourceId)).toEqual([
      "feed_b",
    ]);
  });
  it("captures hosted alternatives through the existing traversal", () => {
    const parent = captureTransitContributors(journey(), [a]);
    expect(composeTransitAlternative(parent, 0, 0)?.contributors?.map((c) => c.sourceId)).toEqual([
      "feed_a",
    ]);
  });
});
