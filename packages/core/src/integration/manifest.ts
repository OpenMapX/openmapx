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
  endUserExposure: z.enum(["direct", "proxied", "server-only", "build-time"]).optional(),
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
  urlTemplate: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  requiredEnvVars: z.array(z.string()).optional(),
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
  dockerProfile: z.string().optional(),
  services: z.array(z.string()).optional(),
  dataRequirements: z.array(z.string()).optional(),
  planetScale: z.boolean().optional(),
});

/**
 * Per-env-var metadata. When a bare string is used in `envVars`, the variable is
 * treated as required (historical default).
 */
const envVarEntrySchema = z.object({
  name: z.string(),
  /** Whether the variable must be set for the integration to function. Defaults to true. */
  required: z.boolean().optional(),
  /** Human-readable purpose shown in the admin UI. */
  description: z.string().optional(),
});

const envVarSchema = z.union([z.string(), envVarEntrySchema]);

export const integrationManifestSchema = z.object({
  id: z.string(),
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

  frontend: frontendSchema.optional(),
  backend: backendSchema.optional(),

  configSchema: z.record(z.string(), z.unknown()).optional(),
  envVars: z.array(envVarSchema).optional(),

  healthCheck: z.union([healthCheckSchema, z.array(healthCheckSchema)]).optional(),
  quality: z.enum(["built-in", "community-verified", "community"]).optional(),

  dataSources: z.array(dataSourceSchema).optional(),

  infrastructure: infrastructureSchema.optional(),
});

export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export type IntegrationDataSource = z.infer<typeof dataSourceSchema>;
export type IntegrationHealthCheck = z.infer<typeof healthCheckSchema>;
export type IntegrationFrontend = z.infer<typeof frontendSchema>;
export type IntegrationLayerSelector = z.infer<typeof layerSelectorSchema>;
export type IntegrationOverlay = z.infer<typeof overlaySchema>;
export type IntegrationSearchCategory = z.infer<typeof searchCategorySchema>;
export type IntegrationEnvVar = z.infer<typeof envVarSchema>;

export interface NormalizedEnvVar {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * Normalize `manifest.envVars` to the object form. Bare strings are treated as
 * required variables (historical behavior).
 */
export function normalizeEnvVars(envVars: IntegrationManifest["envVars"]): NormalizedEnvVar[] {
  if (!envVars) return [];
  return envVars.map((v) =>
    typeof v === "string"
      ? { name: v, required: true }
      : { name: v.name, required: v.required ?? true, description: v.description },
  );
}

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
    // Health check policy: required for integrations with envVars (external APIs)
    // or backend services (databases, etc.)
    if (manifest.envVars?.length && !manifest.healthCheck) {
      errors.push(
        "manifest.healthCheck is required for integrations with external API dependencies (envVars)",
      );
    }
    if (manifest.infrastructure?.services?.length && !manifest.healthCheck) {
      errors.push(
        "manifest.healthCheck is required for integrations with infrastructure dependencies (services)",
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
