import { describe, expect, it } from "vitest";
import {
  currentUserFixture,
  settingsFixture,
  timelineResponseFixture,
} from "../__fixtures__/timeline-day";
import { tracksPageFixture } from "../__fixtures__/tracks-page";
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
    const journey = timelineResponseFixture.days[0].entries.find(
      (entry) => entry.type === "journey",
    );
    if (!journey) throw new Error("fixture needs a journey");
    expect(
      timelineResponseSchema.parse({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineResponseFixture.days[0],
            entries: [
              timelineResponseFixture.days[0].entries[0],
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
      }).days[0].entries,
    ).toHaveLength(2);
  });

  it("accepts a null optional visit point count", () => {
    expect(
      timelineResponseSchema.parse({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineResponseFixture.days[0],
            entries: [{ ...timelineResponseFixture.days[0].entries[0], point_count: null }],
          },
        ],
      }).days[0].entries,
    ).toHaveLength(1);
  });

  it.each([
    [
      "a missing entry discriminant",
      () => ({
        ...timelineResponseFixture,
        days: [{ ...timelineResponseFixture.days[0], entries: [{ duration: 4 }] }],
      }),
    ],
    [
      "an invalid timestamp",
      () => ({
        ...timelineResponseFixture,
        days: [
          {
            ...timelineResponseFixture.days[0],
            entries: [
              { ...timelineResponseFixture.days[0].entries[0], started_at: "not-a-timestamp" },
            ],
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
            ...tracksPageFixture.features[0],
            geometry: {
              ...tracksPageFixture.features[0].geometry,
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
        features: [{ ...tracksPageFixture.features[0], properties: { device_id: "private" } }],
      }),
    ],
    [
      "malformed bounds",
      () => ({
        ...timelineResponseFixture,
        days: [{ ...timelineResponseFixture.days[0], bounds: { sw_lng: 12.3 } }],
      }),
    ],
    [
      "a Polygon track",
      () => ({
        ...tracksPageFixture,
        features: [
          {
            ...tracksPageFixture.features[0],
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
            ...timelineResponseFixture.days[0],
            entries: [{ ...timelineResponseFixture.days[0].entries[0], duration: -1 }],
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
            ...timelineResponseFixture.days[0],
            entries: [{ ...timelineResponseFixture.days[0].entries[1], duration: -1 }],
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
