import { describe, expect, it } from "vitest";
import {
  normalizeSearchIntent,
  SearchIntentSchema,
  type SearchIntentWire,
  SearchIntentWireSchema,
} from "../intent-schema";

const validIntent = {
  filter: {
    selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
  },
  spatial_constraint: { type: "current_view" as const },
  time_constraint: { type: "open_now" as const },
  sort_by: "distance" as const,
  unmapped_attributes: ["cozy"],
  confidence: 0.8,
  explanation: "Search for cafes",
};

const validWire: SearchIntentWire = {
  filter: {
    selectors: [{ tags: [{ key: "amenity", op: null, value: "cafe" }] }],
    require: [{ key: "wheelchair", op: "~", value: "yes|limited" }],
    exclude: [{ key: "brand", op: "exists", value: null }],
    elementTypes: [],
  },
  spatial_constraint: {
    type: "near_coordinates",
    place_name: null,
    lat: 48.86,
    lng: 2.35,
    south: null,
    west: null,
    north: null,
    east: null,
  },
  time_constraint: { type: "open_at", day: "Monday", time: "09:00" },
  sort_by: "distance",
  unmapped_attributes: [],
  confidence: 0.9,
  explanation: "Accessible cafes",
};

describe("SearchIntentSchema", () => {
  it("accepts the domain shape and all discriminated variants", () => {
    expect(SearchIntentSchema.safeParse(validIntent).success).toBe(true);
    const spatial = [
      { type: "near_place", place_name: "Paris" },
      { type: "near_coordinates", lat: 48.86, lng: 2.35 },
      { type: "within_bbox", south: 1, west: 2, north: 3, east: 4 },
      { type: "current_view" },
      null,
    ];
    const time = [
      { type: "open_now" },
      { type: "open_at", day: "Monday", time: "09:00" },
      { type: "open_24h" },
      null,
    ];
    for (const spatial_constraint of spatial) {
      for (const time_constraint of time) {
        expect(
          SearchIntentSchema.safeParse({ ...validIntent, spatial_constraint, time_constraint })
            .success,
        ).toBe(true);
      }
    }
  });

  it("rejects missing filters, invalid confidence, and predicates without values", () => {
    const { filter: _filter, ...withoutFilter } = validIntent;
    expect(SearchIntentSchema.safeParse(withoutFilter).success).toBe(false);
    expect(SearchIntentSchema.safeParse({ ...validIntent, confidence: 1.5 }).success).toBe(false);
    expect(
      SearchIntentSchema.safeParse({
        ...validIntent,
        filter: { selectors: [{ tags: [{ key: "amenity" }] }] },
      }).success,
    ).toBe(false);
  });
});

describe("SearchIntentWireSchema", () => {
  it("uses required arrays and flat nullable variant fields", () => {
    expect(SearchIntentWireSchema.safeParse(validWire).success).toBe(true);
    expect(
      SearchIntentWireSchema.safeParse({
        ...validWire,
        filter: { ...validWire.filter, require: undefined },
      }).success,
    ).toBe(false);
  });

  it("normalizes null/default fields into the compact domain shape", () => {
    const intent = normalizeSearchIntent(validWire);
    expect(intent.filter.selectors[0].tags[0]).toEqual({ key: "amenity", value: "cafe" });
    expect(intent.filter.exclude).toEqual([{ key: "brand", op: "exists" }]);
    expect(intent.filter.elementTypes).toBeUndefined();
    expect(intent.spatial_constraint).toEqual({
      type: "near_coordinates",
      lat: 48.86,
      lng: 2.35,
    });
  });

  it("rejects a variant whose selected type is missing its required value", () => {
    expect(() =>
      normalizeSearchIntent({
        ...validWire,
        spatial_constraint: {
          type: "near_coordinates",
          place_name: null,
          lat: null,
          lng: 2.35,
          south: null,
          west: null,
          north: null,
          east: null,
        },
      }),
    ).toThrow("lat is required");
  });
});
