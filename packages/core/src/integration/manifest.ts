import z from "zod/v4";

const attributionSchema = z.object({
  name: z.string(),
  url: z.string(),
  license: z.string(),
  licenseUrl: z.string().optional(),
  dynamic: z.boolean().optional(),
  dynamicEndpoint: z.string().optional(),
});

const privacyEntrySchema = z.object({
  service: z.string().optional(),
  purpose: z.string().optional(),
  dataSent: z.string().optional(),
  dataReceived: z.string().optional(),
  providerCountry: z.string(),
  providerPrivacyUrl: z.string(),
  dataRetention: z.string().optional(),
  personalData: z.boolean().optional(),
  cookies: z.boolean().optional(),
});

const healthCheckSchema = z.object({
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
  envVars: z.array(z.string()).optional(),

  healthCheck: healthCheckSchema.optional(),
  quality: z.enum(["built-in", "community-verified", "community"]).optional(),

  attribution: z.array(attributionSchema).optional(),
  privacy: z.union([privacyEntrySchema, z.array(privacyEntrySchema)]).optional(),

  infrastructure: infrastructureSchema.optional(),
});

export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
export type IntegrationAttribution = z.infer<typeof attributionSchema>;
export type IntegrationPrivacy = z.infer<typeof privacyEntrySchema>;
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
    if (manifest.backend?.routes && !manifest.attribution?.length) {
      errors.push("manifest.attribution is required for integrations with backend routes");
    }
    if (manifest.backend?.routes && !manifest.privacy) {
      errors.push("manifest.privacy is required for integrations that call external APIs");
    }
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
    for (const attr of manifest.attribution ?? []) {
      if (!attr.name) errors.push("attribution.name is required");
      if (!attr.url) errors.push("attribution.url is required");
      if (!attr.license) errors.push("attribution.license is required");
    }

    return { valid: errors.length === 0, errors };
  }

  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
