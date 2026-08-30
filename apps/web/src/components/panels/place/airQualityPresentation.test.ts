import type {
  AirQualityProgramId,
  AirQualityStandardId,
  AirQualityWarningCode,
  Pollutant,
} from "@openmapx/core";
import { describe, expect, it } from "vitest";

import {
  categoryPresentation,
  dominantPollutantKeys,
  freshnessPresentation,
  missingRequirementPresentation,
  pollutantPresentation,
  programLabelKey,
  provenancePresentation,
  qualityPresentation,
  standardLabelKey,
  unitDisplay,
  warningLabelKey,
} from "./airQualityPresentation";

describe("air-quality presentation", () => {
  it.each([
    ["ground", null, null, "airQuality.provenance.rawGround"],
    ["model", null, null, "airQuality.provenance.rawModel"],
    ["hybrid", null, null, "airQuality.provenance.rawHybrid"],
    ["ground", "published-index", "official-agency", "airQuality.provenance.officialGround"],
    ["model", "published-index", "data-owner", "airQuality.provenance.publishedModel"],
    ["hybrid", "published-index", "aggregator", "airQuality.provenance.publishedHybrid"],
    ["ground", "openmapx-computed-index", "openmapx", "airQuality.provenance.computedGround"],
    ["model", "openmapx-computed-index", "openmapx", "airQuality.provenance.computedModel"],
    ["hybrid", "openmapx-computed-index", "openmapx", "airQuality.provenance.computedHybrid"],
  ] as const)("classifies %s/%s/%s provenance", (basis, derivation, authority, expected) => {
    expect(provenancePresentation({ basis, derivation, authority })).toEqual({
      labelKey: expected,
      diagnostic: null,
    });
  });

  it("fails safe for a future or inconsistent provenance combination", () => {
    expect(
      provenancePresentation({
        basis: "ground",
        derivation: "published-index",
        authority: "openmapx",
      }),
    ).toEqual({
      labelKey: "airQuality.provenance.unclassified",
      diagnostic: "unexpected-provenance:ground:published-index:openmapx",
    });
  });

  it.each([
    ["regulatory-certified", "airQuality.quality.regulatoryCertified"],
    ["quality-assured", "airQuality.quality.qualityAssured"],
    ["preliminary", "airQuality.quality.preliminary"],
    ["estimated", "airQuality.quality.estimated"],
    ["unknown", "airQuality.quality.unknown"],
  ] as const)("presents %s quality", (quality, labelKey) => {
    expect(qualityPresentation(quality)).toEqual({ labelKey, diagnostic: null });
  });

  it.each([
    ["fresh", "airQuality.freshness.fresh"],
    ["stale", "airQuality.freshness.stale"],
    ["unknown", "airQuality.freshness.unknown"],
  ] as const)("presents %s freshness", (freshness, labelKey) => {
    expect(freshnessPresentation(freshness)).toEqual({ labelKey, diagnostic: null });
  });

  it("has static labels for every standard and program", () => {
    const standards: AirQualityStandardId[] = [
      "us-epa-2024",
      "eu-eea-current",
      "uk-daqi-current",
      "in-naqi-current",
      "cn-hj633-2026",
      "ca-aqhi-current",
    ];
    const programs: AirQualityProgramId[] = [
      "us-epa-aqi",
      "eea-european-aqi",
      "uk-daqi",
      "in-naqi",
      "cn-hj633",
      "ca-aqhi",
      "ca-qc-info-smog",
    ];
    expect(standards.map(standardLabelKey)).toHaveLength(standards.length);
    expect(programs.map(programLabelKey)).toHaveLength(programs.length);
    expect(standardLabelKey(null)).toBe("airQuality.standard.unresolved");
    expect(programLabelKey(null)).toBe("airQuality.program.unresolved");
  });

  it("has static pollutant and unit display for every API value", () => {
    const pollutants: Pollutant[] = ["pm25", "pm10", "o3", "no2", "so2", "co", "nh3", "no"];
    expect(pollutants.map(pollutantPresentation)).toEqual([
      { labelKey: "airQuality.pollutant.pm25", symbol: "PM₂.₅", diagnostic: null },
      { labelKey: "airQuality.pollutant.pm10", symbol: "PM₁₀", diagnostic: null },
      { labelKey: "airQuality.pollutant.o3", symbol: "O₃", diagnostic: null },
      { labelKey: "airQuality.pollutant.no2", symbol: "NO₂", diagnostic: null },
      { labelKey: "airQuality.pollutant.so2", symbol: "SO₂", diagnostic: null },
      { labelKey: "airQuality.pollutant.co", symbol: "CO", diagnostic: null },
      { labelKey: "airQuality.pollutant.nh3", symbol: "NH₃", diagnostic: null },
      { labelKey: "airQuality.pollutant.no", symbol: "NO", diagnostic: null },
    ]);
    expect(["ug/m3", "mg/m3", "ppb", "ppm"].map(unitDisplay)).toEqual([
      "µg/m³",
      "mg/m³",
      "ppb",
      "ppm",
    ]);
    expect(dominantPollutantKeys(["pm25", "o3"])).toEqual([
      "airQuality.pollutant.pm25",
      "airQuality.pollutant.o3",
    ]);
  });

  it.each([
    ["us-epa-2024", "unhealthy-sensitive", "airQuality.category.unhealthySensitive"],
    ["eu-eea-current", "fair", "airQuality.category.fair"],
    ["uk-daqi-current", "moderate-5", "airQuality.ukDaqi.level5"],
    ["in-naqi-current", "satisfactory", "airQuality.category.satisfactory"],
    ["cn-hj633-2026", "excellent", "airQuality.cn.category.excellent"],
    ["ca-aqhi-current", "low-risk", "airQuality.ca.category.lowRisk"],
  ] as const)("presents a category for %s", (standard, category, labelKey) => {
    const presented = categoryPresentation(standard, category);
    expect(presented.labelKey).toBe(labelKey);
    expect(presented.swatch).toMatch(/^#[0-9a-f]{6}$/i);
    expect(presented.foreground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(presented.diagnostic).toBeNull();
  });

  it("never classifies an unknown category as good", () => {
    expect(categoryPresentation("us-epa-2024", "future-category")).toEqual({
      labelKey: "airQuality.category.unclassified",
      swatch: "#546e7a",
      foreground: "#ffffff",
      diagnostic: "unknown-category:us-epa-2024:future-category",
    });
  });

  it("maps every warning and known/missing requirement without dynamic translation keys", () => {
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
    expect(warnings.map(warningLabelKey)).toEqual([
      "airQuality.warning.staleEvidence",
      "airQuality.warning.partialProviders",
      "airQuality.warning.quotaTruncated",
      "airQuality.warning.policyExcluded",
      "airQuality.warning.duplicateConflict",
      "airQuality.warning.jurisdictionUnresolved",
      "airQuality.warning.jurisdictionHintMismatch",
      "airQuality.warning.comparisonUnavailable",
      "airQuality.warning.staleCache",
      "airQuality.warning.rasterAxisChanged",
    ]);
    expect(missingRequirementPresentation("No complete EPA pollutant window")).toEqual({
      labelKey: "airQuality.requirement.epaWindow",
      diagnostic: null,
    });
    expect(missingRequirementPresentation("future upstream detail")).toEqual({
      labelKey: "airQuality.requirement.unclassified",
      diagnostic: "unknown-requirement",
    });
  });
});
