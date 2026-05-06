import z from "zod/v4";

const dataSourceSchema = z.object({
  // Source matching — connects this entry to provider source values
  sourceId: z.string(),

  // Identity
  name: z.string(),
  url: z.string(),

  // License & Attribution
  license: z.string(),
  licenseUrl: z.string().optional(),
  attribution: z.string().optional(),
  commercialUse: z.enum(["yes", "no", "conditional", "unknown"]).optional(),

  // Privacy
  providerCountry: z.string(),
  providerPrivacyUrl: z.string(),
  endUserExposure: z.enum(["direct", "mixed", "proxied", "server-only", "build-time"]).optional(),
  personalData: z.boolean().optional(),
  cookies: z.boolean().optional(),
  dpaAvailable: z.boolean().optional(),
  dpaUrl: z.string().optional(),

  // Dynamic attribution (fetched from endpoint at runtime)
  dynamic: z.boolean().optional(),
  dynamicEndpoint: z.string().optional(),
});

const healthCheckSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["http", "ping", "tcp", "custom"]),
  url: z.string().optional(),
  /**
   * Template with `${configKey}` placeholders resolved from the integration's
   * configSchema cascade (defaults → database → vault → env). Use this when
   * the probe needs an API key or similar; the placeholder name must match a
   * key declared in `configSchema.properties`.
   */
  urlTemplate: z.string().optional(),
  /** Same substitution rules as `urlTemplate`. */
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * configSchema keys that must resolve to a non-empty value for the probe
   * to run. When any is missing, the health check reports "unconfigured"
   * instead of attempting the request.
   */
  requiredConfigKeys: z.array(z.string()).optional(),
  category: z.string().optional(),
});

const layerSelectorSchema = z.object({
  group: z.enum(["map-details", "map-tools", "map-types"]),
  labelKey: z.string(),
  icon: z.string().optional(),
  preview: z.string().nullable().optional(),
  quickSelector: z.boolean().optional(),
});

const overlaySchema = z.object({
  excludes: z.array(z.string()).optional(),
  minZoom: z.number().optional(),
});

const searchCategorySchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  showInChipBar: z.boolean().optional(),
  iconPath: z.string().optional(),
});

const frontendSchema = z.object({
  mapLayer: z.boolean().optional(),
  legend: z.boolean().optional(),
  panel: z.boolean().optional(),
  searchCategory: searchCategorySchema.optional(),
  layerSelector: layerSelectorSchema.optional(),
  overlay: overlaySchema.optional(),
});

const backendSchema = z.object({
  routes: z.boolean().optional(),
  cron: z.string().nullable().optional(),
});

const infrastructureSchema = z.object({
  dataRequirements: z.array(z.string()).optional(),
  planetScale: z.boolean().optional(),
});

const requireEntrySchema = z
  .object({
    service: z.string().optional(),
    capability: z.string().optional(),
    optional: z.boolean().optional(),
  })
  .refine((v) => !!v.service !== !!v.capability, {
    message: "each requires entry must set exactly one of 'service' or 'capability'",
  });

/**
 * Slug regex shared with the service manifest schema. The id is used as a
 * filesystem directory name (`integrations/<id>/`, `custom_integrations/<id>/`)
 * and as a string literal in generated code (the community bundle entry stub
 * embeds it as `id: "<value>"`), so we constrain it to safe characters and
 * reject anything that could escape the install tree or break out of a quoted
 * literal.
 */
export const INTEGRATION_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export const integrationManifestSchema = z.object({
  id: z.string().regex(INTEGRATION_ID_REGEX, "must be lowercase, hyphen-separated"),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  documentation: z.string().optional(),
  platform: z.string().optional(),

  domains: z.array(z.string()),

  dependencies: z.array(z.string()).optional(),
  npmDependencies: z.record(z.string(), z.string()).optional(),
  requires: z.array(requireEntrySchema).optional(),

  frontend: frontendSchema.optional(),
  backend: backendSchema.optional(),

  configSchema: z.record(z.string(), z.unknown()).optional(),

  healthCheck: z.union([healthCheckSchema, z.array(healthCheckSchema)]).optional(),
  quality: z.enum(["built-in", "community-verified", "community"]).optional(),

  dataSources: z.array(dataSourceSchema).optional(),

  infrastructure: infrastructureSchema.optional(),
});

export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export type IntegrationRequireEntry = z.infer<typeof requireEntrySchema>;
export type IntegrationDataSource = z.infer<typeof dataSourceSchema>;
export type IntegrationHealthCheck = z.infer<typeof healthCheckSchema>;
export type IntegrationFrontend = z.infer<typeof frontendSchema>;
export type IntegrationLayerSelector = z.infer<typeof layerSelectorSchema>;
export type IntegrationOverlay = z.infer<typeof overlaySchema>;
export type IntegrationSearchCategory = z.infer<typeof searchCategorySchema>;

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateManifest(raw: unknown): ManifestValidationResult {
  const result = integrationManifestSchema.safeParse(raw);
  if (result.success) {
    const manifest = result.data;
    const errors: string[] = [];

    if (!manifest.id) {
      errors.push("manifest.id is required");
    }
    if (!manifest.domains?.length) {
      errors.push("manifest.domains must contain at least one domain");
    }
    // dataSources is encouraged for integrations with backend routes but not enforced —
    // orchestrator integrations aggregate providers that declare their own data sources.
    // Only enforce healthCheck for required (non-optional) service dependencies.
    // Optional capability requirements (e.g. on orchestrator integrations) don't mandate a healthCheck.
    const hasRequiredServiceDep = manifest.requires?.some((r) => r.optional !== true && r.service);
    if (hasRequiredServiceDep && !manifest.healthCheck) {
      errors.push(
        "manifest.healthCheck is required for integrations with infrastructure dependencies (requires)",
      );
    }
    for (const ds of manifest.dataSources ?? []) {
      if (!ds.sourceId) errors.push("dataSources[].sourceId is required");
      if (!ds.name) errors.push("dataSources[].name is required");
      if (!ds.url) errors.push("dataSources[].url is required");
      if (!ds.license) errors.push("dataSources[].license is required");
      if (!ds.providerCountry) errors.push("dataSources[].providerCountry is required");
      if (!ds.providerPrivacyUrl) errors.push("dataSources[].providerPrivacyUrl is required");
    }

    return { valid: errors.length === 0, errors };
  }

  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
