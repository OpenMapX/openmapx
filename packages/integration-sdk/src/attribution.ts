export { buildAttributionPresentation } from "@openmapx/core/attribution";
export { dataSourceToAttribution } from "@openmapx/extension-contracts/contributors";
export {
  asModifiedContributors,
  captureIntegrationContributorCatalogue,
  resolveCapturedContributors,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework/contributors";
export type { ManifestAttributionStore } from "@openmapx/integration-framework/manifest";
export { createManifestAttribution } from "@openmapx/integration-framework/manifest";
export { siteAttributions } from "@openmapx/integration-framework/site-orchestrator";
export type { Attribution } from "@openmapx/mobility-core/attribution";
export { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
export type { ContributingRecord, FieldContributors } from "@openmapx/mobility-core/contributors";
export {
  captureResultContributors,
  contributorsForField,
  contributorsForFields,
  contributorsForRecords,
  parseContributors,
  readCapturedContributors,
  readCapturedFieldContributors,
  serializeContributors,
  snapshotContributors,
  withContributors,
} from "@openmapx/mobility-core/contributors";
export type { Freshness } from "@openmapx/mobility-core/freshness";
export { freshnessNow, oldestDataAsOf, upstreamDataAsOf } from "@openmapx/mobility-core/freshness";
export type { LicenseDescriptor, Licensing } from "@openmapx/mobility-core/licensing";
export {
  canonicalLicenseExpression,
  formatLicensing,
  isSafeAttributionUrl,
  licensingFromDeclaration,
  licensingLinks,
  parseLicensing,
} from "@openmapx/mobility-core/licensing";
export type { MobilityEnvelope, MobilityResult } from "@openmapx/mobility-core/result";
export { withAttribution } from "@openmapx/mobility-core/result";
