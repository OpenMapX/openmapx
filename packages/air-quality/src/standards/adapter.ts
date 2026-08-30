import { z } from "zod";

import type {
  AirQualityIndex,
  AirQualityRejectionReason,
  AirQualitySpatialSupport,
  AirQualityStandardId,
  Pollutant,
  PollutantSeries,
  PublishedIndexInput,
} from "../types";

export const categoryDefinitionSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  minimum: z.number().finite(),
  maximum: z.number().finite().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  rasterValue: z.number().int().positive().optional(),
});

export type CategoryDefinition = z.infer<typeof categoryDefinitionSchema>;

export const standardSourceManifestSchema = z.object({
  standardId: z.string().min(1),
  resolvedRevision: z.string().min(1),
  retrievedAt: z.iso.date(),
  effectiveFrom: z.iso.datetime({ offset: true }),
  effectiveUntil: z.iso.datetime({ offset: true }).nullable(),
  sources: z
    .array(
      z.object({
        url: z.url(),
        title: z.string().min(1),
        anchors: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  transcriptionChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  independentDerivation: z.object({
    reviewer: z.string().min(1),
    reviewedAt: z.iso.date(),
    note: z.string().min(1),
  }),
});

export type StandardSourceManifest = z.infer<typeof standardSourceManifestSchema>;

export type StandardMode = "current" | "history" | "forecast";

export interface StandardCalculationInput {
  observationId: string;
  outputIndexId: string;
  evaluatedAt: string;
  mode: StandardMode;
  series: PollutantSeries[];
  stationType?: "traffic" | "background" | "industrial" | "unknown";
}

export interface StandardCalculationSuccess {
  ok: true;
  index: AirQualityIndex;
}

export interface StandardCalculationFailure {
  ok: false;
  reason: AirQualityRejectionReason;
  missingRequirements: string[];
}

export type StandardCalculationResult = StandardCalculationSuccess | StandardCalculationFailure;

export interface CompletenessSummary {
  passes: boolean;
  missingRequirements: string[];
  qualifyingPollutants: Pollutant[];
}

export interface PublishedValidationContext {
  spatial: AirQualitySpatialSupport;
  observedAt: string | null;
  forecastFor: string | null;
  publishedAt: string | null;
  validUntil: string | null;
  subdivisionCode: string | null;
}

export interface StandardAdapter {
  readonly standardId: AirQualityStandardId;
  readonly methodId: string;
  readonly revision: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly supportedModes: ReadonlySet<StandardMode>;
  readonly categories: readonly CategoryDefinition[];
  readonly sourceManifest: StandardSourceManifest;
  validatePublished?(
    input: PublishedIndexInput,
    context: PublishedValidationContext,
  ): StandardCalculationResult;
  calculate?(input: StandardCalculationInput): StandardCalculationResult;
  summarizeCompleteness(input: StandardCalculationInput): CompletenessSummary;
}
