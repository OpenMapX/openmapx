import type { AttributionIndexHandle } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { TransitStop, TripItinerary } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { attribution } from "../attributions.js";
import { __testing, annotateLegsWithAttribution, extractFeedTags } from "../local.js";
import { encodeMotisRoutePatternId } from "../route-pattern-id.js";

// Mirror the manifest dataSources the host loads at runtime so the local
// fallback attribution has data to read.
attribution.set([
  {
    sourceId: "motis",
    name: "MOTIS (self-hosted)",
    url: "https://github.com/motis-project/motis",
    license: "MIT",
    providerCountry: "DE",
    providerPrivacyUrl: "https://github.com/motis-project/motis",
  },
  {
    sourceId: "transitous",
    name: "Transitous",
    url: "https://api.transitous.org/",
    license: "AGPL-3.0-or-later",
    providerCountry: "DE",
    providerPrivacyUrl: "https://transitous.org/",
  },
]);

const FEED_TAGS = ["de_DELFI", "ch_SBB"];
const FEED_TAGS_BY_LENGTH = [...FEED_TAGS].sort((a, b) => b.length - a.length);

const ATTR_BY_ID: Record<string, Attribution> = {
  de_DELFI: {
    sourceId: "de_DELFI",
    name: "DELFI Germany",
    publisher: { name: "DELFI e.V.", url: "https://delfi.de/" },
    url: "https://delfi.de/",
    spdxLicense: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  ch_SBB: {
    sourceId: "ch_SBB",
    name: "SBB Switzerland",
    publisher: { name: "SBB", url: "https://www.sbb.ch/" },
    url: "https://www.sbb.ch/",
    spdxLicense: "OPEN-DATA-CH",
    licenseUrl: "https://opentransportdata.swiss/license",
  },
};

const fakeIndex: AttributionIndexHandle = {
  getById(sourceId) {
    return ATTR_BY_ID[sourceId];
  },
  getForMotisFile() {
    return undefined;
  },
  dedupAndOrder(attrs) {
    return attrs;
  },
  listMotisFeedTags() {
    return FEED_TAGS;
  },
};

describe("transit-motis feed attribution", () => {
  it("attaches the matching Attribution row for a single feed-tagged stop", () => {
    const stop: TransitStop = {
      id: "ms:de_DELFI_de:08111:6118:0:3",
      name: "Stuttgart Hbf",
      lat: 48.7838,
      lng: 9.1815,
      modes: ["train"],
      provider: "ms",
    };
    const wrapped = __testing.wrapLocal(stop, fakeIndex);
    expect(wrapped.attributions).toHaveLength(1);
    expect(wrapped.attributions[0].sourceId).toBe("de_DELFI");
    expect(wrapped.attributions[0].name).toBe("DELFI Germany");
    expect(wrapped.attributions[0].publisher?.name).toBe("DELFI e.V.");
    expect(wrapped.freshness.hasRealtimeData).toBe(false);
  });

  it("deduplicates and lists every feed tag spanning an array", () => {
    const arr: TransitStop[] = [
      {
        id: "ms:de_DELFI_de:08111:6118:0:3",
        name: "Stuttgart Hbf",
        lat: 48.78,
        lng: 9.18,
        modes: ["train"],
        provider: "ms",
      },
      {
        id: "ms:de_DELFI_de:08000105:0:1",
        name: "Frankfurt(Main)Hbf",
        lat: 50.107,
        lng: 8.663,
        modes: ["train"],
        provider: "ms",
      },
      {
        id: "ms:ch_SBB_8503000",
        name: "Zürich HB",
        lat: 47.378,
        lng: 8.54,
        modes: ["train"],
        provider: "ms",
      },
    ];
    const wrapped = __testing.wrapLocalRT(arr, fakeIndex);
    const sourceIds = wrapped.attributions.map((a) => a.sourceId).sort();
    expect(sourceIds).toEqual(["ch_SBB", "de_DELFI"]);
    expect(wrapped.freshness.hasRealtimeData).toBe(true);
  });

  it("falls back to ATTRIBUTION_LOCAL when the feed tag is not in the index", () => {
    const stop: TransitStop = {
      id: "ms:unknown_feed_X_some-stop",
      name: "Mystery Stop",
      lat: 0,
      lng: 0,
      modes: [],
      provider: "ms",
    };
    const wrapped = __testing.wrapLocal(stop, fakeIndex);
    expect(wrapped.attributions).toEqual(__testing.attributionLocal());
    expect(wrapped.attributions[0].sourceId).toBe("motis");
  });

  it("falls back to ATTRIBUTION_LOCAL when no index is supplied", () => {
    const stop: TransitStop = {
      id: "ms:de_DELFI_de:08111:6118:0:3",
      name: "Stuttgart Hbf",
      lat: 48.78,
      lng: 9.18,
      modes: ["train"],
      provider: "ms",
    };
    const wrapped = __testing.wrapLocal(stop, undefined);
    expect(wrapped.attributions).toEqual(__testing.attributionLocal());
  });

  it("extractFeedTags walks nested trip-plan shapes (legs with from/to stop ids)", () => {
    const tripPlan = {
      from: { name: "A", lat: 0, lng: 0 },
      to: { name: "B", lat: 0, lng: 0 },
      itineraries: [
        {
          legs: [
            {
              from: { stopId: "ms:de_DELFI_8000105" },
              to: { stopId: "ms:ch_SBB_8503000" },
            },
          ],
        },
      ],
    };
    const tags = extractFeedTags(tripPlan, FEED_TAGS_BY_LENGTH).sort();
    expect(tags).toEqual(["ch_SBB", "de_DELFI"]);
  });

  it("extractFeedTags decodes every source route from an opaque route-pattern ID", () => {
    const route = {
      id: encodeMotisRoutePatternId("epoch", 17, ["de_DELFI_route", "ch_SBB_route"]),
    };
    expect(extractFeedTags(route, FEED_TAGS_BY_LENGTH).sort()).toEqual(["ch_SBB", "de_DELFI"]);
  });

  it("returns an empty tag list for shapes without recognisable ids", () => {
    expect(extractFeedTags(null, FEED_TAGS_BY_LENGTH)).toEqual([]);
    expect(extractFeedTags({}, FEED_TAGS_BY_LENGTH)).toEqual([]);
    expect(extractFeedTags([{ foo: "bar" }], FEED_TAGS_BY_LENGTH)).toEqual([]);
  });

  it("annotateLegsWithAttribution fans out per-leg attribution across a multi-feed itinerary", () => {
    const itinerary: TripItinerary = {
      duration: 7200,
      startTime: "2026-05-21T08:00:00Z",
      endTime: "2026-05-21T10:00:00Z",
      transfers: 1,
      walkDistance: 0,
      legs: [
        {
          mode: "rail",
          startTime: "2026-05-21T08:00:00Z",
          endTime: "2026-05-21T09:00:00Z",
          from: { name: "Frankfurt", lat: 50.1, lng: 8.6, stopId: "ms:de_DELFI_8000105" },
          to: { name: "Basel", lat: 47.55, lng: 7.59, stopId: "ms:de_DELFI_8500010" },
          geometry: {
            type: "LineString",
            coordinates: [
              [8.6, 50.1],
              [7.59, 47.55],
            ],
          },
        },
        {
          mode: "rail",
          startTime: "2026-05-21T09:00:00Z",
          endTime: "2026-05-21T10:00:00Z",
          from: { name: "Basel", lat: 47.55, lng: 7.59, stopId: "ms:ch_SBB_8500010" },
          to: { name: "Zürich HB", lat: 47.378, lng: 8.54, stopId: "ms:ch_SBB_8503000" },
          geometry: {
            type: "LineString",
            coordinates: [
              [7.59, 47.55],
              [8.54, 47.378],
            ],
          },
        },
      ],
    };

    const [annotated] = annotateLegsWithAttribution([itinerary], fakeIndex);
    expect(annotated.legs[0].attributions?.map((a) => a.sourceId)).toEqual(["de_DELFI"]);
    expect(annotated.legs[1].attributions?.map((a) => a.sourceId)).toEqual(["ch_SBB"]);
  });

  it("annotateLegsWithAttribution returns input unchanged when no AttributionIndex is supplied", () => {
    const itinerary: TripItinerary = {
      duration: 60,
      startTime: "2026-05-21T08:00:00Z",
      endTime: "2026-05-21T08:01:00Z",
      transfers: 0,
      walkDistance: 0,
      legs: [
        {
          mode: "rail",
          startTime: "2026-05-21T08:00:00Z",
          endTime: "2026-05-21T08:01:00Z",
          from: { name: "A", lat: 0, lng: 0, stopId: "ms:de_DELFI_x" },
          to: { name: "B", lat: 0, lng: 0, stopId: "ms:de_DELFI_y" },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [0, 0],
            ],
          },
        },
      ],
    };
    const out = annotateLegsWithAttribution([itinerary], undefined);
    expect(out[0].legs[0].attributions).toBeUndefined();
  });

  it("annotateLegsWithAttribution leaves a leg unchanged when no feed tag matches", () => {
    const itinerary: TripItinerary = {
      duration: 60,
      startTime: "2026-05-21T08:00:00Z",
      endTime: "2026-05-21T08:01:00Z",
      transfers: 0,
      walkDistance: 250,
      legs: [
        {
          mode: "walking",
          startTime: "2026-05-21T08:00:00Z",
          endTime: "2026-05-21T08:01:00Z",
          from: { name: "A", lat: 0, lng: 0 },
          to: { name: "B", lat: 0, lng: 0 },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [0, 0],
            ],
          },
        },
      ],
    };
    const out = annotateLegsWithAttribution([itinerary], fakeIndex);
    expect(out[0].legs[0].attributions).toBeUndefined();
  });
});
