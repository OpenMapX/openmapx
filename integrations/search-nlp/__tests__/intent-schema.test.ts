import { describe, expect, it } from "vitest";
import { SearchIntentSchema, searchIntentJsonSchema } from "../intent-schema";

const validFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
};

const validIntent = {
  filter: validFilter,
  spatial_constraint: { type: "current_view" },
  time_constraint: { type: "open_now" },
  sort_by: "distance" as const,
  unmapped_attributes: ["cozy"],
  confidence: 0.8,
  explanation: "Search for cafes with outdoor seating",
};

describe("SearchIntentSchema", () => {
  it("parses a valid intent with filter successfully", () => {
    const result = SearchIntentSchema.safeParse(validIntent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filter.selectors).toHaveLength(1);
      expect(result.data.filter.selectors[0].tags[0].key).toBe("amenity");
      expect(result.data.confidence).toBe(0.8);
    }
  });

  it("parses filter with require and exclude predicates", () => {
    const intent = {
      ...validIntent,
      filter: {
        selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "restaurant" }] }],
        require: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
        exclude: [{ key: "cuisine", op: "=" as const, value: "fast_food" }],
      },
    };
    const result = SearchIntentSchema.safeParse(intent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filter.require).toHaveLength(1);
      expect(result.data.filter.exclude).toHaveLength(1);
    }
  });

  it("parses filter with exists predicate (no value)", () => {
    const intent = {
      ...validIntent,
      filter: {
        selectors: [{ tags: [{ key: "wheelchair", op: "exists" as const }] }],
      },
    };
    const result = SearchIntentSchema.safeParse(intent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filter.selectors[0].tags[0].op).toBe("exists");
    }
  });

  it("parses filter with regex predicate (~)", () => {
    const intent = {
      ...validIntent,
      filter: {
        selectors: [{ tags: [{ key: "cuisine", op: "~" as const, value: "italian|pizza" }] }],
      },
    };
    const result = SearchIntentSchema.safeParse(intent);
    expect(result.success).toBe(true);
  });

  it("parses filter with elementTypes", () => {
    const intent = {
      ...validIntent,
      filter: {
        selectors: [{ tags: [{ key: "shop", op: "=" as const, value: "bakery" }] }],
        elementTypes: ["node" as const, "way" as const],
      },
    };
    const result = SearchIntentSchema.safeParse(intent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filter.elementTypes).toContain("node");
    }
  });

  it("rejects the old {categories, attributes} shape (no filter)", () => {
    const oldShape = {
      categories: ["cafes", "restaurants"],
      attributes: { outdoor_seating: "yes" },
      spatial_constraint: { type: "current_view" },
      time_constraint: { type: "open_now" },
      sort_by: "distance",
      unmapped_attributes: ["cozy"],
      confidence: 0.8,
      explanation: "Search for cafes",
    };
    const result = SearchIntentSchema.safeParse(oldShape);
    expect(result.success).toBe(false);
  });

  it("rejects intent missing filter", () => {
    const { filter: _filter, ...noFilter } = validIntent;
    const result = SearchIntentSchema.safeParse(noFilter);
    expect(result.success).toBe(false);
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

  it("includes filter instead of categories/attributes in properties", () => {
    const props = Object.keys(searchIntentJsonSchema.properties);
    expect(props).toContain("filter");
    expect(props).not.toContain("categories");
    expect(props).not.toContain("attributes");
    expect(props).toContain("spatial_constraint");
    expect(props).toContain("time_constraint");
    expect(props).toContain("sort_by");
    expect(props).toContain("unmapped_attributes");
    expect(props).toContain("confidence");
    expect(props).toContain("explanation");
  });

  it("lists 7 fields in required array (filter replaces categories+attributes)", () => {
    expect(searchIntentJsonSchema.required).toHaveLength(7);
    expect(searchIntentJsonSchema.required).toContain("filter");
    expect(searchIntentJsonSchema.required).not.toContain("categories");
    expect(searchIntentJsonSchema.required).not.toContain("attributes");
  });

  it("filter property has selectors sub-schema", () => {
    const filterProp = (searchIntentJsonSchema.properties as Record<string, unknown>)
      .filter as Record<string, unknown>;
    expect(filterProp).toBeDefined();
    expect(filterProp.type).toBe("object");
    const filterProps = filterProp.properties as Record<string, unknown>;
    expect(filterProps).toBeDefined();
    expect(filterProps.selectors).toBeDefined();
  });
});
