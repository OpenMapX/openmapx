import { describe, expect, it } from "vitest";

import { selectAirQuality } from "../selection";
import type {
  AirQualityEvidence,
  AirQualityIndex,
  AirQualityRejectionReason,
  AirQualityWarningCode,
} from "../types";

function index(id: string, update: Partial<AirQualityIndex> = {}): AirQualityIndex {
  return {
    indexId: id,
    standardId: "us-epa-2024",
    standardRevision: "epa-aqi-tad-2024-05",
    methodId: "epa-aqi",
    methodRevision: "2024-05",
    effectiveDate: "2024-05-06",
    value: 42,
    displayValue: "42",
    categoryId: "good",
    dominantPollutants: ["pm25"],
    authority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    derivation: "published-index",
    inputObservationIds: [id],
    ...update,
  };
}

function evidence(id: string, update: Partial<AirQualityEvidence> = {}): AirQualityEvidence {
  return {
    observationId: id,
    providerId: id.split("-")[0] ?? id,
    sourceIds: ["source"],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    indices: [index(`idx-${id}`)],
    pollutants: [],
    observedAt: "2026-08-30T11:00:00Z",
    forecastFor: null,
    publishedAt: "2026-08-30T11:05:00Z",
    validUntil: "2026-08-30T13:00:00Z",
    freshness: "fresh",
    spatial: {
      kind: "reporting-area",
      id: `spatial-${id}`,
      name: id,
      coordinates: null,
      timeZone: "America/New_York",
      distanceMeters: null,
      stationClass: null,
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "point-in-polygon",
    },
    completenessByStandard: { "us-epa-2024": { passes: true, missingRequirements: [] } },
    sources: [
      {
        sourceId: "source",
        name: "Source",
        url: "https://example.test",
        owner: "Agency",
        license: null,
        methodologyUrl: null,
        attribution: "Agency",
      },
    ],
    warnings: [],
    ...update,
  };
}

function computed(id: string, update: Partial<AirQualityEvidence> = {}): AirQualityEvidence {
  const value = evidence(id);
  const defaults = {
    ...value,
    basis: "ground" as const,
    spatial: {
      ...value.spatial,
      kind: "station" as const,
      coverageMethod: "nearest-station" as const,
      coversRequestedPoint: false,
      distanceMeters: 5_000,
      stationClass: "reference" as const,
      mobile: false,
    },
    indices: [
      index(`idx-${id}`, {
        authority: "openmapx",
        derivation: "openmapx-computed-index",
        basis: "ground",
      }),
    ],
  };
  return {
    ...defaults,
    ...update,
    spatial: update.spatial ?? defaults.spatial,
    indices: update.indices ?? defaults.indices,
  };
}

function model(id: string, update: Partial<AirQualityEvidence> = {}): AirQualityEvidence {
  const value = evidence(id);
  const defaults = {
    ...value,
    basis: "model" as const,
    spatial: {
      ...value.spatial,
      kind: "grid-cell" as const,
      coverageMethod: "provider-point-lookup" as const,
    },
    indices: [
      index(`idx-${id}`, {
        authority: "data-owner",
        derivation: "published-index",
        basis: "model",
      }),
    ],
  };
  return {
    ...defaults,
    ...update,
    spatial: update.spatial ?? defaults.spatial,
    indices: update.indices ?? defaults.indices,
  };
}

const run = (
  items: AirQualityEvidence[],
  extra: Partial<Parameters<typeof selectAirQuality>[0]> = {},
) =>
  selectAirQuality({
    evidence: items,
    localStandardId: "us-epa-2024",
    localStandardRevision: "epa-aqi-tad-2024-05",
    targetAt: "2026-08-30T12:00:00Z",
    providerPriorities: { agency: 20, computed: 1, model: 0, a: 2, b: 1 },
    ...extra,
  });

describe("air-quality selection matrix", () => {
  it("applies freshness before class, then agency/computed/model class", () => {
    expect(
      run([evidence("agency", { freshness: "stale" }), computed("computed")]).primaryIndexId,
    ).toBe("idx-computed");
    expect(run([model("model"), computed("computed"), evidence("agency")]).rankedIndexIds).toEqual([
      "idx-agency",
      "idx-computed",
      "idx-model",
    ]);
  });

  it("treats a validated OpenMapX-computed hybrid surface as modeled evidence", () => {
    const hybrid = model("hybrid", {
      basis: "hybrid",
      indices: [
        index("idx-hybrid", {
          authority: "openmapx",
          derivation: "openmapx-computed-index",
          basis: "hybrid",
        }),
      ],
    });

    expect(run([hybrid])).toMatchObject({
      primaryIndexId: "idx-hybrid",
      rankedIndexIds: ["idx-hybrid"],
    });
  });

  it("applies every remaining index tuple component in order", () => {
    const hybrid = evidence("a-hybrid", {
      basis: "hybrid",
      indices: [index("idx-a-hybrid", { basis: "hybrid" })],
    });
    expect(run([hybrid, evidence("b-ground")]).primaryIndexId).toBe("idx-b-ground");
    expect(
      run([
        computed("a-reg", {
          spatial: { ...computed("seed").spatial, stationClass: "regulatory", distanceMeters: 100 },
        }),
        computed("b-ref", {
          spatial: {
            ...computed("seed").spatial,
            stationClass: "reference",
            distanceMeters: 40_000,
          },
        }),
      ]).primaryIndexId,
    ).toBe("idx-b-ref");
    expect(
      run([
        computed("a-near", { spatial: { ...computed("seed").spatial, distanceMeters: 2_000 } }),
        computed("b-far", { spatial: { ...computed("seed").spatial, distanceMeters: 3_000 } }),
      ]).primaryIndexId,
    ).toBe("idx-a-near");
    expect(
      run([
        evidence("a-old", { observedAt: "2026-08-30T10:00:00Z" }),
        evidence("b-new", { observedAt: "2026-08-30T11:30:00Z" }),
      ]).primaryIndexId,
    ).toBe("idx-b-new");
    expect(run([evidence("a"), evidence("b")]).primaryIndexId).toBe("idx-b");
    expect(
      run(
        [
          evidence("same-z", { providerId: "same", indices: [index("z")] }),
          evidence("same-a", { providerId: "same", indices: [index("a")] }),
        ],
        { providerPriorities: { same: 1 } },
      ).primaryIndexId,
    ).toBe("a");
  });

  it("keeps null distance last and rejects null time deterministically", () => {
    expect(
      run([
        computed("near"),
        computed("null", { spatial: { ...computed("seed").spatial, distanceMeters: null } }),
      ]).primaryIndexId,
    ).toBe("idx-near");
    const timeless = evidence("timeless", {
      observedAt: null,
      forecastFor: null,
      publishedAt: null,
    });
    expect(run([timeless]).rejected[0]?.reasons).toContain("invalid_time");
    expect(
      run([
        evidence("future", {
          observedAt: "2026-08-30T12:30:00Z",
          publishedAt: "2026-08-30T12:31:00Z",
        }),
      ]).rejected[0]?.reasons,
    ).toContain("invalid_time");
  });

  it("enforces computed-monitor qualification and exposes 50–100 km evidence only as secondary context", () => {
    const far = computed("far", {
      spatial: { ...computed("seed").spatial, distanceMeters: 75_000 },
    });
    const mobile = computed("mobile", { spatial: { ...computed("seed").spatial, mobile: true } });
    const lowCost = computed("low", {
      spatial: { ...computed("seed").spatial, stationClass: "low-cost" },
    });
    const result = run([far, mobile, lowCost]);
    expect(result.primaryIndexId).toBeNull();
    expect(result.secondaryEvidenceIds).toEqual(["far"]);
    expect(result.rejected.find(({ evidenceId }) => evidenceId === "far")?.reasons).toContain(
      "outside_primary_radius",
    );
    expect(result.rejected.find(({ evidenceId }) => evidenceId === "mobile")?.reasons).toContain(
      "mobile_sensor",
    );
    expect(result.rejected.find(({ evidenceId }) => evidenceId === "low")?.reasons).toEqual(
      expect.arrayContaining(["low_cost_sensor", "unrecognized_station_class"]),
    );
  });

  it("uses the separate raw tuple without promoting a raw value to an index", () => {
    const rawGround = evidence("ground", {
      indices: [],
      pollutants: [
        {
          pollutant: "pm25",
          value: 5,
          unit: "ug/m3",
          originalValue: 5,
          originalUnit: "ug/m3",
          averagingPeriodMinutes: 60,
          intervalStart: null,
          intervalEnd: "2026-08-30T12:00:00Z",
          sampleCount: 1,
          expectedSampleCount: 1,
          completenessPercent: 100,
          gapFilled: false,
          estimated: false,
          sensorId: "s",
        },
      ],
    });
    const rawModel = model("model", { indices: [], pollutants: rawGround.pollutants });
    const result = run([rawModel, rawGround]);
    expect(result.primaryEvidenceId).toBe("ground");
    expect(result.primaryIndexId).toBeNull();
    expect(result.reasons).toEqual(["raw_fallback"]);
  });

  it("isolates comparison indices from the local-standard headline", () => {
    const local = index("local");
    const comparison = index("comparison", {
      standardId: "eu-eea-current",
      standardRevision: "eea-eaqi-2026-08-29",
    });
    const result = run([evidence("both", { indices: [comparison, local] })]);
    expect(result.primaryIndexId).toBe("local");
    expect(result.rejected).toContainEqual(
      expect.objectContaining({
        indexId: "comparison",
        reasons: expect.arrayContaining(["wrong_standard"]),
      }),
    );
  });

  it("preserves every closed rejection and warning code", () => {
    const rejections: AirQualityRejectionReason[] = [
      "wrong_standard",
      "unverified_method",
      "invalid_schema",
      "invalid_time",
      "stale",
      "does_not_cover_point",
      "outside_primary_radius",
      "mobile_sensor",
      "low_cost_sensor",
      "unrecognized_station_class",
      "incomplete_window",
      "missing_required_pollutant",
      "unsupported_unit",
      "incoherent_series",
      "duplicate_conflict",
      "policy_disallowed",
      "provider_unhealthy",
      "provider_timeout",
      "quota_exhausted",
    ];
    const warnings: AirQualityWarningCode[] = [
      "stale_evidence",
      "partial_providers",
      "quota_truncated",
      "policy_excluded",
      "duplicate_conflict",
      "jurisdiction_unresolved",
      "jurisdiction_hint_mismatch",
      "comparison_unavailable",
      "stale_cache",
      "raster_axis_changed",
    ];
    const item = evidence("all");
    const result = run([item], {
      additionalRejections: { "idx-all": rejections },
      additionalWarnings: warnings,
    });
    expect(result.rejected[0]?.reasons).toEqual([...rejections].sort());
    expect(result.warnings).toEqual([...warnings].sort());
  });

  it("is byte-equivalent under evidence and index permutations", () => {
    const first = evidence("a", { indices: [index("a2"), index("a1")] });
    const second = computed("b");
    const forward = run([first, second]);
    const reverse = run([{ ...first, indices: [...first.indices].reverse() }, second].reverse());
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
  });
});
