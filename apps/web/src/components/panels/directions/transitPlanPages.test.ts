import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { mergeTransitItineraryPage } from "./transitPlanPages";

function itinerary(id: string, overrides: Partial<TripItinerary> = {}): TripItinerary {
  return {
    id,
    source: "synthetic",
    startTime: "2026-10-22T12:00:00Z",
    endTime: "2026-10-22T13:00:00Z",
    duration: 3600,
    transfers: 1,
    walkDistance: 100,
    legs: [],
    ...overrides,
  };
}
const a = itinerary("a");
const b = itinerary("b");
const c = itinerary("c");

describe("transit itinerary page merge", () => {
  it("replaces initial results without retaining the old plan", () => {
    expect(
      mergeTransitItineraryPage({
        existing: [a],
        incoming: [b, c],
        page: "initial",
        preference: "best",
      }),
    ).toEqual([b, c]);
  });
  it("appends next pages, keeping the existing overlapping record", () => {
    const changed = { ...b, duration: 3700 };
    const merged = mergeTransitItineraryPage({
      existing: [a, b],
      incoming: [changed, c],
      page: "next",
      preference: "best",
    });
    expect(merged).toEqual([a, b, c]);
    expect(merged[1]).toBe(b);
  });
  it("prepends previous pages, preferring their overlapping record", () => {
    const changed = { ...b, duration: 3700 };
    const merged = mergeTransitItineraryPage({
      existing: [b, c],
      incoming: [a, changed],
      page: "previous",
      preference: "best",
    });
    expect(merged).toEqual([a, changed, c]);
    expect(merged[1]).toBe(changed);
  });
  it("qualifies provider IDs by source and falls back to the response provider", () => {
    const other = { ...a, source: "other" };
    const implicit = { ...a, source: undefined };
    expect(
      mergeTransitItineraryPage({
        existing: [a, other],
        incoming: [implicit],
        provider: "synthetic",
        page: "next",
        preference: "best",
      }),
    ).toEqual([a, other]);
  });
  it("deduplicates absent IDs using times and trip/stop leg identity", () => {
    const first = itinerary("unused", {
      id: undefined,
      legs: [
        {
          mode: "rail",
          tripId: "trip-a",
          from: { stopId: "stop-a", name: "Origin", lat: 52, lng: 13 },
          to: { name: "Destination", lat: 53, lng: 14 },
          startTime: a.startTime,
          endTime: a.endTime,
          geometry: {
            type: "LineString",
            coordinates: [
              [13, 52],
              [14, 53],
            ],
          },
        },
      ],
    });
    const duplicate = { ...first, duration: 3700 };
    const different = { ...first, endTime: "2026-10-22T14:00:00Z" };
    expect(
      mergeTransitItineraryPage({
        existing: [first],
        incoming: [duplicate, different],
        page: "next",
        preference: "best",
      }),
    ).toEqual([first, different]);
  });
  it("uses leg mode and origin name when trip/stop IDs are absent", () => {
    const first = itinerary("unused", {
      id: undefined,
      legs: [
        {
          mode: "walking",
          from: { name: "Origin", lat: 52, lng: 13 },
          to: { name: "Destination", lat: 53, lng: 14 },
          startTime: a.startTime,
          endTime: a.endTime,
          geometry: {
            type: "LineString",
            coordinates: [
              [13, 52],
              [14, 53],
            ],
          },
        },
      ],
    });
    expect(
      mergeTransitItineraryPage({
        existing: [first],
        incoming: [{ ...first }],
        page: "next",
        preference: "best",
      }),
    ).toEqual([first]);
  });
  it.each(["previous", "next"] as const)("keeps existing records on empty %s pages", (page) => {
    expect(
      mergeTransitItineraryPage({ existing: [a], incoming: [], page, preference: "best" }),
    ).toEqual([a]);
  });
  it("clears an empty initial page", () => {
    expect(
      mergeTransitItineraryPage({
        existing: [a],
        incoming: [],
        page: "initial",
        preference: "best",
      }),
    ).toEqual([]);
  });
  it.each(["fewerTransfers", "lessWalking"] as const)(
    "uses existing %s ranking without mutation or provenance recapture",
    (preference) => {
      const preferred = itinerary("preferred", {
        transfers: 0,
        walkDistance: 50,
        contributors: [{ sourceId: "supplier", name: "Synthetic supplier" }],
        instance: "instance",
        datasetEpoch: "epoch",
      });
      const incoming = Object.freeze([a, preferred]);
      const merged = mergeTransitItineraryPage({
        existing: [],
        incoming,
        page: "initial",
        preference,
      });
      expect(merged).toEqual([preferred, a]);
      expect(merged[0]).toBe(preferred);
      expect(merged[0].contributors).toBe(preferred.contributors);
      expect(incoming).toEqual([a, preferred]);
    },
  );
});
