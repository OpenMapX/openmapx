import type { PoiSearchResult } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  type ConflationPoint,
  type ConflationThresholds,
  conflate,
  DEFAULT_CONFLATION_THRESHOLDS,
} from "../poiConflation";
import { fusePoiResults } from "../poiFusion";

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

describe("conflate — normalized name match (Tier 1/2)", () => {
  it("matches a case-only name variant within the soft window", () => {
    // ~55 m apart: beyond alwaysMergeM (25), so it must pass via name similarity.
    // Raw char-Dice for "PENNY" vs "Penny" is 0 — only normalization rescues it.
    const a = [pt("osm:1", "PENNY", 52.52, 13.4, "supermarkets")];
    const b = [pt("ov:1", "Penny", 52.5205, 13.4, "supermarkets")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(0);
  });

  it("matches via shared distinctive tokens despite a prefix difference", () => {
    const a = [pt("osm:1", "U Lindauer Allee", 52.52, 13.4, "transit")];
    const b = [pt("ov:1", "U-Bahnhof Lindauer Allee", 52.5205, 13.4, "transit")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
  });

  it("still rejects genuinely different names within the window", () => {
    const a = [pt("osm:1", "Aldi", 52.52, 13.4, "supermarkets")];
    const b = [pt("ov:1", "Lidl", 52.5205, 13.4, "supermarkets")];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
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
    // In the soft window (>25 m, ≤120 m) the category gate applies: same name
    // but incompatible categories must not match.
    const a = [pt("osm:1", "Berliner Apotheke", 52.52, 13.4, "pharmacies")];
    const b = [pt("ov:1", "Berliner Apotheke", 52.5204, 13.4, "restaurants")]; // ~50 m, cat mismatch
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedA).toHaveLength(1);
    expect(result.unmatchedB).toHaveLength(1);
  });
});

describe("conflate — close band (≤ alwaysMergeM) still needs a name signal", () => {
  it("does NOT merge clearly-different names even within alwaysMergeM", () => {
    // ~15 m apart — well within 25 m. Distance alone must not force a merge:
    // adjacent different businesses sit this close in dense areas.
    const a = [pt("osm:1", "Smash Your Burger", 52.52, 13.4)];
    const b = [pt("ov:1", "Tron KFZ-Technik", 52.52013, 13.4)];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(0);
  });

  it("merges close points with a relaxed name match (brand variant)", () => {
    // ~15 m apart with a shared distinctive token → relaxed close-band floor.
    const a = [pt("osm:1", "Aral", 52.52, 13.4)];
    const b = [pt("ov:1", "ARAL Station", 52.52013, 13.4)];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(1);
  });
});

describe("conflate — address corroboration", () => {
  const ap = (
    id: string,
    name: string,
    lat: number,
    lng: number,
    addressKey: string | undefined,
    category?: string,
    wikidata?: string,
  ): ConflationPoint => ({ id, name, lat, lng, addressKey, category, wikidata });

  it("matches same-address points even when names differ (same place, different label)", () => {
    const a = [ap("osm:1", "Schnell", 52.52, 13.4, "10115|hauptstr|5", "bakeries")];
    const b = [
      ap("ov:1", "Bäckerei & Café Schnell", 52.5205, 13.4, "10115|hauptstr|5", "bakeries"),
    ];
    expect(conflate(a, b, T).matched).toHaveLength(1);
  });

  it("rejects a strong name match when addresses contradict (precision)", () => {
    // Identical names, ~55 m apart, but different street addresses → not the same place.
    const a = [ap("osm:1", "Apotheke", 52.52, 13.4, "10115|hauptstr|5", "pharmacies")];
    const b = [ap("ov:1", "Apotheke", 52.5205, 13.4, "10115|nebenstr|9", "pharmacies")];
    expect(conflate(a, b, T).matched).toHaveLength(0);
  });

  it("does not merge different businesses sharing one address (incompatible category, weak name)", () => {
    const a = [ap("osm:1", "Dr. Müller Zahnarzt", 52.52, 13.4, "10115|hauptstr|5", "dentists")];
    const b = [ap("ov:1", "Tchibo", 52.5205, 13.4, "10115|hauptstr|5", "cafes")];
    expect(conflate(a, b, T).matched).toHaveLength(0);
  });

  it("matches on equal wikidata id within the window regardless of name", () => {
    const a = [ap("osm:1", "KFC", 52.52, 13.4, undefined, "restaurants", "Q524757")];
    const b = [
      ap("ov:1", "Kentucky Fried Chicken", 52.5205, 13.4, undefined, "restaurants", "Q524757"),
    ];
    expect(conflate(a, b, T).matched).toHaveLength(1);
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

  it("greedy multi-member: pairs all mutual members, no duplicate Overture pins", () => {
    // Three OSM + three Overture all within alwaysMergeM of each other — every
    // cross-side pair mutually matches, so the cluster covers all six points.
    // Greedy pairing must produce min(3,3)=3 pairs, leaving unmatchedB empty.
    const a = [
      pt("osm:1", "Food Court A", 52.52, 13.4, "restaurants"),
      pt("osm:2", "Food Court B", 52.52002, 13.4, "restaurants"),
      pt("osm:3", "Food Court C", 52.52004, 13.4, "restaurants"),
    ];
    const b = [
      pt("ov:1", "Food Court A", 52.52, 13.4, "restaurants"),
      pt("ov:2", "Food Court B", 52.52002, 13.4, "restaurants"),
      pt("ov:3", "Food Court C", 52.52004, 13.4, "restaurants"),
    ];
    const result = conflate(a, b, T);
    expect(result.matched).toHaveLength(3);
    expect(result.unmatchedA).toHaveLength(0);
    expect(result.unmatchedB).toHaveLength(0);
    const matchedAIds = result.matched.map((m) => m.a.id).sort();
    const matchedBIds = result.matched.map((m) => m.b.id).sort();
    expect(matchedAIds).toEqual(["osm:1", "osm:2", "osm:3"]);
    expect(matchedBIds).toEqual(["ov:1", "ov:2", "ov:3"]);
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

describe("fusePoiResults — link-first pass", () => {
  it("fuses via link even when names are too dissimilar for the union-find", () => {
    // OSM: "HARMANS KFC #189" — Overture: "KFC" — Dice similarity << 0.8, far enough apart
    // that union-find would NOT match, but the link table says they are the same entity.
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/999", "HARMANS KFC #189", 52.52, 13.4, { category: "restaurants" }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-kfc-001", "KFC", 52.5205, 13.4, {
        gersId: "gers-kfc-001",
        category: "restaurants",
        osmTags: { brand: "KFC", "brand:wikidata": "Q524757" },
      }),
    ];
    // Without a link the names are too dissimilar: union-find should NOT match them.
    const noLinkResult = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS);
    expect(noLinkResult.find((r) => r.gersId === "gers-kfc-001")?.id).not.toBe("osm:node/999");

    // With the link the pair must be fused: OSM id kept, gers carried, brand merged.
    const link = new Map([["node/999", "gers-kfc-001"]]);
    const linked = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS, link);
    expect(linked).toHaveLength(1);
    const fused = linked[0];
    expect(fused.id).toBe("osm:node/999");
    expect(fused.gersId).toBe("gers-kfc-001");
    expect(fused.osmTags?.brand).toBe("KFC");
    expect(fused.osmTags?.["brand:wikidata"]).toBe("Q524757");
  });

  it("absent-link fallback: 3-arg, 4-arg-undefined, and 4-arg-empty-map produce deep-equal output", () => {
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/1", "Starbucks Coffee", 52.52, 13.4, {
        category: "cafes",
        osmTags: { wheelchair: "yes" },
      }),
      makePoi("osm:node/2", "Lone Café", 52.51, 13.38, { category: "cafes" }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-sb-001", "Starbucks Coffee", 52.52, 13.4, {
        gersId: "gers-sb-001",
        category: "cafes",
        osmTags: { brand: "Starbucks", "brand:wikidata": "Q37158" },
      }),
      makePoi("overture:gers-gap-fill", "New Place", 52.53, 13.41, {
        gersId: "gers-gap-fill",
        category: "cafes",
      }),
    ];

    const threeArg = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS);
    const fourArgUndefined = fusePoiResults(
      osm,
      overture,
      DEFAULT_CONFLATION_THRESHOLDS,
      undefined,
    );
    const fourArgEmpty = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS, new Map());

    expect(fourArgUndefined).toStrictEqual(threeArg);
    expect(fourArgEmpty).toStrictEqual(threeArg);
  });

  it("link fuses one pair while union-find still fuses a name-similar pair; both carry gers", () => {
    // node/10 ↔ gers-link-only: name-dissimilar, linked via link table
    // node/20 ↔ gers-name-match: name-similar, matched by union-find
    const osm: PoiSearchResult[] = [
      makePoi("osm:node/10", "TOTALLY DIFFERENT NAME XYZABC", 52.52, 13.4, {
        category: "cafes",
      }),
      makePoi("osm:node/20", "Café Roma", 52.521, 13.401, { category: "cafes" }),
    ];
    const overture: PoiSearchResult[] = [
      makePoi("overture:gers-link-only", "Some Brand Store", 52.5205, 13.4, {
        gersId: "gers-link-only",
        category: "cafes",
        osmTags: { brand: "SomeBrand" },
      }),
      makePoi("overture:gers-name-match", "Café Roma", 52.521, 13.401, {
        gersId: "gers-name-match",
        category: "cafes",
      }),
    ];

    const link = new Map([["node/10", "gers-link-only"]]);
    const result = fusePoiResults(osm, overture, DEFAULT_CONFLATION_THRESHOLDS, link);

    const linkedFused = result.find((r) => r.id === "osm:node/10");
    expect(linkedFused).toBeDefined();
    expect(linkedFused?.gersId).toBe("gers-link-only");
    expect(linkedFused?.osmTags?.brand).toBe("SomeBrand");

    const nameFused = result.find((r) => r.id === "osm:node/20");
    expect(nameFused).toBeDefined();
    expect(nameFused?.gersId).toBe("gers-name-match");
  });
});
