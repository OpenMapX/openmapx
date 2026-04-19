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
export {
  createFallbackChain,
  createFirstWins,
  createMergeAll,
  type FallbackChainOptions,
  type MergeAllOptions,
} from "./strategies";
