import type { Attribution } from "@openmapx/mobility-core/attribution";
import z from "zod/v4";

const publisherSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
});

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
  /** Upstream publisher (e.g. "Entur AS", "Deutsche Bahn AG"). */
  publisher: publisherSchema.optional(),
  /** Free-form per-source notes (e.g. "via Transitous feed proxy"). */
  notes: z.string().optional(),
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

/**
 * Convert an integration-manifest data source descriptor into the canonical
 * `Attribution` shape used by `MobilityResult.attributions` and the map
 * attribution control. Providers should call this on the manifest entries
 * passed through their `setup(ctx)` rather than hand-rolling their own
 * Attribution objects, so all credit metadata lives in one place — the
 * manifest.
 */
export function dataSourceToAttribution(ds: IntegrationDataSource): Attribution {
  return {
    sourceId: ds.sourceId,
    name: ds.name,
    url: ds.url,
    spdxLicense: ds.license || undefined,
    licenseUrl: ds.licenseUrl,
    attributionText: ds.attribution,
    publisher: ds.publisher,
    notes: ds.notes,
  };
}

/**
 * Manifest-driven attribution store. Integrations populate it once at
 * `setup(ctx)` from `ctx.manifest.dataSources` and read from it for both
 * provider-level `attribution` and per-response credits. Removes the need
 * for hand-rolled `const ATTRIBUTION: Attribution[] = [...]` literals that
 * duplicated manifest metadata in code.
 *
 * Typical wiring:
 *
 * ```ts
 * const attribution = createManifestAttribution();
 *
 * export function setup(ctx: IntegrationContext) {
 *   attribution.set(ctx.manifest.dataSources ?? []);
 *   ctx.registerMobilityDataSource(provider);
 * }
 *
 * class Provider {
 *   get attribution() { return attribution.all(); }
 *   async search(...) {
 *     return withAttribution(results, attribution.forResults(results), ...);
 *   }
 * }
 * ```
 */
export interface ManifestAttributionStore {
  /** Populate the store from a manifest's `dataSources` list. */
  set(dataSources: IntegrationDataSource[]): void;
  /** All non-dynamic attributions, in manifest order. */
  all(): Attribution[];
  /** Look up a single attribution by `sourceId`. */
  bySource(sourceId: string): Attribution | undefined;
  /**
   * Build the attribution list for a response, crediting only the sources
   * that actually contributed. By default reads `result.source`; pass a
   * `sourcesFor` extractor to return multiple sources per result (e.g.
   * deduped records that merged data from several providers, where
   * `result.sources: string[]` is the authoritative list).
   */
  forResults<T>(
    results: T[],
    sourcesFor?: (result: T) => string | string[] | undefined,
  ): Attribution[];
}

export function createManifestAttribution(): ManifestAttributionStore {
  let map: Record<string, Attribution> = {};
  let all: Attribution[] = [];

  return {
    set(dataSources) {
      const nextMap: Record<string, Attribution> = {};
      const nextAll: Attribution[] = [];
      for (const ds of dataSources) {
        if (ds.dynamic) continue;
        const attr = dataSourceToAttribution(ds);
        nextMap[attr.sourceId] = attr;
        nextAll.push(attr);
      }
      map = nextMap;
      all = nextAll;
    },
    all() {
      return all;
    },
    bySource(sourceId) {
      return map[sourceId];
    },
    forResults(results, sourcesFor) {
      const seen = new Set<string>();
      const out: Attribution[] = [];
      for (const r of results) {
        const raw = sourcesFor ? sourcesFor(r) : (r as { source?: string }).source;
        const keys = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const key of keys) {
          if (seen.has(key)) continue;
          seen.add(key);
          const attr = map[key];
          if (attr) out.push(attr);
        }
      }
      return out;
    },
  };
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
