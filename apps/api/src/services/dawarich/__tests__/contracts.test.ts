import { describe, expect, it } from "vitest";
import {
  currentUserFixture,
  journeyEntryFixture,
  settingsFixture,
  timelineDayFixture,
  timelineResponseFixture,
  visitEntryFixture,
} from "../__fixtures__/timeline-day";
import { trackFeatureFixture, tracksPageFixture } from "../__fixtures__/tracks-page";
import {
  currentUserSchema,
  settingsSchema,
  timelineResponseSchema,
  tracksFeatureCollectionSchema,
} from "../contracts";

describe("Dawarich runtime contracts", () => {
  it("accepts additive fields in valid upstream timeline and GeoJSON payloads", () => {
    expect(
      timelineResponseSchema.parse({ ...timelineResponseFixture, future_field: true }).days,
    ).toHaveLength(1);
    expect(
      tracksFeatureCollectionSchema.parse({ ...tracksPageFixture, new_field: "safe" }).features,
    ).toHaveLength(1);
    expect(settingsSchema.parse(settingsFixture).settings.timezone).toBe("Etc/UTC");
    expect(currentUserSchema.parse(currentUserFixture).user.email).toBe("fixture@example.invalid");
  });

  it("accepts absent upstream numeric measurements without coercing them", () => {
    const journey = journeyEntryFixture;
    const parsed = timelineResponseSchema.parse({
      ...timelineResponseFixture,
      days: [
        {
          ...timelineDayFixture,
          entries: [
            visitEntryFixture,
            {
              ...journey,
              distance: null,
              avg_speed: null,
              elevation_gain: null,
              elevation_loss: null,
              speed_unit: null,
              day_distance: null,
              day_duration: null,
            },
          ],
        },
      ],
    });
    expect(parsed.days[0]?.entries).toHaveLength(2);
    expect(parsed.days[0]?.entries[1]).toMatchObject({
      distance: null,
      avg_speed: null,
      elevation_gain: null,
      elevation_loss: null,
      speed_unit: null,
      day_distance: null,
      day_duration: null,
    });
  });

  it("accepts a null optional visit point count", () => {
    const parsed = timelineResponseSchema.parse({
      ...timelineResponseFixture,
      days: [
        {
          ...timelineDayFixture,
          entries: [{ ...visitEntryFixture, point_count: null }],
        },
      ],
    });
    expect(parsed.days[0]?.entries).toHaveLength(1);
    expect(parsed.days[0]?.entries[0]).toMatchObject({ point_count: null });
  });

  it.each([
    [
      "a missing entry discriminant",
      () => ({
        ...timelineResponseFixture,
        days: [{ ...timelineDayFixture, entries: [{ duration: 4 }] }],
      }),
    ],
    [
      "an invalid timestamp",
      () => ({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineDayFixture,
            entries: [{ ...visitEntryFixture, started_at: "not-a-timestamp" }],
          },
        ],
      }),
    ],
    [
      "a non-finite coordinate",
      () => ({
        ...tracksPageFixture,
        features: [
          {
            ...trackFeatureFixture,
            geometry: {
              ...trackFeatureFixture.geometry,
              coordinates: [
                [Number.NaN, 45.7],
                [12.5, 45.8],
              ],
            },
          },
        ],
      }),
    ],
    [
      "a track without a usable identifier",
      () => ({
        ...tracksPageFixture,
        features: [{ ...trackFeatureFixture, properties: { device_id: "private" } }],
      }),
    ],
    [
      "malformed bounds",
      () => ({
        ...timelineResponseFixture,
        days: [{ ...timelineDayFixture, bounds: { sw_lng: 12.3 } }],
      }),
    ],
    [
      "a Polygon track",
      () => ({
        ...tracksPageFixture,
        features: [
          {
            ...trackFeatureFixture,
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [12.4, 45.7],
                  [12.5, 45.8],
                  [12.4, 45.7],
                ],
              ],
            },
          },
        ],
      }),
    ],
    [
      "a negative visit duration",
      () => ({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineDayFixture,
            entries: [{ ...visitEntryFixture, duration: -1 }],
          },
        ],
      }),
    ],
    [
      "a negative journey duration",
      () => ({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineDayFixture,
            entries: [{ ...journeyEntryFixture, duration: -1 }],
          },
        ],
      }),
    ],
  ])("rejects %s", (_name, malformed) => {
    const value = malformed();
    const schema = "features" in value ? tracksFeatureCollectionSchema : timelineResponseSchema;
    expect(() => schema.parse(value)).toThrow();
  });
});
