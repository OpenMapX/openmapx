export { AirQualityDomainError } from "./errors";
export {
  type ForecastFrame,
  type ForecastGrouping,
  type ForecastSeries,
  groupForecastEvidence,
} from "./forecast";
export {
  type CoherenceIdentity,
  type CoherenceValidation,
  deriveCoherenceKey,
  validateCoherentSeries,
} from "./normalize/coherence";
export {
  type DeduplicatedRecord,
  type DeduplicationRecord,
  type DeduplicationResult,
  deduplicateRecords,
} from "./normalize/deduplicate";
export { normalizeSamples } from "./normalize/samples";
export {
  convertConcentration,
  type InvalidSampleReason,
  type NormalizedPollutantSample,
  normalizeSample,
} from "./normalize/units";
export {
  buildWindow,
  localDayWindow,
  type NormalizedWindow,
  type WindowRequirement,
} from "./normalize/windows";
export {
  type AirQualitySelectionInput,
  type AirQualitySelectionRejection,
  type AirQualitySelectionResult,
  selectAirQuality,
} from "./selection";
export {
  type CategoryDefinition,
  type CompletenessSummary,
  categoryDefinitionSchema,
  type PublishedValidationContext,
  type StandardAdapter,
  type StandardCalculationFailure,
  type StandardCalculationInput,
  type StandardCalculationResult,
  type StandardCalculationSuccess,
  type StandardMode,
  type StandardSourceManifest,
  standardSourceManifestSchema,
} from "./standards/adapter";
export { type BreakpointBand, interpolateBreakpoint, truncateTo } from "./standards/breakpoint";
export { registerBuiltinStandardAdapters } from "./standards/builtins";
export {
  AQHI_CATEGORIES,
  type CanadianPublishedIndexInput,
  type CanadianPublishedValidation,
  caAqhiCurrentAdapter,
  validateCanadianPublished,
} from "./standards/ca-aqhi-current";
export {
  calculateHjSubIndex,
  cnHj6332026Adapter,
  HJ633_CATEGORIES,
  type HjMode,
  type HjPollutant,
} from "./standards/cn-hj633-2026";
export {
  calculateEeaIndex,
  classifyEeaPollutant,
  EEA_CATEGORIES,
  type EeaIndexResult,
  type EeaPollutant,
  type EeaPollutantInput,
  type EeaStationType,
  euEeaCurrentAdapter,
} from "./standards/eu-eea-current";
export {
  calculateNaqiSubIndex,
  inNaqiCurrentAdapter,
  NAQI_CATEGORIES,
  type NaqiPollutant,
} from "./standards/in-naqi-current";
export {
  listStandardAdapters,
  registerStandardAdapter,
  resolveStandard,
  type StandardResolution,
  type StandardResolutionFailure,
} from "./standards/registry";
export {
  calculateDaqiLevel,
  DAQI_CATEGORIES,
  type DaqiPollutant,
  ukDaqiCurrentAdapter,
} from "./standards/uk-daqi-current";
export {
  calculateEpaSubIndex,
  calculatePmNowCast,
  EPA_BREAKPOINTS,
  usEpa2024Adapter,
} from "./standards/us-epa-2024";
export type * from "./types";
