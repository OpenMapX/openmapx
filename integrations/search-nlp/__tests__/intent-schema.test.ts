import { describe, expect, it } from "vitest";
import { SearchIntentSchema, searchIntentJsonSchema } from "../intent-schema";

const validIntent = {
  categories: ["cafes", "restaurants"],
  attributes: { outdoor_seating: "yes" },
  spatial_constraint: { type: "current_view" },
  time_constraint: { type: "open_now" },
  sort_by: "distance" as const,
  unmapped_attributes: ["cozy"],
  confidence: 0.8,
  explanation: "Search for cafes and restaurants with outdoor seating",
};

describe("SearchIntentSchema", () => {
  it("parses a valid intent successfully", () => {
    const result = SearchIntentSchema.safeParse(validIntent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categories).toEqual(["cafes", "restaurants"]);
      expect(result.data.attributes.outdoor_seating).toBe("yes");
      expect(result.data.confidence).toBe(0.8);
    }
  });

  it("rejects an invalid sort_by value", () => {
    const bad = { ...validIntent, sort_by: "price" };
    const result = SearchIntentSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts null spatial_constraint", () => {
    const nullSpatial = { ...validIntent, spatial_constraint: null };
    const result = SearchIntentSchema.safeParse(nullSpatial);
    expect(result.success).toBe(true);
  });

  it("accepts null time_constraint", () => {
    const nullTime = { ...validIntent, time_constraint: null };
    const result = SearchIntentSchema.safeParse(nullTime);
    expect(result.success).toBe(true);
  });

  it("rejects confidence outside 0-1", () => {
    const bad = { ...validIntent, confidence: 1.5 };
    const result = SearchIntentSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts all spatial_constraint variants", () => {
    const variants = [
      { type: "near_place" as const, place_name: "Paris" },
      { type: "near_coordinates" as const, lat: 48.86, lng: 2.35 },
      { type: "within_bbox" as const, south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
      { type: "current_view" as const },
    ];
    for (const spatial of variants) {
      const result = SearchIntentSchema.safeParse({ ...validIntent, spatial_constraint: spatial });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all time_constraint variants", () => {
    const variants = [
      { type: "open_now" as const },
      { type: "open_at" as const, day: "Monday", time: "09:00" },
      { type: "open_24h" as const },
    ];
    for (const time of variants) {
      const result = SearchIntentSchema.safeParse({ ...validIntent, time_constraint: time });
      expect(result.success).toBe(true);
    }
  });
});

describe("searchIntentJsonSchema", () => {
  it('has type "object"', () => {
    expect(searchIntentJsonSchema.type).toBe("object");
  });

  it("includes all 8 required fields in properties", () => {
    const props = Object.keys(searchIntentJsonSchema.properties);
    expect(props).toContain("categories");
    expect(props).toContain("attributes");
    expect(props).toContain("spatial_constraint");
    expect(props).toContain("time_constraint");
    expect(props).toContain("sort_by");
    expect(props).toContain("unmapped_attributes");
    expect(props).toContain("confidence");
    expect(props).toContain("explanation");
  });

  it("lists all 8 fields in required array", () => {
    expect(searchIntentJsonSchema.required).toHaveLength(8);
    expect(searchIntentJsonSchema.required).toContain("categories");
  });
});
