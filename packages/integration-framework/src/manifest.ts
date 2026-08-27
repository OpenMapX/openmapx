import { feedIdSchema } from "@openmapx/core/feed-id";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import z from "zod/v4";

export const dataSourceSchema = z.object({
  // Source matching — connects this entry to provider source values
  sourceId: feedIdSchema,

  // Identity
  name: z.string(),
  url: z.string(),
  /**
   * Actual data-API host(s) this source's requests go to, when they differ from
   * the registrable domain of `url` (which is usually the human-facing dataset /
   * open-data portal page). Lets the `check-data-flows` guard recognise a
   * legitimate, same-controller data host — e.g. a source whose `url` is
   * `https://data.public.lu/...` but whose feed is fetched from `www.cita.lu`.
   * Hosts (or registrable domains) only; no scheme/path.
   */
  apiHosts: z.array(z.string()).optional(),

  // License & Attribution
  license: z.string(),
  licenseUrl: z.string().optional(),
  attribution: z.string().optional(),
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
});

/**
 * Operator-facing "how to obtain this credential" guidance attached to a
 * `configSchema` property under the `x-openmapx-setup` key. The admin panel
 * renders it next to the credential/API-key input so an operator can sign up,
 * follow the steps, and paste the value without leaving the page.
 *
 * Attach it to any credential-bearing property — a vault secret
 * (`x-openmapx-secret: true`) or a plain key field (`format: "password"`):
 *
 * ```json
 * "apiKey": {
 *   "type": "string",
 *   "title": "Provider API key",
 *   "x-openmapx-secret": true,
 *   "x-openmapx-setup": {
 *     "url": "https://provider.example/account/keys",
 *     "steps": ["Create a free account.", "Open Account → API keys.", "Copy the key."],
 *     "cost": "Free tier: 100k requests/month",
 *     "notes": "Activation can take a few minutes.",
 *     "email": {
 *       "to": "api@provider.example",
 *       "subject": "API access request",
 *       "body": "Hello,\n\nI'd like to request an API key for ..."
 *     }
 *   }
 * }
 * ```
 */
export const credentialSetupSchema = z.object({
  /** Where to sign up / request access / open the API-key dashboard. */
  url: z.string().optional(),
  /** Label for the primary action button (defaults to "Get API key"). */
  urlLabel: z.string().optional(),
  /** Ordered, human-readable steps to obtain the credential. */
  steps: z.array(z.string()).optional(),
  /** Free-tier / pricing summary, e.g. "Free up to 100k requests/month". */
  cost: z.string().optional(),
  /** Caveats worth flagging up front (approval delay, regional limits…). */
  notes: z.string().optional(),
  /**
   * Pre-written request email for providers that grant access manually.
   * Rendered as a `mailto:` link with the subject/body pre-filled.
   */
  email: z
    .object({
      to: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
    })
    .optional(),
});

export type CredentialSetup = z.infer<typeof credentialSetupSchema>;

/**
 * Read the `x-openmapx-setup` guidance off a single `configSchema` property
 * definition, validating its shape. Returns `undefined` when absent or
 * malformed so callers can render defensively. Keeps the magic key name in one
 * place for both the API (credential-status builder) and the admin UI.
 */
export function readCredentialSetup(propertyDef: unknown): CredentialSetup | undefined {
  if (!propertyDef || typeof propertyDef !== "object") return undefined;
  const raw = (propertyDef as Record<string, unknown>)["x-openmapx-setup"];
  if (!raw) return undefined;
  const parsed = credentialSetupSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

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
  /**
   * Run this probe through a browser-fingerprint HTTP client (impit) instead of
   * Node's `fetch`. Set when the upstream sits behind Cloudflare bot mitigation
   * that 403-challenges Node's undici TLS fingerprint (`cf-mitigated: challenge`)
   * while letting browsers through — e.g. OpenChargeMap. The data-fetching
   * provider must impersonate too for the integration to actually work.
   */
  impersonate: z.boolean().optional(),
  category: z.string().optional(),
});

export const layerSelectorPreviewPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((path) => !path.includes("\\"), "Preview path must use forward slashes")
  .refine((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path), "Preview path must not be a URL")
  .refine((path) => !path.startsWith("/"), "Preview path must be relative")
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Preview path contains an invalid segment",
  )
  .refine((path) => path.toLowerCase().endsWith(".svg"), "Preview path must reference an SVG");

const layerSelectorSchema = z.object({
  group: z.enum(["map-details", "map-tools", "map-types"]),
  labelKey: z.string(),
  icon: z.string().optional(),
  preview: layerSelectorPreviewPathSchema.nullable().optional(),
  quickSelector: z.boolean().optional(),
});

const overlayLegendItemSchema = z.object({
  color: z.string(),
  label: z.string().optional(),
  labelKey: z.string().optional(),
});

const overlayLegendSchema = z.object({
  kind: z.enum(["categorical", "ramp"]),
  title: z.string().optional(),
  titleKey: z.string().optional(),
  /** categorical: discrete swatches. */
  items: z.array(overlayLegendItemSchema).optional(),
  /** ramp: a value→color gradient. */
  stops: z.array(z.object({ value: z.number(), color: z.string() })).optional(),
});

/**
 * Lightweight, non-visual overlay config the host reads for any map overlay
 * (declarative legend, mutual-exclusion peers, zoom gating). Markers and popups
 * are rendered by the integration's own `map-layer.tsx` code, not the manifest.
 */
const overlaySchema = z.object({
  excludes: z.array(z.string()).optional(),
  minZoom: z.number().optional(),
  legend: overlayLegendSchema.optional(),
});

const searchCategorySchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  showInChipBar: z.boolean().optional(),
  iconPath: z.string().optional(),
});

const frontendSchema = z.object({
  mapLayer: z.boolean().optional(),
  /**
   * Groups integrations that render ONE shared map-layer component. Several
   * providers can back a single overlay (street-level imagery is served by
   * Panoramax, Mapillary and others through one coverage layer); MapLayerHost
   * mounts such a layer once, for the first integration in registry order.
   */
  sharedMapLayer: z.string().optional(),
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
 * and in generated configuration, so we constrain it to safe characters and
 * reject anything that could escape the install tree or a generated value.
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
export type IntegrationOverlayLegend = z.infer<typeof overlayLegendSchema>;
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
  /** All attributions, in manifest order. */
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
  const map: Record<string, Attribution> = {};
  const all: Attribution[] = [];

  return {
    set(dataSources) {
      const nextMap: Record<string, Attribution> = {};
      const nextAll: Attribution[] = [];
      for (const ds of dataSources) {
        const attr = dataSourceToAttribution(ds);
        nextMap[attr.sourceId] = attr;
        nextAll.push(attr);
      }
      for (const key of Object.keys(map)) delete map[key];
      Object.assign(map, nextMap);
      all.splice(0, all.length, ...nextAll);
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
