import { z } from "zod";

import manifestData from "../data/standards/eccc-aqhi-2026-08-29.json";
import type { AirQualityProgramId, PublishedIndexInput } from "../types";
import type {
  CategoryDefinition,
  PublishedValidationContext,
  StandardAdapter,
  StandardCalculationResult,
  StandardSourceManifest,
} from "./adapter";

export const AQHI_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: "low-risk",
    labelKey: "airQuality.ca.category.lowRisk",
    minimum: 1,
    maximum: 3,
    color: "#00ccff",
  },
  {
    id: "moderate-risk",
    labelKey: "airQuality.ca.category.moderateRisk",
    minimum: 4,
    maximum: 6,
    color: "#ffcc00",
  },
  {
    id: "high-risk",
    labelKey: "airQuality.ca.category.highRisk",
    minimum: 7,
    maximum: 10,
    color: "#ff0000",
  },
  {
    id: "very-high-risk",
    labelKey: "airQuality.ca.category.veryHighRisk",
    minimum: 11,
    maximum: null,
    color: "#660000",
  },
];

const publishedSchema = z.object({
  indexId: z.string().min(1),
  methodId: z.enum(["eccc-aqhi", "eccc-aqhi-plus-pm25-hourly"]),
  methodRevision: z.string().min(1),
  claimedStandardId: z.literal("ca-aqhi-current"),
  value: z.number().int().min(1).max(10).nullable(),
  displayValue: z.string(),
  categoryId: z.enum(["low-risk", "moderate-risk", "high-risk", "very-high-risk"]),
  dominantPollutants: z.array(z.enum(["pm25", "pm10", "o3", "no2", "so2", "co", "nh3", "no"])),
  communityId: z.string().min(1),
  communityName: z.string().min(1),
  subdivisionCode: z.string().regex(/^CA-[A-Z]{2}$/),
  issuedAt: z.iso.datetime({ offset: true }),
  validFrom: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  kind: z.enum(["current", "forecast"]),
});

export type CanadianPublishedIndexInput = z.infer<typeof publishedSchema>;

export interface CanadianPublishedValidation {
  result: StandardCalculationResult;
  programId: AirQualityProgramId;
  headlineEligible: boolean;
}

function expectedCategory(value: number | null): string {
  if (value === null) return "very-high-risk";
  if (value <= 3) return "low-risk";
  if (value <= 6) return "moderate-risk";
  return "high-risk";
}

export function validateCanadianPublished(input: unknown): CanadianPublishedValidation {
  const parsed = publishedSchema.safeParse(input);
  if (!parsed.success) {
    return {
      result: {
        ok: false,
        reason: "invalid_schema",
        missingRequirements: parsed.error.issues.map(
          ({ path, message }) => `${path.join(".")}: ${message}`,
        ),
      },
      programId: "ca-aqhi",
      headlineEligible: false,
    };
  }
  const value = parsed.data;
  const timesValid =
    Date.parse(value.issuedAt) <= Date.parse(value.validFrom) &&
    Date.parse(value.validFrom) < Date.parse(value.validUntil);
  const displayValid =
    value.value === null
      ? value.displayValue === "10+"
      : value.displayValue === String(value.value);
  const methodPollutantsValid =
    value.methodId === "eccc-aqhi-plus-pm25-hourly"
      ? value.dominantPollutants.length === 1 && value.dominantPollutants[0] === "pm25"
      : true;
  if (!timesValid)
    return {
      result: {
        ok: false,
        reason: "invalid_time",
        missingRequirements: ["AQHI issue and validity interval are inconsistent"],
      },
      programId: "ca-aqhi",
      headlineEligible: false,
    };
  if (
    !displayValid ||
    expectedCategory(value.value) !== value.categoryId ||
    !methodPollutantsValid
  ) {
    return {
      result: {
        ok: false,
        reason: "unverified_method",
        missingRequirements: ["Published AQHI scale, category, or method evidence is inconsistent"],
      },
      programId: "ca-aqhi",
      headlineEligible: false,
    };
  }
  const quebec = value.subdivisionCode === "CA-QC";
  return {
    result: {
      ok: true,
      index: {
        indexId: value.indexId,
        standardId: "ca-aqhi-current",
        standardRevision: "eccc-aqhi-2026-08-29",
        methodId: value.methodId,
        methodRevision: value.methodRevision,
        effectiveDate: "2026-05-28",
        value: value.value,
        displayValue: value.displayValue,
        categoryId: value.categoryId,
        dominantPollutants: value.dominantPollutants,
        authority: "official-agency",
        qualityStatus: "quality-assured",
        basis: "ground",
        derivation: "published-index",
        inputObservationIds: [],
      },
    },
    programId: quebec ? "ca-qc-info-smog" : "ca-aqhi",
    headlineEligible: !quebec,
  };
}

function validatePublished(
  input: PublishedIndexInput,
  context: PublishedValidationContext,
): StandardCalculationResult {
  return validateCanadianPublished({
    ...input,
    communityId: context.spatial.kind === "community" ? context.spatial.id : "",
    communityName: context.spatial.kind === "community" ? context.spatial.name : "",
    subdivisionCode: context.subdivisionCode,
    issuedAt: context.publishedAt,
    validFrom: context.forecastFor ?? context.observedAt,
    validUntil: context.validUntil,
    kind: context.forecastFor === null ? "current" : "forecast",
  }).result;
}

export const caAqhiCurrentAdapter: StandardAdapter = {
  standardId: "ca-aqhi-current",
  methodId: "eccc-aqhi",
  revision: "eccc-aqhi-2026-08-29",
  effectiveFrom: "2026-05-28T00:00:00Z",
  effectiveUntil: null,
  supportedModes: new Set(["current", "forecast"]),
  categories: AQHI_CATEGORIES,
  sourceManifest: manifestData as StandardSourceManifest,
  validatePublished,
  summarizeCompleteness: () => ({
    passes: false,
    missingRequirements: [
      "ECCC community-published AQHI required; local calculation is unsupported",
    ],
    qualifyingPollutants: [],
  }),
};
