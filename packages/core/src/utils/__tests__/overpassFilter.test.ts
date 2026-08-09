import { describe, expect, it, vi } from "vitest";
import { OVERPASS_FETCH_LIMIT } from "../overpass.service";
import {
  buildFilterQuery,
  categoriesToFilter,
  FILTER_LIMITS,
  normalizeFilter,
  removeFilterPredicate,
  searchByFilter,
  validateOverpassFilter,
} from "../overpassFilter";

vi.mock("../overpass", () => ({
  overpassQuery: vi.fn().mockResolvedValue({
    elements: [
      {
        type: "node",
        id: 1,
        lat: 48.86,
        lon: 2.35,
        tags: { amenity: "cafe", name: "Test Cafe" },
      },
    ],
  }),
}));

describe("validateOverpassFilter", () => {
  it("accepts a minimal single-selector filter and applies op/element defaults", () => {
    const r = validateOverpassFilter({
      selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filter.selectors[0].tags[0]).toEqual({ key: "amenity", op: "=", value: "cafe" });
      expect(r.filter.elementTypes).toEqual(["node", "way"]);
    }
  });

  it("rejects a filter with no selectors", () => {
    expect(validateOverpassFilter({ selectors: [] }).ok).toBe(false);
  });

  it("rejects an empty selector (would match all)", () => {
    expect(validateOverpassFilter({ selectors: [{ tags: [] }] }).ok).toBe(false);
  });

  it("rejects a key with QL metacharacters", () => {
    expect(
      validateOverpassFilter({ selectors: [{ tags: [{ key: 'amenity"]node[', value: "x" }] }] }).ok,
    ).toBe(false);
  });

  it("rejects too many selectors", () => {
    const selectors = Array.from({ length: FILTER_LIMITS.MAX_SELECTORS + 1 }, () => ({
      tags: [{ key: "amenity", value: "cafe" }],
    }));
    expect(validateOverpassFilter({ selectors }).ok).toBe(false);
  });

  it("requires a value for = and ~ but not exists", () => {
    expect(
      validateOverpassFilter({ selectors: [{ tags: [{ key: "amenity", op: "=" }] }] }).ok,
    ).toBe(false);
    expect(
      validateOverpassFilter({ selectors: [{ tags: [{ key: "internet_access", op: "exists" }] }] })
        .ok,
    ).toBe(true);
  });

  it("rejects an over-long regex value", () => {
    const value = "a".repeat(FILTER_LIMITS.MAX_REGEX_LEN + 1);
    expect(
      validateOverpassFilter({ selectors: [{ tags: [{ key: "cuisine", op: "~", value }] }] }).ok,
    ).toBe(false);
  });

  it("rejects when total predicate count exceeds the cap", () => {
    const selectors = Array.from({ length: 6 }, () => ({
      tags: Array.from({ length: 8 }, () => ({ key: "amenity", value: "x" })),
    }));
    expect(validateOverpassFilter({ selectors }).ok).toBe(false);
  });
});

const BBOX = { south: 48.85, west: 2.33, north: 48.87, east: 2.37 };

describe("buildFilterQuery", () => {
  it("ORs selectors and ANDs require + exclude across each, for node and way", () => {
    const filter = validateOverpassFilter({
      selectors: [
        { tags: [{ key: "amenity", value: "cafe" }] },
        { tags: [{ key: "shop", value: "bakery" }] },
      ],
      require: [
        { key: "diet:vegan", op: "~", value: "yes|only" },
        { key: "internet_access", op: "exists" },
      ],
      exclude: [{ key: "brand", op: "exists" }],
    });
    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    const q = buildFilterQuery(filter.filter, BBOX);
    expect(q).toContain(
      'node["amenity"="cafe"]["diet:vegan"~"yes|only"]["internet_access"]["brand"!~"."](48.85,2.33,48.87,2.37);',
    );
    expect(q).toContain(
      'way["shop"="bakery"]["diet:vegan"~"yes|only"]["internet_access"]["brand"!~"."](48.85,2.33,48.87,2.37);',
    );
    expect(q.startsWith("[out:json][timeout:15];")).toBe(true);
    expect(q.trimEnd().endsWith(`out center ${OVERPASS_FETCH_LIMIT + 1};`)).toBe(true);
  });

  it("escapes literal values and regex values", () => {
    const filter = validateOverpassFilter({
      selectors: [
        {
          tags: [
            { key: "name", op: "~", value: "a.b" },
            { key: "operator", value: 'A "B"' },
          ],
        },
      ],
    });
    if (!filter.ok) throw new Error("expected ok");
    const q = buildFilterQuery(filter.filter, BBOX);
    expect(q).toContain('["name"~"a\\.b"]');
    expect(q).toContain('["operator"="A \\"B\\""]');
  });

  it("honors elementTypes override", () => {
    const filter = validateOverpassFilter({
      selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }],
      elementTypes: ["node"],
    });
    if (!filter.ok) throw new Error("expected ok");
    const q = buildFilterQuery(filter.filter, BBOX);
    expect(q).toContain('node["amenity"="cafe"]');
    expect(q).not.toContain("way[");
  });
});

describe("categoriesToFilter", () => {
  it("maps known categories to OR'd selectors and attributes to require", () => {
    const f = categoriesToFilter(["cafes", "bakeries"], { "diet:vegan": "yes" });
    expect(f).not.toBeNull();
    expect(
      f?.selectors.some((s) => s.tags[0].key === "amenity" && s.tags[0].value === "cafe"),
    ).toBe(true);
    expect(f?.selectors.some((s) => s.tags[0].key === "shop" && s.tags[0].value === "bakery")).toBe(
      true,
    );
    expect(f?.require).toEqual([{ key: "diet:vegan", op: "=", value: "yes" }]);
  });
  it("returns null when no known categories", () => {
    expect(categoriesToFilter(["definitely_not_a_category"], {})).toBeNull();
  });
});

describe("normalizeFilter", () => {
  it("orders predicates deterministically for stable hashing", () => {
    const a = normalizeFilter({
      selectors: [
        {
          tags: [
            { key: "b", op: "=", value: "2" },
            { key: "a", op: "=", value: "1" },
          ],
        },
      ],
    });
    const b = normalizeFilter({
      selectors: [
        {
          tags: [
            { key: "a", op: "=", value: "1" },
            { key: "b", op: "=", value: "2" },
          ],
        },
      ],
    });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("treats explicit empty require/exclude the same as absent for stable hashing", () => {
    const selectors = [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }];
    const withEmpty = normalizeFilter({ selectors, require: [], exclude: [] });
    const withAbsent = normalizeFilter({ selectors });
    expect(JSON.stringify(withEmpty)).toEqual(JSON.stringify(withAbsent));
  });
});

describe("searchByFilter", () => {
  it("calls overpassQuery with the compiled QL and returns mapped results", async () => {
    const filter = validateOverpassFilter({
      selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }],
    });
    if (!filter.ok) throw new Error("expected ok");
    const { results, truncated } = await searchByFilter(filter.filter, BBOX);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("Test Cafe");
    expect(truncated).toBe(false);
  });
});

describe("removeFilterPredicate", () => {
  const baseFilter = {
    selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
    require: [
      { key: "outdoor_seating", op: "=" as const, value: "yes" },
      { key: "wheelchair", op: "=" as const, value: "yes" },
    ],
    exclude: [{ key: "brand", op: "exists" as const }],
  };

  it("removes a require predicate by index and returns a new filter without it", () => {
    const result = removeFilterPredicate(baseFilter, "require", 0);
    expect(result.require).toHaveLength(1);
    expect(result.require?.[0].key).toBe("wheelchair");
    expect(result.selectors).toEqual(baseFilter.selectors);
    expect(result.exclude).toEqual(baseFilter.exclude);
  });

  it("omits the require list entirely when removing the last predicate", () => {
    const single = {
      selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
      require: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
    };
    const result = removeFilterPredicate(single, "require", 0);
    expect(result.require).toBeUndefined();
  });

  it("removes an exclude predicate and omits the list when it becomes empty", () => {
    const result = removeFilterPredicate(baseFilter, "exclude", 0);
    expect(result.exclude).toBeUndefined();
    expect(result.require).toEqual(baseFilter.require);
  });

  it("does not mutate the original filter", () => {
    const original = {
      selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
      require: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
    };
    removeFilterPredicate(original, "require", 0);
    expect(original.require).toHaveLength(1);
  });

  it("is a no-op for an out-of-range index", () => {
    const result = removeFilterPredicate(baseFilter, "require", 99);
    expect(result.require).toEqual(baseFilter.require);
    expect(result.exclude).toEqual(baseFilter.exclude);
  });
});
