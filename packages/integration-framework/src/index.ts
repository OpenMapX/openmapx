export type { CommunityIntegrationModule } from "./community";
export {
  getCommunityModule,
  getCommunityModuleIds,
  initCommunityIntegrationRegistry,
  registerCommunityModule,
} from "./community";
export type {
  AttributionIndexHandle,
  CacheClient,
  CustomHealthCheckFn,
  DatabaseClient,
  HealthCheckResult,
  HttpClient,
  HttpClientOptions,
  IntegrationContext,
  Logger,
  RouteHandler,
  RouteOptions,
  SecretsClient,
} from "./context";
export type {
  DataSourceAttribution,
  DataSourceBranding,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceFilterDef,
  DataSourceGeoJsonFeature,
  DataSourceGeoJsonFeatureCollection,
  DataSourceGeoJsonGeometry,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMarkerStyle,
  DataSourceMeta,
  DataSourceResult,
  MobilityDataSourceProvider,
  PricingPlanEntry,
  ProviderAttribution,
  RealtimeCapabilities,
  RealtimeProvider,
  TimetableEntry,
  TransitCapabilities,
  TransitProvider,
  TripPlanRequest,
  TripUpdate,
  VehicleJourney,
} from "./contracts/index.js";
export type { IntegrationEvent } from "./events";
export { IntegrationEventBus } from "./events";
// Installer exports (`buildIntegration` / `installIntegration` / `listIntegrations`
// / `removeIntegration` / `validateIntegrationDirectory` and their option/result
// types) intentionally do NOT live in this barrel. `installer.ts` imports
// node:fs/crypto/os/path, and any barrel that re-exports it taints everyone
// who imports the barrel — including the client-reachable `@openmapx/core`
// main entry. Consumers import them from `@openmapx/core/server` instead.
export type { IntegrationStrings, LoadedIntegration, LoadedIntegrationMeta } from "./loader";
export { toIntegrationMeta } from "./loader";
export type {
  IntegrationDataSource,
  IntegrationFrontend,
  IntegrationHealthCheck,
  IntegrationLayerSelector,
  IntegrationManifest,
  IntegrationOverlay,
  IntegrationSearchCategory,
  ManifestValidationResult,
} from "./manifest";
export {
  INTEGRATION_ID_REGEX,
  integrationManifestSchema,
  validateManifest,
} from "./manifest";
export { PLATFORM_VERSION, satisfiesPlatformVersion } from "./platform";
export { IntegrationRegistry } from "./registry";
// `useIntegrationRegistry` and `IntegrationRegistryContext` live in the
// `/react` subpath — pulling them into this barrel would force every
// consumer (CLI, API, server-side code) to ship `react` even when they
// only need server-safe symbols like `PLATFORM_VERSION` or `validateManifest`.
export {
  createFallbackChain,
  createFirstWins,
  createMergeAll,
  type FallbackChainOptions,
  type MergeAllOptions,
} from "./strategies";
