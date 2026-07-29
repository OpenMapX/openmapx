import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ unsafe: vi.fn() }));

vi.mock("../../../src/db/index.js", () => ({ sql: { unsafe: mocks.unsafe } }));

import {
  OVERTURE_QUALITY_BASELINE,
  OVERTURE_QUALITY_BASELINE_RELEASE,
} from "../../../src/jobs/overture/eval/quality-baseline.js";
import {
  appliesToImportedRegion,
  evaluateOvertureQualityCase,
  validateFusedOvertureQuality,
  validateOvertureQuality,
} from "../../../src/jobs/overture/eval/quality-gate.js";

describe("Overture permanent quality baseline", () => {
  beforeEach(() => {
    mocks.unsafe.mockReset();
  });

  it("is tied to a real release and covers all required environments", () => {
    expect(OVERTURE_QUALITY_BASELINE_RELEASE).toBe("2026-07-22.0");
    expect(OVERTURE_QUALITY_BASELINE.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "aachen-centre-cafes",
        "aachen-centre-restaurants",
        "aachen-supermarkets",
        "aachen-pharmacies",
        "aachen-hotels",
        "aachen-fuel",
        "berlin-mitte-cafes",
        "monschau-centre-cafes",
        "maastricht-centre-cafes",
      ]),
    );
    expect(new Set(OVERTURE_QUALITY_BASELINE.map((entry) => entry.category))).toEqual(
      new Set(["cafes", "restaurants", "supermarkets", "pharmacies", "hotels", "fuel"]),
    );
    expect(
      OVERTURE_QUALITY_BASELINE.every(
        (entry) => entry.judgments.length > 0 && entry.judgments.some((item) => item.relevant),
      ),
    ).toBe(true);
    expect(
      OVERTURE_QUALITY_BASELINE.some((entry) => entry.judgments.some((item) => !item.relevant)),
    ).toBe(true);
    expect(
      OVERTURE_QUALITY_BASELINE.some((entry) =>
        entry.judgments.some((item) => Boolean(item.duplicateOf)),
      ),
    ).toBe(true);
  });

  it("selects only cases contained by the imported Geofabrik region", () => {
    expect(appliesToImportedRegion("europe/germany", "europe/germany/berlin")).toBe(true);
    expect(
      appliesToImportedRegion(
        "europe/germany/nordrhein-westfalen",
        "europe/germany/nordrhein-westfalen",
      ),
    ).toBe(true);
    expect(appliesToImportedRegion("europe/germany/berlin", "europe/germany/bayern")).toBe(false);
    expect(appliesToImportedRegion("europe/germany", "europe/netherlands")).toBe(false);
  });

  it("passes the reviewed floor and reports all metric dimensions", () => {
    const baseline = OVERTURE_QUALITY_BASELINE[0];
    const ids = [
      ...baseline.judgments.map((judgment) => judgment.gersId),
      ...Array.from(
        { length: baseline.minimumResultCount - baseline.judgments.length },
        (_, index) => `unjudged-${index}`,
      ),
    ];
    expect(evaluateOvertureQualityCase(baseline, ids)).toEqual({
      caseId: baseline.id,
      resultCount: baseline.minimumResultCount,
      relevantRecall: 1,
      knownIrrelevantHits: 2,
      knownDuplicateHits: 0,
      violations: [],
    });
  });

  it("detects catastrophic result loss and missing relevant anchors", () => {
    const baseline = OVERTURE_QUALITY_BASELINE.find(
      (entry) => entry.id === "monschau-centre-cafes",
    );
    if (!baseline) throw new Error("missing Monschau baseline");
    const result = evaluateOvertureQualityCase(baseline, []);
    expect(result.violations).toEqual([
      `result count 0 < ${baseline.minimumResultCount}`,
      `relevant recall 0.000 < ${baseline.minimumRelevantRecall.toFixed(3)}`,
    ]);
  });

  it("queries the staging schema and blocks a failing applicable case", async () => {
    const baseline = OVERTURE_QUALITY_BASELINE.find(
      (entry) => entry.id === "monschau-centre-cafes",
    );
    if (!baseline) throw new Error("missing Monschau baseline");
    mocks.unsafe.mockResolvedValue([]);

    await expect(
      validateOvertureQuality("overture_places__staging", baseline.region, [baseline]),
    ).rejects.toThrow(/staged-release quality regression: monschau-centre-cafes/);
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM "overture_places__staging".places'),
      [
        baseline.bbox.west,
        baseline.bbox.south,
        baseline.bbox.east,
        baseline.bbox.north,
        ["cafe", "coffee_shop", "tea_house"],
        0.5,
      ],
    );
  });

  it("does not query unrelated regional cases", async () => {
    await expect(
      validateOvertureQuality("overture_places__staging", "europe/france", [
        OVERTURE_QUALITY_BASELINE[0],
      ]),
    ).resolves.toEqual({ applicableCases: 0, cases: [] });
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  it("evaluates the final fused OSM-authoritative response against next links", async () => {
    const hotelBaseline = OVERTURE_QUALITY_BASELINE.find((entry) => entry.id === "aachen-hotels");
    if (!hotelBaseline) throw new Error("missing Aachen hotel baseline");
    const baseline = {
      ...hotelBaseline,
      minimumResultCount: 1,
      judgments: [
        {
          gersId: "gers-hotel",
          name: "Hotel Example",
          relevant: true,
        },
      ],
    };
    mocks.unsafe.mockImplementation(async (query: string) => {
      if (query.includes('FROM "overture_places".osm_pois')) {
        return [
          {
            osm_type: "node",
            osm_id: "1",
            name: "Hotel Example",
            lat: 50.775,
            lng: 6.085,
            category: "hotels",
            phone: null,
            website: null,
            address: null,
          },
        ];
      }
      if (query.includes('FROM "overture_places".places')) {
        return [
          {
            gers_id: "gers-hotel",
            name: "Hotel Example",
            lat: 50.775,
            lng: 6.085,
            phone: null,
            website: null,
            address: null,
          },
        ];
      }
      if (query.includes("poi_conflation_link_next")) {
        return [{ osm_type: "node", osm_id: "1", gers_id: "gers-hotel" }];
      }
      return [];
    });

    await expect(
      validateFusedOvertureQuality("overture_places", baseline.region, [baseline]),
    ).resolves.toEqual(
      expect.objectContaining({
        applicableCases: 1,
        cases: [expect.objectContaining({ relevantRecall: 1, resultCount: 1, violations: [] })],
      }),
    );
  });
});
