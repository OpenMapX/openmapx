import { describe, expect, it } from "vitest";
import { timelineDayFixture } from "../__fixtures__/timeline-day";
import { tracksPageFixture } from "../__fixtures__/tracks-page";
import { normalizeDawarichDay } from "../normalize";

describe("normalizeDawarichDay", () => {
  it("keeps visit minutes and journey seconds distinct while sorting chronologically", () => {
    const dayWithAdditiveField = { ...timelineDayFixture, future_entry_field: true };
    const result = normalizeDawarichDay({
      day: { ...dayWithAdditiveField, entries: [...timelineDayFixture.entries].reverse() },
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      tracks: tracksPageFixture,
    });

    expect(result.entries.map((entry) => entry.type)).toEqual(["visit", "journey"]);
    expect(result.entries[0]).toMatchObject({
      type: "visit",
      durationMinutes: 25,
      id: "visit-fixture-1",
    });
    expect(result.entries[1]).toMatchObject({
      type: "journey",
      durationSeconds: 2520,
      id: "track-fixture-1",
    });
    expect(result.entries[0].startedAt).toBe("2026-01-02T08:00:00.000Z");
  });

  it("preserves missing optional numbers and creates longitude-latitude visit points", () => {
    const journey = timelineDayFixture.entries.find(
      (entry): entry is Extract<typeof entry, { type: "journey" }> => entry.type === "journey",
    );
    if (!journey) throw new Error("fixture needs a journey");
    const {
      distance: _distance,
      avg_speed: _averageSpeed,
      elevation_gain: _gain,
      elevation_loss: _loss,
      ...journeyWithoutOptionalNumbers
    } = journey;
    const result = normalizeDawarichDay({
      day: {
        ...timelineDayFixture,
        entries: [timelineDayFixture.entries[0], journeyWithoutOptionalNumbers],
      },
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
    });

    const normalizedJourney = result.entries.find((entry) => entry.type === "journey");
    expect(normalizedJourney).not.toHaveProperty("distance");
    expect(normalizedJourney).not.toHaveProperty("averageSpeed");
    expect(normalizedJourney).not.toHaveProperty("elevationGain");
    expect(result.map.visits.features[0].geometry.coordinates).toEqual([12.4, 45.7]);
  });

  it("omits null optional visit and journey fields", () => {
    const journey = timelineDayFixture.entries.find(
      (entry): entry is Extract<typeof entry, { type: "journey" }> => entry.type === "journey",
    );
    if (!journey) throw new Error("fixture needs a journey");
    const result = normalizeDawarichDay({
      day: {
        ...timelineDayFixture,
        entries: [
          { ...timelineDayFixture.entries[0], point_count: null },
          {
            ...journey,
            speed_unit: null,
            day_distance: null,
            day_duration: null,
          },
        ],
      } as typeof timelineDayFixture,
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
    });

    expect(result.entries[0]).not.toHaveProperty("pointCount");
    const normalizedJourney = result.entries.find((entry) => entry.type === "journey");
    expect(normalizedJourney).not.toHaveProperty("speedUnit");
    expect(normalizedJourney).not.toHaveProperty("dayDistance");
    expect(normalizedJourney).not.toHaveProperty("dayDurationSeconds");
  });

  it("normalizes an empty day and upstream bounds into the public tuple", () => {
    const result = normalizeDawarichDay({
      day: { ...timelineDayFixture, entries: [], bounds: null },
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      tracks: { type: "FeatureCollection", features: [] },
    });

    expect(result.entries).toEqual([]);
    expect(result.bounds).toBeNull();
    expect(result.summary).toEqual({
      totalDistance: 12.5,
      placesVisited: 1,
      movingMinutes: 42,
      stationaryMinutes: 25,
    });
    expect(result.capabilities).toEqual({ trackGeometry: false, elevation: false });
  });

  it("returns only explicit track-fetch warnings and reports actual geometry/elevation capabilities", () => {
    const unavailable = normalizeDawarichDay({
      day: timelineDayFixture,
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      trackFetchFailed: true,
    });
    expect(unavailable.map.tracks.features).toEqual([]);
    expect(unavailable.warnings).toEqual(["TRACK_GEOMETRY_UNAVAILABLE"]);

    const partial = normalizeDawarichDay({
      day: timelineDayFixture,
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      tracks: tracksPageFixture,
      acceptedPartialTrackPageLimit: true,
    });
    expect(partial.map.tracks.features).toHaveLength(1);
    expect(partial.capabilities).toEqual({ trackGeometry: true, elevation: true });
    expect(partial.warnings).toEqual(["PARTIAL_TRACK_PAGE_LIMIT"]);
  });

  it("joins tracks to selected-day journeys and omits unrelated geometry", () => {
    const unrelated = {
      ...tracksPageFixture.features[0],
      properties: { id: "track-from-another-day" },
    };
    const result = normalizeDawarichDay({
      day: timelineDayFixture,
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      tracks: {
        type: "FeatureCollection",
        features: [unrelated, tracksPageFixture.features[0]],
      },
    });

    expect(result.map.tracks.features).toHaveLength(1);
    expect(result.map.tracks.features[0].properties).toEqual({ id: "track-fixture-1" });
  });

  it("strips additive upstream track properties from the browser contract", () => {
    const result = normalizeDawarichDay({
      day: timelineDayFixture,
      selectedDate: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      tracks: {
        type: "FeatureCollection",
        features: [
          {
            ...tracksPageFixture.features[0],
            properties: {
              id: "track-fixture-1",
              device_id: "private-device",
              raw_point_ids: ["private-point"],
            },
          },
        ],
      },
    });

    expect(result.map.tracks.features[0].properties).toEqual({ id: "track-fixture-1" });
    expect(JSON.stringify(result.map.tracks)).not.toMatch(/private-device|private-point/);
  });
});
