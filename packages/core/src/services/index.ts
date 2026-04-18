export {
  type ComposeServiceSnippet,
  type RenderContext,
  renderCompose,
  renderServiceSnippet,
} from "./compose-renderer";
export {
  type ManifestValidationResult,
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
export * from "./types";
