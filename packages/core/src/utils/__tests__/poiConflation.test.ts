import type { PoiSearchResult } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  type ConflationPoint,
  type ConflationThresholds,
  conflate,
  DEFAULT_CONFLATION_THRESHOLDS,
  fusePoiResults,
} from "../poiConflation";

const T: ConflationThresholds = {
  alwaysMergeM: 25,
  softWindowM: 120,
  nameDiceFloor: 0.8,
};

function pt(
  id: string,
  name: string,
  lat: number,
  lng: number,
  category?: string,
): ConflationPoint {
  return { id, name, lat, lng, category };
}

describe("conflate — exact-coincident pair", () => {
  it("matches two points at the same coordinates", () => {
    const a = [pt("osm:1", "McDonald's", 52.52, 13.4, "restaurants")];
    const b = [pt("ov:1", "McDonald's", 52.52, 13.4, "restaurants")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].a.id).toBe("osm:1");
    expect(result.matched[0].b.id).toBe("ov:1");
    expect(result.unmatchedA).toHaveLength(0);
    expect(result.unmatchedB).toHaveLength(0);
  });
});

describe("conflate — far-apart no-match", () => {
  it("does not match points more than softWindowM apart", () => {
    const a = [pt("osm:1", "Cafe Mitte", 52.52, 13.4)];
    const b = [pt("ov:1", "Cafe Mitte", 52.525, 13.4)]; // ~556 m apart
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(1);
  });
});

describe("conflate — soft window: same distance, different name → no match", () => {
  it("does not match when names are too different within soft window", () => {
    // ~50 m apart (within softWindowM=120), but very different names
    const a = [pt("osm:1", "Starbucks", 52.52, 13.4)];
    const b = [pt("ov:1", "XYZ Pharmacy", 52.5204, 13.4, "pharmacies")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(1);
  });
});

describe("conflate — soft window: name variant → match", () => {
  it("matches when dice similarity is above floor within soft window", () => {
    // Points ~50 m apart, similar names (dice ≥ 0.8)
    const a = [pt("osm:1", "Starbucks Coffee", 52.52, 13.4, "cafes")];
    const b = [pt("ov:1", "Starbucks Coffee", 52.5204, 13.4, "cafes")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedA).toHaveLength(0);
    expect(result.unmatchedB).toHaveLength(0);
  });
});

describe("conflate — category mismatch within soft window → no match", () => {
  it("does not match category-incompatible points even if name matches and distance is small", () => {
    // ~20 m apart (within alwaysMergeM=25), BUT names are very similar
    // but categories are different → must still not match due to category gate
    // Actually: within alwaysMergeM it always merges (no category check at ≤25m).
    // Use the soft window (>25m, ≤120m) where category matters.
    const a = [pt("osm:1", "Berliner Apotheke", 52.52, 13.4, "pharmacies")];
    const b = [pt("ov:1", "Berliner Apotheke", 52.5204, 13.4, "restaurants")]; // ~50 m, cat mismatch
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(1);
  });
});

describe("conflate — always-merge zone (≤ alwaysMergeM)", () => {
  it("matches regardless of name difference when within alwaysMergeM", () => {
    // ~15 m apart — well within 25 m always-merge zone
    const a = [pt("osm:1", "Old Name", 52.52, 13.4)];
    const b = [pt("ov:1", "Completely Different", 52.52013, 13.4)];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
  });
});

describe("conflate — empty inputs", () => {
  it("handles empty a", () => {
    const b = [pt("ov:1", "Some Place", 52.52, 13.4)];
    const result = conflate([], b, T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(0);
    expect(result.unmatchedB).toHaveLength(1);
  });

  it("handles empty b", () => {
    const a = [pt("osm:1", "Some Place", 52.52, 13.4)];
    const result = conflate(a, [], T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(0);
  });

  it("handles both empty", () => {
    const result = conflate([], [], T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(0);
    expect(result.unmatchedB).toHaveLength(0);
  });
});

describe("conflate — bipartite matching (each point matches at most once)", () => {
  it("does not double-match a single b point to multiple a points", () => {
    // Two OSM points very close to one Overture point
    const a = [
      pt("osm:1", "Pizza Roma", 52.52, 13.4, "restaurants"),
      pt("osm:2", "Pizza Roma", 52.52001, 13.4, "restaurants"),
    ];
    const b = [pt("ov:1", "Pizza Roma", 52.52, 13.4, "restaurants")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
    // The unmatched a count plus matched a count should equal total a length
    expect(result.matched.length + result.unmatchedA.length).toBe(2);
    expect(result.unmatchedB).toHaveLength(0);
  });
});

describe("DEFAULT_CONFLATION_THRESHOLDS", () => {
  it("exports the provisional default thresholds", () => {
    expect(DEFAULT_CONFLATION_THRESHOLDS.alwaysMergeM).toBe(25);
    expect(DEFAULT_CONFLATION_THRESHOLDS.softWindowM).toBe(120);
    expect(DEFAULT_CONFLATION_THRESHOLDS.nameDiceFloor).toBe(0.8);
  });
});

function makePoi(
  id: string,
  name: string,
  lat: number,
  lng: number,
  overrides: Partial<PoiSearchResult> = {},
): PoiSearchResult {
  return { id, name, coordinates: [lng, lat], ...overrides };
}

describe("fusePoiResults", () => {
  it("returns OSM array deep-equal unchanged when overture is empty (optionality invariant)", () => {
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/1", "Starbucks", 52.52, 13.4, { category: "cafes" }),
      makePoi("osm:node/2", "McDonald's", 52.521, 13.401, { category: "restaurants" }),
    ];
    const result = fusePoiResults(osm, [], DEFAULT_CONFLATION_THRESHOLDS);
    expect(result).toStrictEqual(osm);
  });

  it("fuses matched pair: OSM id kept, gersId from Overture, brand tags merged", () => {
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/1", "Starbucks Coffee", 52.52, 13.4, {
        category: "cafes",
        openingHours: "Mo-Su 07:00-22:00",
        osmTags: { wheelchair: "yes" },
      }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-abc-123", "Starbucks Coffee", 52.52, 13.4, {
        gersId: "gers-abc-123",
        category: "cafes",
        osmTags: { brand: "Starbucks", "brand:wikidata": "Q37158" },
      }),
    ];
    const result = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS);
    expect(result).toHaveLength(1);
    const fused = result[0];
    expect(fused.id).toBe("osm:node/1");
    expect(fused.gersId).toBe("gers-abc-123");
    expect(fused.osmTags?.wheelchair).toBe("yes");
    expect(fused.osmTags?.brand).toBe("Starbucks");
    expect(fused.osmTags?.["brand:wikidata"]).toBe("Q37158");
    expect(fused.openingHours).toBe("Mo-Su 07:00-22:00");
    expect(fused.coordinates).toEqual([13.4, 52.52]);
  });

  it("appends Overture-only result as gap-fill", () => {
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/1", "Café Central", 52.52, 13.4, { category: "cafes" }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-cafe-999", "Café Central", 52.52, 13.4, {
        gersId: "gers-cafe-999",
        category: "cafes",
      }),
      makePoi("overture:gers-new-555", "Brand New Place", 52.6, 13.5, {
        gersId: "gers-new-555",
        category: "cafes",
      }),
    ];
    const result = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("osm:node/1");
    expect(ids).toContain("overture:gers-new-555");
  });

  it("emits OSM-only result unchanged when it has no Overture counterpart", () => {
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/42", "Drinking Water Fountain", 52.52, 13.4, {
        category: "drinking_water",
      }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-unrelated", "Pizza Roma", 52.6, 13.5, {
        gersId: "gers-unrelated",
        category: "restaurants",
      }),
    ];
    const result = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS);
    const osmResult = result.find((r) => r.id === "osm:node/42");
    expect(osmResult).toBeDefined();
    expect(osmResult?.name).toBe("Drinking Water Fountain");
  });
});
