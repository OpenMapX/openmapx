import type {
  AirQualityEvidence,
  AirQualityIndex,
  AirQualityProgramId,
  AirQualityStandardId,
  AirQualityWarningCode,
  Pollutant,
} from "@openmapx/core";

export interface SafePresentation {
  labelKey: string;
  diagnostic: string | null;
}

type Basis = AirQualityEvidence["basis"];
type Derivation = AirQualityIndex["derivation"];
type Authority = AirQualityIndex["authority"];

export function provenancePresentation(input: {
  basis: Basis;
  derivation: Derivation | null;
  authority: Authority | null;
}): SafePresentation {
  const { basis, derivation, authority } = input;
  if (derivation === null && authority === null) {
    switch (basis) {
      case "ground":
        return { labelKey: "airQuality.provenance.rawGround", diagnostic: null };
      case "model":
        return { labelKey: "airQuality.provenance.rawModel", diagnostic: null };
      case "hybrid":
        return { labelKey: "airQuality.provenance.rawHybrid", diagnostic: null };
    }
  }
  if (derivation === "openmapx-computed-index" && authority === "openmapx") {
    switch (basis) {
      case "ground":
        return { labelKey: "airQuality.provenance.computedGround", diagnostic: null };
      case "model":
        return { labelKey: "airQuality.provenance.computedModel", diagnostic: null };
      case "hybrid":
        return { labelKey: "airQuality.provenance.computedHybrid", diagnostic: null };
    }
  }
  if (derivation === "published-index" && authority !== "openmapx" && authority !== null) {
    if (authority === "official-agency") {
      switch (basis) {
        case "ground":
          return { labelKey: "airQuality.provenance.officialGround", diagnostic: null };
        case "model":
          return { labelKey: "airQuality.provenance.officialModel", diagnostic: null };
        case "hybrid":
          return { labelKey: "airQuality.provenance.officialHybrid", diagnostic: null };
      }
    }
    switch (basis) {
      case "ground":
        return { labelKey: "airQuality.provenance.publishedGround", diagnostic: null };
      case "model":
        return { labelKey: "airQuality.provenance.publishedModel", diagnostic: null };
      case "hybrid":
        return { labelKey: "airQuality.provenance.publishedHybrid", diagnostic: null };
    }
  }
  return {
    labelKey: "airQuality.provenance.unclassified",
    diagnostic: `unexpected-provenance:${basis}:${derivation ?? "none"}:${authority ?? "none"}`,
  };
}

export function qualityPresentation(
  quality: AirQualityEvidence["qualityStatus"],
): SafePresentation {
  switch (quality) {
    case "regulatory-certified":
      return { labelKey: "airQuality.quality.regulatoryCertified", diagnostic: null };
    case "quality-assured":
      return { labelKey: "airQuality.quality.qualityAssured", diagnostic: null };
    case "preliminary":
      return { labelKey: "airQuality.quality.preliminary", diagnostic: null };
    case "estimated":
      return { labelKey: "airQuality.quality.estimated", diagnostic: null };
    case "unknown":
      return { labelKey: "airQuality.quality.unknown", diagnostic: null };
    default:
      return { labelKey: "airQuality.quality.unclassified", diagnostic: "unknown-quality" };
  }
}

export function freshnessPresentation(
  freshness: AirQualityEvidence["freshness"],
): SafePresentation {
  switch (freshness) {
    case "fresh":
      return { labelKey: "airQuality.freshness.fresh", diagnostic: null };
    case "stale":
      return { labelKey: "airQuality.freshness.stale", diagnostic: null };
    case "unknown":
      return { labelKey: "airQuality.freshness.unknown", diagnostic: null };
    default:
      return { labelKey: "airQuality.freshness.unclassified", diagnostic: "unknown-freshness" };
  }
}

const STANDARD_LABELS: Record<AirQualityStandardId, string> = {
  "us-epa-2024": "airQuality.standard.usEpa2024",
  "eu-eea-current": "airQuality.standard.euEeaCurrent",
  "uk-daqi-current": "airQuality.standard.ukDaqiCurrent",
  "in-naqi-current": "airQuality.standard.inNaqiCurrent",
  "cn-hj633-2026": "airQuality.standard.cnHj6332026",
  "ca-aqhi-current": "airQuality.standard.caAqhiCurrent",
};

const PROGRAM_LABELS: Record<AirQualityProgramId, string> = {
  "us-epa-aqi": "airQuality.program.usEpaAqi",
  "eea-european-aqi": "airQuality.program.eeaEuropeanAqi",
  "uk-daqi": "airQuality.program.ukDaqi",
  "in-naqi": "airQuality.program.inNaqi",
  "cn-hj633": "airQuality.program.cnHj633",
  "ca-aqhi": "airQuality.program.caAqhi",
  "ca-qc-info-smog": "airQuality.program.caQcInfoSmog",
};

export function standardLabelKey(standard: AirQualityStandardId | null): string {
  return standard ? STANDARD_LABELS[standard] : "airQuality.standard.unresolved";
}

export function programLabelKey(program: AirQualityProgramId | null): string {
  return program ? PROGRAM_LABELS[program] : "airQuality.program.unresolved";
}

const POLLUTANTS: Record<Pollutant, { labelKey: string; symbol: string }> = {
  pm25: { labelKey: "airQuality.pollutant.pm25", symbol: "PM₂.₅" },
  pm10: { labelKey: "airQuality.pollutant.pm10", symbol: "PM₁₀" },
  o3: { labelKey: "airQuality.pollutant.o3", symbol: "O₃" },
  no2: { labelKey: "airQuality.pollutant.no2", symbol: "NO₂" },
  so2: { labelKey: "airQuality.pollutant.so2", symbol: "SO₂" },
  co: { labelKey: "airQuality.pollutant.co", symbol: "CO" },
  nh3: { labelKey: "airQuality.pollutant.nh3", symbol: "NH₃" },
  no: { labelKey: "airQuality.pollutant.no", symbol: "NO" },
};

export function pollutantPresentation(pollutant: Pollutant) {
  const known = POLLUTANTS[pollutant];
  if (known) return { ...known, diagnostic: null };
  return {
    labelKey: "airQuality.pollutant.unclassified",
    symbol: "?",
    diagnostic: "unknown-pollutant",
  };
}

export function dominantPollutantKeys(pollutants: readonly Pollutant[]): string[] {
  return pollutants.map((pollutant) => pollutantPresentation(pollutant).labelKey);
}

export function unitDisplay(unit: string): string {
  switch (unit) {
    case "ug/m3":
      return "µg/m³";
    case "mg/m3":
      return "mg/m³";
    case "ppb":
      return "ppb";
    case "ppm":
      return "ppm";
    default:
      return "—";
  }
}

interface CategoryDefinition {
  labelKey: string;
  swatch: string;
}

const CATEGORY_BY_STANDARD: Record<
  AirQualityStandardId,
  Readonly<Record<string, CategoryDefinition>>
> = {
  "us-epa-2024": {
    good: { labelKey: "airQuality.category.good", swatch: "#00e400" },
    moderate: { labelKey: "airQuality.category.moderate", swatch: "#ffff00" },
    "unhealthy-sensitive": {
      labelKey: "airQuality.category.unhealthySensitive",
      swatch: "#ff7e00",
    },
    unhealthy: { labelKey: "airQuality.category.unhealthy", swatch: "#ff0000" },
    "very-unhealthy": { labelKey: "airQuality.category.veryUnhealthy", swatch: "#8f3f97" },
    hazardous: { labelKey: "airQuality.category.hazardous", swatch: "#7e0023" },
  },
  "eu-eea-current": {
    good: { labelKey: "airQuality.category.good", swatch: "#50f0e6" },
    fair: { labelKey: "airQuality.category.fair", swatch: "#50ccaa" },
    moderate: { labelKey: "airQuality.category.moderate", swatch: "#f0e641" },
    poor: { labelKey: "airQuality.category.poor", swatch: "#ff5050" },
    "very-poor": { labelKey: "airQuality.category.veryPoor", swatch: "#960032" },
    "extremely-poor": { labelKey: "airQuality.category.extremelyPoor", swatch: "#7d2181" },
  },
  "uk-daqi-current": Object.fromEntries(
    [
      ["low-1", "#9cff9c"],
      ["low-2", "#31ff00"],
      ["low-3", "#31cf00"],
      ["moderate-4", "#ffff00"],
      ["moderate-5", "#ffcf00"],
      ["moderate-6", "#ff9a00"],
      ["high-7", "#ff6464"],
      ["high-8", "#ff0000"],
      ["high-9", "#990000"],
      ["very-high-10", "#ce30ff"],
    ].map(([id, swatch], index) => [
      id,
      { labelKey: `airQuality.ukDaqi.level${index + 1}`, swatch },
    ]),
  ),
  "in-naqi-current": {
    good: { labelKey: "airQuality.category.good", swatch: "#00b050" },
    satisfactory: { labelKey: "airQuality.category.satisfactory", swatch: "#92d050" },
    moderate: { labelKey: "airQuality.category.moderate", swatch: "#ffff00" },
    poor: { labelKey: "airQuality.category.poor", swatch: "#ff9900" },
    "very-poor": { labelKey: "airQuality.category.veryPoor", swatch: "#ff0000" },
    severe: { labelKey: "airQuality.category.severe", swatch: "#c00000" },
  },
  "cn-hj633-2026": {
    excellent: { labelKey: "airQuality.cn.category.excellent", swatch: "#00e400" },
    good: { labelKey: "airQuality.cn.category.good", swatch: "#ffff00" },
    "lightly-polluted": {
      labelKey: "airQuality.cn.category.lightlyPolluted",
      swatch: "#ff7e00",
    },
    "moderately-polluted": {
      labelKey: "airQuality.cn.category.moderatelyPolluted",
      swatch: "#ff0000",
    },
    "heavily-polluted": {
      labelKey: "airQuality.cn.category.heavilyPolluted",
      swatch: "#99004c",
    },
    "severely-polluted": {
      labelKey: "airQuality.cn.category.severelyPolluted",
      swatch: "#7e0023",
    },
  },
  "ca-aqhi-current": {
    "low-risk": { labelKey: "airQuality.ca.category.lowRisk", swatch: "#00ccff" },
    "moderate-risk": { labelKey: "airQuality.ca.category.moderateRisk", swatch: "#ffcc00" },
    "high-risk": { labelKey: "airQuality.ca.category.highRisk", swatch: "#ff0000" },
    "very-high-risk": { labelKey: "airQuality.ca.category.veryHighRisk", swatch: "#660000" },
  },
};

function contrastForeground(hex: string): "#000000" | "#ffffff" {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 145 ? "#000000" : "#ffffff";
}

export function categoryPresentation(
  standard: AirQualityStandardId | null,
  categoryId: string,
): CategoryDefinition & { foreground: string; diagnostic: string | null } {
  const definition = standard ? CATEGORY_BY_STANDARD[standard][categoryId] : undefined;
  if (!definition) {
    return {
      labelKey: "airQuality.category.unclassified",
      swatch: "#546e7a",
      foreground: "#ffffff",
      diagnostic: `unknown-category:${standard ?? "none"}:${categoryId}`,
    };
  }
  return {
    ...definition,
    foreground: contrastForeground(definition.swatch),
    diagnostic: null,
  };
}

const WARNING_LABELS: Record<AirQualityWarningCode, string> = {
  stale_evidence: "airQuality.warning.staleEvidence",
  partial_providers: "airQuality.warning.partialProviders",
  quota_truncated: "airQuality.warning.quotaTruncated",
  policy_excluded: "airQuality.warning.policyExcluded",
  duplicate_conflict: "airQuality.warning.duplicateConflict",
  jurisdiction_unresolved: "airQuality.warning.jurisdictionUnresolved",
  jurisdiction_hint_mismatch: "airQuality.warning.jurisdictionHintMismatch",
  comparison_unavailable: "airQuality.warning.comparisonUnavailable",
  stale_cache: "airQuality.warning.staleCache",
  raster_axis_changed: "airQuality.warning.rasterAxisChanged",
};

export function warningLabelKey(warning: AirQualityWarningCode): string {
  return WARNING_LABELS[warning] ?? "airQuality.warning.unclassified";
}

const REQUIREMENT_LABELS: Readonly<Record<string, string>> = {
  "No complete EPA pollutant window": "airQuality.requirement.epaWindow",
  "No complete DAQI pollutant window": "airQuality.requirement.daqiWindow",
  "EEA station-type pollutant qualification not met": "airQuality.requirement.eeaStation",
  "CPCB requires at least three pollutants including PM2.5 or PM10":
    "airQuality.requirement.naqiPollutants",
  "ECCC community-published AQHI required; local calculation is unsupported":
    "airQuality.requirement.ecccPublished",
  "Pollutant series must share one spatial and temporal coherence identity":
    "airQuality.requirement.coherentSeries",
  "HJ 633-2026 is effective from 2026-03-01 in China": "airQuality.requirement.hjEffectiveDate",
  "No complete HJ 633-2026 daily pollutant value": "airQuality.requirement.hjDailyWindow",
  "No complete HJ 633-2026 one-hour pollutant value": "airQuality.requirement.hjHourlyWindow",
  "CPCB publishes open-ended Severe concentration bands without exact upper interpolation breakpoints":
    "airQuality.requirement.naqiOpenEnded",
  "CPCB does not state a concentration-rounding rule for gaps between integer-labelled bands":
    "airQuality.requirement.naqiRounding",
};

export function missingRequirementPresentation(requirement: string): SafePresentation {
  const labelKey = REQUIREMENT_LABELS[requirement];
  return labelKey
    ? { labelKey, diagnostic: null }
    : { labelKey: "airQuality.requirement.unclassified", diagnostic: "unknown-requirement" };
}
