import type { SearchIntent } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { SemanticCategoryIndex } from "../semantic-category-index.js";
import {
  createSemanticTaxonomyResolver,
  looksLikeAddressOrCodeIntent,
  planSemanticResolution,
} from "../semantic-taxonomy-resolver.js";
import {
  type SemanticCalibration,
  SemanticEmbeddingError,
  type SemanticScoreResult,
} from "../semantic-taxonomy-types.js";

const catalog = [
  {
    categoryId: "libraries",
    labels: { en: "Libraries", de: "Bibliotheken" },
    document:
      "Place category: Libraries. German label: Bibliotheken. English terms: library. German terms: bibliothek.",
    filter: { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "library" }] }] },
  },
  {
    categoryId: "pharmacies",
    labels: { en: "Pharmacies", de: "Apotheken" },
    document:
      "Place category: Pharmacies. German label: Apotheken. English terms: pharmacy. German terms: apotheke.",
    filter: { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "pharmacy" }] }] },
  },
] as const;

const calibration: SemanticCalibration = {
  version: 1,
  model: "qwen3-embedding:0.6b",
  modelDigest: "sha256:test",
  dimensions: 256,
  embeddingSchemaVersion: 1,
  resolutionPolicyVersion: 1,
  behaviorChecksum: "a".repeat(64),
  catalogChecksum: "b".repeat(64),
  minimumScore: 0.7,
  minimumMargin: 0.1,
  activationConfidence: 0.55,
};

const libraryScore: SemanticScoreResult = {
  top: { categoryId: "libraries", score: 0.9 },
  second: { categoryId: "pharmacies", score: 0.4 },
  margin: 0.5,
};

function intent(
  selectors: SearchIntent["filter"]["selectors"] = [],
  confidence = 0.2,
): SearchIntent {
  return {
    filter: {
      selectors,
      require: [{ key: "wheelchair", op: "=", value: "yes" }],
      exclude: [{ key: "brand", op: "exists" }],
      elementTypes: ["node"],
    },
    spatial_constraint: { type: "current_view" },
    time_constraint: { type: "open_now" },
    sort_by: "distance",
    unmapped_attributes: ["quiet"],
    confidence,
    explanation: "original",
  };
}

describe("semantic taxonomy policy", () => {
  it.each([
    "",
    "12345",
    "https://example.com/cafe",
    "FRA",
    "52062 Aachen",
    "Friedrichstraße 43",
    "50.7753, 6.0839",
    "9F28+4V Aachen",
    "A1 exit 12",
    "Starbucks",
    "Hotel Adlon",
    "Cafe Central",
  ])("guards %s before scoring", (query) => {
    expect(
      planSemanticResolution({ query, intent: intent(), calibration, catalog, shadow: false }).kind,
    ).toBe("decided");
  });

  it.each(["24 hour pharmacy", "24h Apotheke", "restaurant for 2", "wheelchair parking level 2"])(
    "does not confuse numeric modifiers with addresses: %s",
    (query) => {
      expect(looksLikeAddressOrCodeIntent(query)).toBe(false);
      expect(
        planSemanticResolution({
          query,
          lang: query.includes("Apotheke") ? "de" : "en",
          intent: intent(),
          calibration,
          catalog,
          shadow: false,
        }),
      ).toEqual({ kind: "needs-score" });
    },
  );

  it("preserves plausible parser output outside shadow mode", () => {
    const original = intent([{ tags: [{ key: "amenity", op: "=", value: "pharmacy" }] }], 0.6);
    const result = planSemanticResolution({
      query: "medicine nearby",
      intent: original,
      calibration,
      catalog,
      score: libraryScore,
      shadow: false,
    });
    expect(result).toMatchObject({ kind: "decided", intent: original, applied: false });
  });

  it("adds selectors immutably while preserving every other constraint", () => {
    const original = intent();
    const result = planSemanticResolution({
      query: "somewhere quiet to study",
      lang: "de-DE",
      intent: original,
      calibration,
      catalog,
      score: libraryScore,
      shadow: false,
    });
    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") return;
    expect(result.applied).toBe(true);
    expect(result.intent).not.toBe(original);
    expect(original.filter.selectors).toEqual([]);
    expect(result.intent.filter.selectors).toEqual(catalog[0].filter.selectors);
    expect(result.intent.filter.require).toBe(original.filter.require);
    expect(result.intent.filter.exclude).toBe(original.filter.exclude);
    expect(result.intent.filter.elementTypes).toBe(original.filter.elementTypes);
    expect(result.intent.spatial_constraint).toBe(original.spatial_constraint);
    expect(result.intent.time_constraint).toBe(original.time_constraint);
    expect(result.intent.unmapped_attributes).toBe(original.unmapped_attributes);
    expect(result.intent.explanation).toBe("Suche nach Bibliotheken");
    expect(result.intent.confidence).toBe(0.55);
  });

  it("corroborates identical low-confidence selectors and rejects conflicts", () => {
    const matching = intent(catalog[0].filter.selectors, 0.2);
    const corroborated = planSemanticResolution({
      query: "quiet place for study",
      intent: matching,
      calibration,
      catalog,
      score: libraryScore,
      shadow: false,
    });
    expect(corroborated).toMatchObject({ kind: "decided", applied: true });
    const conflict = intent(catalog[1].filter.selectors, 0.2);
    const rejected = planSemanticResolution({
      query: "quiet place for study",
      intent: conflict,
      calibration,
      catalog,
      score: libraryScore,
      shadow: false,
    });
    expect(rejected).toMatchObject({
      kind: "decided",
      applied: false,
      intent: conflict,
      outcome: { status: "abstained", reason: "selector-conflict" },
    });
  });

  it("applies score and margin thresholds independently", () => {
    expect(
      planSemanticResolution({
        query: "quiet study room",
        intent: intent(),
        calibration,
        catalog,
        score: { ...libraryScore, top: { ...libraryScore.top, score: 0.6 } },
        shadow: false,
      }),
    ).toMatchObject({ outcome: { reason: "below-score" } });
    expect(
      planSemanticResolution({
        query: "quiet study room",
        intent: intent(),
        calibration,
        catalog,
        score: { ...libraryScore, margin: 0.05 },
        shadow: false,
      }),
    ).toMatchObject({ outcome: { reason: "below-margin" } });
  });

  it("maps typed index failures to unavailable without throwing", async () => {
    const index = {
      score: vi.fn().mockRejectedValue(new SemanticEmbeddingError("timeout", "late")),
    } as unknown as SemanticCategoryIndex;
    const resolver = createSemanticTaxonomyResolver({ index, calibration, catalog });
    await expect(
      resolver.resolve({
        query: "somewhere quiet to study",
        intent: intent(),
        signal: new AbortController().signal,
        shadow: false,
      }),
    ).resolves.toMatchObject({ outcome: { status: "unavailable", reason: "timeout" } });
  });
});
