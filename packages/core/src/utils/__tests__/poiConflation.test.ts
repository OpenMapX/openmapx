import { describe, expect, it } from "vitest";
import {
  type ConflationPoint,
  type ConflationThresholds,
  conflate,
  DEFAULT_CONFLATION_THRESHOLDS,
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
