export {
  type CapabilityCheck,
  type CapabilityKind,
  type CapabilityWarning,
  checkCapabilityName,
  collectCapabilityWarnings,
  NAMESPACED_NAME_REGEX,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_DATA_TYPES,
} from "./capabilities";
export {
  type ComposeServiceSnippet,
  GENERATED_SECRETS_DIRNAME,
  mergeServiceSecretKeys,
  type RenderContext,
  readServiceSecretKeysFromCompose,
  readServiceSecretKeysFromDisk,
  renderCompose,
  renderServiceSnippet,
  resolveProxyHost,
} from "./compose-renderer";
export {
  type ConfigSource,
  type ConfigValueWithSource,
  configSchemaKeys,
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
  serviceConfigEnvPrefix,
} from "./config-resolver";
export {
  DATA_MANAGER_PLAINTEXT_HOSTS_ENV,
  DataManagerClient,
  type DataManagerClientOptions,
  DataManagerHttpError,
  type SearchIndexBuildResult,
  type SearchIndexStatus,
  validateDataManagerBaseUrl,
} from "./data-manager-client";
export {
  type ExtensionComponentRef,
  type ExtensionIntegrationComponent,
  type ExtensionManifest,
  type ExtensionServiceComponent,
  extensionComponentSummary,
  extensionManifestSchema,
  type VerifiedCatalogEntry,
  validateExtensionManifest,
  verifiedCatalogEntrySchema,
} from "./extension-schema";
export { findServiceManifestDirs } from "./manifest-discovery";
export {
  isSafePostgresIdentifier,
  type ManifestValidationResult,
  POSTGRES_IDENTIFIER_REGEX,
  serviceManifestSchema,
  validateServiceManifest,
} from "./manifest-schema";
export { ServiceRegistry, type ServiceRegistryOptions } from "./registry";
export {
  captureReleaseServiceAuthority,
  RELEASE_BUILT_IN_SERVICE_IDS,
  RELEASE_NEVER_MANAGE_SERVICE_IDS,
  type ReleaseServiceAuthorityCapture,
  type ReleaseServiceAuthorityCaptureHooks,
  validateReleaseServiceAuthority,
} from "./release-authority-inventory";
export {
  DEFAULT_RELEASE_MANIFEST_IMAGE,
  parseReleaseManifest,
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_MANIFEST_IMAGE_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  type ReleaseChannel,
  ReleaseChannelDisabledError,
  type ReleaseManifest,
  releaseChannel,
  releaseManifestImage,
  renderReleaseCompose,
  TRANSITOUS_TOOLS_IMAGE_ENV,
  transitousToolsImageFromReleaseCompose,
} from "./release-manifest";
export {
  detectConsumesCycle,
  findByCapability,
  type ResolverContext,
  resolveRequirement,
} from "./resolver";
export {
  assertRenderSandbox,
  COMMUNITY_SAFE_CAPS,
  checkManifestSandbox,
  isComposeVarReference,
} from "./sandbox-policy";
export { assertValidSecretKey, isValidSecretKey, SECRET_KEY_RE } from "./secret-key";
export { computeServiceSecurityRating, type ServiceSecurityRating } from "./security-rating";
export {
  buildAppApiServiceEnv,
  DEFAULT_SELECTED_SERVICE_IDS,
  type ExpandedServiceSelection,
  type ExpandServiceSelectionOptions,
  expandServiceSelection,
  formatServiceIdList,
  normalizeServiceIds,
  parseServiceIdList,
  SERVICE_SELECTION_ENV,
} from "./selection";
export {
  renderTraefikDynamicConfiguration,
  renderTraefikDynamicYaml,
  renderTraefikServiceConfiguration,
  type TraefikDynamicConfiguration,
  type TraefikRenderContext,
} from "./traefik-renderer";
export * from "./types";
