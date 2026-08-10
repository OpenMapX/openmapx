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
  DataManagerClient,
  type DataManagerClientOptions,
} from "./data-manager-client";
export {
  type ExtensionComponentRef,
  type ExtensionIntegrationComponent,
  type ExtensionManifest,
  type ExtensionServiceComponent,
  extensionComponentSummary,
  extensionManifestSchema,
  validateExtensionManifest,
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
export * from "./types";
