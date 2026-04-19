export type { CommunityIntegrationModule } from "./community";
export {
  getCommunityModule,
  getCommunityModuleIds,
  initCommunityIntegrationRegistry,
  registerCommunityModule,
} from "./community";
export type {
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
export type { IntegrationEvent } from "./events";
export { IntegrationEventBus } from "./events";
export type {
  BuildOptions as IntegrationBuildOptions,
  BuildResult as IntegrationBuildResult,
  InstallOptions as IntegrationInstallOptions,
  InstallResult as IntegrationInstallResult,
  IntegrationSummary,
  ListOptions as IntegrationListOptions,
  RemoveOptions as IntegrationRemoveOptions,
  ValidateResult as IntegrationValidateResult,
} from "./installer";
export {
  buildIntegration,
  installIntegration,
  listIntegrations,
  removeIntegration,
  validateIntegrationDirectory,
} from "./installer";
export type { IntegrationStrings, LoadedIntegration, LoadedIntegrationMeta } from "./loader";
export { toIntegrationMeta } from "./loader";
export type {
  IntegrationDataSource,
  IntegrationEnvVar,
  IntegrationFrontend,
  IntegrationHealthCheck,
  IntegrationLayerSelector,
  IntegrationManifest,
  IntegrationOverlay,
  IntegrationSearchCategory,
  ManifestValidationResult,
  NormalizedEnvVar,
} from "./manifest";
export {
  INTEGRATION_ID_REGEX,
  integrationManifestSchema,
  normalizeEnvVars,
  validateManifest,
} from "./manifest";
export { PLATFORM_VERSION, satisfiesPlatformVersion } from "./platform";
export { IntegrationRegistry } from "./registry";
export {
  createFallbackChain,
  createFirstWins,
  createMergeAll,
  type FallbackChainOptions,
  type MergeAllOptions,
} from "./strategies";
