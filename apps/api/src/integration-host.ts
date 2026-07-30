import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CacheClient,
  type CustomHealthCheckFn,
  type HttpClient,
  type IntegrationContext,
  IntegrationEventBus,
  type IntegrationManifest,
  type IntegrationStrings,
  type LoadedIntegration,
  type Logger,
  PLATFORM_VERSION,
  type RouteHandler,
  type RouteOptions,
  satisfiesPlatformVersion,
  toIntegrationMeta,
  validateManifest,
} from "@openmapx/integration-framework";
import {
  integrationBackendBundlePath,
  integrationFrontendBundlePath,
  resolveLayerSelectorPreview,
} from "@openmapx/integration-framework/installer";
import { sharedStrings } from "@openmapx/integration-framework/strings";
import { registerPoiSources as registerPoiSourcesInStore } from "@openmapx/poi-source-registry";
import type { FastifyInstance } from "fastify";
import { sql as pgClient } from "./db";
import {
  createCacheClient,
  createHttpClient,
  createLiveStoreClient,
  createLogger,
} from "./integration-clients";
import {
  type ConfigSource,
  type ConfigValueWithSource,
  resolveConfig,
  resolveConfigWithSources,
  warnInvalidConfig,
} from "./integration-config";
import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "./integration-routes";
import { redis } from "./redis";
import {
  AttributionIndex,
  defaultMotisLicenseFile,
  getAttributionIndex,
  setAttributionIndex,
} from "./services/attribution";
import type { ManifestDataSource } from "./services/attribution/types";
import { loadAllBindingsByIntegration } from "./services/capability-bindings";
import { gtfsManager } from "./services/gtfs/index";
import * as gtfsQueries from "./services/gtfs/queries";
import {
  executeAllIntegrationHealthChecks,
  getCachedIntegrationHealthSnapshot,
} from "./services/integration-health";
import { getMetricsRecorder } from "./services/metrics/recorder";
import {
  getProviderHealth,
  ProviderHealth,
  setProviderHealth,
} from "./services/provider-health/registry";
import { getSecret, isSecretsConfigured } from "./services/secrets";
import { getServiceRegistry, resolveRequiresForIntegration } from "./services/service-registry";
import { getEmailDisclosure } from "./utils/email";

function canonicalizeExisting(p: string): string {
  let dir = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(dir)) {
      return tail.length ? join(realpathSync(dir), ...tail) : realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) return tail.length ? join(dir, ...tail) : dir;
    tail.unshift(basename(dir));
    dir = parent;
  }
}

export type { ConfigSource, ConfigValueWithSource };
export { resolveConfigWithSources };

type SetupFunction = (ctx: IntegrationContext) => void | Promise<void>;

const eventBus = new IntegrationEventBus();
const integrations = new Map<string, LoadedIntegration>();

export type IntegrationDirectoryInput = string | { directory: string; isBuiltIn: boolean };
type NormalizedIntegrationDirectory = { directory: string; isBuiltIn: boolean };

// Stored for reload support
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _fastify: FastifyInstance<any, any, any, any> | null = null;
let _integrationDirs: NormalizedIntegrationDirectory[] = [];

const liveStore = createLiveStoreClient();

function buildGtfsDeps() {
  return {
    manager: gtfsManager,
    queries: gtfsQueries,
  };
}

function injectRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    gtfsDeps: buildGtfsDeps(),
  };
}

function normalizeIntegrationDirs(
  dirs: IntegrationDirectoryInput[],
): NormalizedIntegrationDirectory[] {
  return dirs.map((entry) =>
    typeof entry === "string"
      ? { directory: entry, isBuiltIn: !entry.includes("custom_integrations") }
      : entry,
  );
}

async function discoverManifests(
  dirs: NormalizedIntegrationDirectory[],
): Promise<
  Array<{ manifest: ReturnType<typeof JSON.parse>; directory: string; isBuiltIn: boolean }>
> {
  const results: Array<{
    manifest: ReturnType<typeof JSON.parse>;
    directory: string;
    isBuiltIn: boolean;
  }> = [];

  for (const { directory: baseDir, isBuiltIn } of dirs) {
    if (!existsSync(baseDir)) continue;

    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue;
      const manifestPath = join(baseDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        results.push({
          manifest: raw,
          directory: resolve(baseDir, entry.name),
          isBuiltIn,
        });
      } catch {
        // skip invalid JSON
      }
    }
  }

  return results;
}

function loadStrings(directory: string): IntegrationStrings {
  const stringsDir = join(directory, "strings");
  const strings: IntegrationStrings = {};
  if (!existsSync(stringsDir)) return strings;
  try {
    for (const file of readdirSync(stringsDir)) {
      if (!file.endsWith(".json")) continue;
      const locale = file.replace(".json", "");
      const content = JSON.parse(readFileSync(join(stringsDir, file), "utf-8"));
      if (content && typeof content === "object") {
        strings[locale] = content;
      }
    }
  } catch {
    // skip unreadable strings
  }
  return strings;
}

function resolveBackendEntryPoint(directory: string, isBuiltIn: boolean): string | null {
  const bundled = integrationBackendBundlePath(directory);
  if (!isBuiltIn && existsSync(bundled)) return bundled;
  const modulePath = join(directory, "index.ts");
  const jsModulePath = join(directory, "index.js");
  if (existsSync(modulePath)) return modulePath;
  return existsSync(jsModulePath) ? jsModulePath : null;
}

// Cache-bust the dynamic import by the entry file's mtime+size so a reload
// (`reloadIntegrations` — fired by extension install/update and credential
// set/delete) picks up CHANGED backend code WITHOUT restarting app-api. ESM
// `import()` is keyed by URL and process-lifetime cached, so re-importing the
// same file URL returns the stale module — which is why a store update of an
// integration whose bundle path is unchanged otherwise silently keeps running
// the old code until a restart.
//
// Keying the bust on mtime+size (in dev AND prod) means an UNCHANGED file
// reuses the same URL → the cached module is returned, no new module is created;
// only a CHANGED file mints a new URL → a fresh import. The cost is that ESM
// modules are never garbage-collected, so each new URL leaks its (tiny,
// self-contained) module graph for the process lifetime — but the leak is now
// bounded to one module per actual code change (reloads with no code change,
// e.g. a credential rotation, reuse the cached URL and leak nothing), which over
// a process lifetime is negligible and well worth not requiring a restart.
function backendEntryImportSpecifier(entryPoint: string): string {
  const url = pathToFileURL(entryPoint);
  try {
    const stats = statSync(entryPoint);
    url.searchParams.set("v", `${stats.mtimeMs}-${stats.size}`);
  } catch {
    url.searchParams.set("v", Date.now().toString());
  }
  return url.href;
}

type DiscoveredEntry = {
  manifest: Record<string, unknown>;
  directory: string;
  isBuiltIn: boolean;
};

function topologicalSort(entries: DiscoveredEntry[]): DiscoveredEntry[] {
  const byId = new Map<string, DiscoveredEntry>();
  for (const entry of entries) {
    const id = entry.manifest.id as string;
    if (id) byId.set(id, entry);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const skipped = new Set<string>();
  const result: DiscoveredEntry[] = [];

  function visit(id: string) {
    if (visited.has(id) || skipped.has(id)) return;
    if (inStack.has(id)) {
      console.warn(`[integration-host] Dependency cycle involving "${id}" — skipping`);
      skipped.add(id);
      return;
    }
    inStack.add(id);
    const entry = byId.get(id);
    if (!entry) {
      inStack.delete(id);
      return;
    }
    const deps = (entry.manifest.dependencies ?? []) as string[];
    for (const dep of deps) {
      if (!byId.has(dep)) {
        console.warn(
          `[integration-host] Integration "${id}" requires "${dep}" which is not installed — skipping`,
        );
        skipped.add(id);
        inStack.delete(id);
        return;
      }
      visit(dep);
      if (skipped.has(dep)) {
        console.warn(
          `[integration-host] Integration "${id}" skipped because dependency "${dep}" was skipped`,
        );
        skipped.add(id);
        inStack.delete(id);
        return;
      }
    }
    inStack.delete(id);
    visited.add(id);
    result.push(entry);
  }

  for (const entry of entries) visit(entry.manifest.id as string);
  return result;
}

function collectManifestDataSources(
  entries: Array<{ manifest: Record<string, unknown> }>,
): ManifestDataSource[] {
  const out: ManifestDataSource[] = [];
  for (const { manifest } of entries) {
    const dataSources = manifest.dataSources;
    if (!Array.isArray(dataSources)) continue;
    for (const ds of dataSources) {
      if (!ds || typeof ds !== "object") continue;
      const row = ds as Record<string, unknown>;
      if (typeof row.sourceId !== "string" || typeof row.name !== "string") continue;
      out.push({
        sourceId: row.sourceId,
        name: row.name,
        url: typeof row.url === "string" ? row.url : undefined,
        license: typeof row.license === "string" ? row.license : undefined,
        licenseUrl: typeof row.licenseUrl === "string" ? row.licenseUrl : undefined,
        attribution: typeof row.attribution === "string" ? row.attribution : undefined,
        commercialUse:
          typeof row.commercialUse === "string"
            ? (row.commercialUse as ManifestDataSource["commercialUse"])
            : undefined,
        providerCountry: typeof row.providerCountry === "string" ? row.providerCountry : undefined,
        providerPrivacyUrl:
          typeof row.providerPrivacyUrl === "string" ? row.providerPrivacyUrl : undefined,
        endUserExposure:
          typeof row.endUserExposure === "string"
            ? (row.endUserExposure as ManifestDataSource["endUserExposure"])
            : undefined,
        personalData: typeof row.personalData === "boolean" ? row.personalData : undefined,
        cookies: typeof row.cookies === "boolean" ? row.cookies : undefined,
        dpaAvailable: typeof row.dpaAvailable === "boolean" ? row.dpaAvailable : undefined,
      });
    }
  }
  return out;
}

function manifestDeclaresSecretFields(manifest: IntegrationManifest): boolean {
  const schema = manifest.configSchema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  if (!props) return false;
  for (const value of Object.values(props)) {
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)["x-openmapx-secret"] === true
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the per-integration `DatabaseClient` when the manifest requires
 * postgis (via `requires: [{ service: "postgis" }]`); returns `undefined`
 * otherwise. Shared by cold start and reload.
 */
function buildIntegrationDb(manifest: IntegrationManifest): IntegrationContext["db"] {
  const needsDb = manifest.requires?.some((r) => r.service === "postgis");
  if (!needsDb) return undefined;
  return {
    async execute<T = unknown>(query: string, params?: unknown[]): Promise<T> {
      const result = params
        ? await pgClient.unsafe(query, params as never[])
        : await pgClient.unsafe(query);
      return result as T;
    },
  };
}

/**
 * Assembles the `IntegrationContext` passed to an integration's `setup()`.
 * The register* methods, event-bus wiring, and shutdown handling are identical
 * for cold start (`initIntegrations`) and reload (`reloadIntegrations`); only
 * the resolved `requiresMap`, per-integration clients, and target `integration`
 * record differ, so the caller supplies those.
 */
/**
 * Resolver for the data-use policy's disallowed source set, injected by the host
 * app (server.ts) to avoid a static import cycle with the policy service. The
 * IntegrationContext exposes it to orchestrators via `getDisallowedSourceIds`.
 */
let disallowedSourceResolver: (() => Promise<Set<string>>) | null = null;

export function setDisallowedSourceResolver(fn: () => Promise<Set<string>>): void {
  disallowedSourceResolver = fn;
}

/**
 * Resolver for the data-use policy's disallowed *integration* set (every data
 * source fully gated), injected by server.ts alongside the source resolver. The
 * IntegrationContext exposes it via `getDisallowedIntegrationIds` for transit /
 * knowledge orchestrators that key on the integration rather than a `source` field.
 */
let disallowedIntegrationResolver: (() => Promise<Set<string>>) | null = null;

export function setDisallowedIntegrationResolver(fn: () => Promise<Set<string>>): void {
  disallowedIntegrationResolver = fn;
}

/**
 * Hook run after the integration registry is rebuilt by `reloadIntegrations`,
 * injected by server.ts to drop caches derived from the integration set — chiefly
 * the data-use policy's memoized gated source/integration sets, which are computed
 * from `getAllIntegrations()` and would otherwise stay stale until their own TTL.
 * Injected (not imported) to avoid a static cycle with the policy service.
 */
let integrationsReloadedHook: (() => void) | null = null;

export function setIntegrationsReloadedHook(fn: () => void): void {
  integrationsReloadedHook = fn;
}

function buildIntegrationContext(args: {
  id: string;
  manifest: IntegrationManifest;
  config: Record<string, unknown>;
  log: Logger;
  http: HttpClient;
  cache: CacheClient;
  db: IntegrationContext["db"];
  requiresMap: ReturnType<typeof resolveRequiresForIntegration>;
  providers: Map<string, unknown[]>;
  shutdownHandlers: Array<() => Promise<void>>;
  integration: LoadedIntegration;
}): IntegrationContext {
  const { id, manifest, config, log, http, cache, db, requiresMap, providers, shutdownHandlers } =
    args;
  const { integration } = args;
  return {
    id,
    manifest,
    config,
    http,
    cache,
    liveStore,
    db,
    log,
    secrets: { get: (key: string) => getSecret(id, key) },
    attributionIndex: getAttributionIndex() ?? undefined,
    providerHealth: getProviderHealth() ?? undefined,
    metricsRecorder: getMetricsRecorder(),
    getRequiredService(key: string) {
      return requiresMap.get(key) ?? null;
    },
    registerTransitProvider(provider) {
      const existing = providers.get("transit") ?? [];
      existing.push(provider);
      providers.set("transit", existing);
    },
    registerRealtimeProvider(provider) {
      const existing = providers.get("live-transit") ?? [];
      existing.push(provider);
      providers.set("live-transit", existing);
    },
    registerMobilityDataSource(provider) {
      const existing = providers.get("data-source") ?? [];
      existing.push(provider);
      providers.set("data-source", existing);
    },
    registerWeatherProvider(provider) {
      const existing = providers.get("weather") ?? [];
      existing.push(provider);
      providers.set("weather", existing);
    },
    registerGeocodingProvider(provider) {
      const existing = providers.get("geocoding") ?? [];
      existing.push(provider);
      providers.set("geocoding", existing);
    },
    registerRoutingProvider(provider) {
      const existing = providers.get("routing") ?? [];
      existing.push(provider);
      providers.set("routing", existing);
    },
    registerRoadConditionsProvider(provider) {
      const existing = providers.get("road-conditions") ?? [];
      existing.push(provider);
      providers.set("road-conditions", existing);
    },
    registerPhotoProvider(provider) {
      const existing = providers.get("photos") ?? [];
      existing.push(provider);
      providers.set("photos", existing);
    },
    registerStreetLevelProvider(provider) {
      const existing = providers.get("street-level-imagery") ?? [];
      existing.push(provider);
      providers.set("street-level-imagery", existing);
    },
    registerReviewProvider(provider) {
      const existing = providers.get("reviews") ?? [];
      existing.push(provider);
      providers.set("reviews", existing);
    },
    registerPoiSearchProvider(provider) {
      const existing = providers.get("poi-search") ?? [];
      existing.push(provider);
      providers.set("poi-search", existing);
    },
    registerKnowledgeProvider(provider) {
      const existing = providers.get("knowledge") ?? [];
      existing.push(provider);
      providers.set("knowledge", existing);
    },
    registerGtfsCatalogProvider(provider) {
      const existing = providers.get("gtfs-catalog") ?? [];
      existing.push(provider);
      providers.set("gtfs-catalog", existing);
    },
    registerPoiSources(sources) {
      // Forward to the shared @openmapx/poi-source-registry store. The
      // wrapper logger tags warnings with the integration id so cross-
      // integration id collisions are traceable. `log` is the per-
      // integration Logger built earlier in this ctx builder.
      registerPoiSourcesInStore(sources, {
        warn: (msg: string, ...rest: unknown[]) => log.warn(`[poi-sources] ${msg}`, ...rest),
      });
    },
    registerRoute(method: string, path: string, handler: RouteHandler, options?: RouteOptions) {
      registerIntegrationRoute(id, method, path, handler, options);
    },
    registerHealthCheck(fn: CustomHealthCheckFn) {
      integration.customHealthCheck = fn;
    },
    registerDisclosure(disclosure) {
      if (!integration.disclosures) integration.disclosures = [];
      integration.disclosures.push(disclosure);
    },
    emit(event: string, data: unknown) {
      eventBus.emit({
        type: event,
        integrationId: id,
        ...(typeof data === "object" && data !== null ? data : {}),
      } as never);
    },
    on(event: string, handler: (data: unknown) => void) {
      return eventBus.on(event as never, handler as never);
    },
    onShutdown(cleanup: () => Promise<void>) {
      shutdownHandlers.push(cleanup);
    },
    getIntegrationsByDomain(domain: string) {
      return getIntegrationsByDomain(domain);
    },
    getDisallowedSourceIds() {
      return disallowedSourceResolver
        ? disallowedSourceResolver()
        : Promise.resolve(new Set<string>());
    },
    getDisallowedIntegrationIds() {
      return disallowedIntegrationResolver
        ? disallowedIntegrationResolver()
        : Promise.resolve(new Set<string>());
    },
  };
}

export async function initIntegrations(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  integrationDirs: IntegrationDirectoryInput[],
): Promise<void> {
  _fastify = fastify;
  _integrationDirs = normalizeIntegrationDirs(integrationDirs);
  resetIntegrationRoutes();

  const discovered = await discoverManifests(_integrationDirs);

  // Hard-fail at startup when any installed integration declares vault-backed
  // secret fields but OPENMAPX_SECRETS_KEY is missing. The lazy fallback in
  // secrets.ts already throws on first decrypt, but lazy failure means the
  // operator only finds out via a 500 from a user-facing route; bailing here
  // surfaces it as a boot error with a clear remediation hint.
  if (!isSecretsConfigured()) {
    const requiringSecrets = discovered.filter((d) =>
      manifestDeclaresSecretFields(d.manifest as IntegrationManifest),
    );
    if (requiringSecrets.length > 0) {
      const names = requiringSecrets.map((d) => d.manifest.id).join(", ");
      throw new Error(
        `OPENMAPX_SECRETS_KEY is not set but the following integrations require it: ${names}. ` +
          `Generate a key with: openssl rand -hex 32`,
      );
    }
    fastify.log.warn(
      "OPENMAPX_SECRETS_KEY is not set — vault-backed integration secrets cannot be stored or decrypted",
    );
  }

  // Topological sort by manifest.dependencies to ensure deps load first
  const sorted = topologicalSort(discovered);

  // Load all capability bindings once for requires: resolution.
  // Falls back gracefully if DB is unavailable (e.g. no PostgreSQL in dev).
  let allBindings = new Map<string, Map<string, string>>();
  try {
    allBindings = await loadAllBindingsByIntegration();
  } catch {
    fastify.log.debug(
      "Capability bindings unavailable — requires: resolution uses auto-select only",
    );
  }

  let registryInstance: ReturnType<typeof getServiceRegistry> | null = null;
  let loadedServices: ReturnType<ReturnType<typeof getServiceRegistry>["list"]> = [];
  try {
    registryInstance = getServiceRegistry();
    loadedServices = registryInstance.list();
  } catch {
    fastify.log.debug("Service registry unavailable — requires: resolution skipped");
  }

  // Initialise the persistent ProviderHealth tracker once per host boot.
  // When Redis is unavailable we leave the holder null and the orchestrator
  // falls back to its no-op handle (treats every provider as healthy).
  if (redis && !getProviderHealth()) {
    try {
      const providerHealthLog = {
        info: (m: string) => fastify.log.info(m),
        warn: (m: string) => fastify.log.warn(m),
        error: (m: string) => fastify.log.error(m),
        debug: (m: string) => fastify.log.debug(m),
      };
      const ph = await ProviderHealth.init({ redis, log: providerHealthLog });
      setProviderHealth(ph);
    } catch (err) {
      fastify.log.warn(err, "ProviderHealth initialization failed (continuing without it)");
    }
  }

  // Initialise the AttributionIndex once per host boot. Pre-loads MOTIS
  // license.json + every integration manifest's dataSources[] so providers
  // can resolve attribution rows via ctx.attributionIndex without each one
  // re-reading the underlying sources.
  try {
    const manifestDataSources = collectManifestDataSources(sorted);
    const attributionLog = {
      info: (m: string) => fastify.log.info(m),
      warn: (m: string) => fastify.log.warn(m),
      error: (m: string) => fastify.log.error(m),
      debug: (m: string) => fastify.log.debug(m),
    };
    const idx = await AttributionIndex.init({
      redis,
      log: attributionLog,
      motisLicenseFile: defaultMotisLicenseFile(),
      integrationManifests: manifestDataSources,
    });
    setAttributionIndex(idx);
  } catch (err) {
    fastify.log.warn(err, "AttributionIndex initialization failed (continuing without it)");
  }

  for (const { manifest: raw, directory, isBuiltIn } of sorted) {
    const validation = validateManifest(raw);
    if (!validation.valid) {
      fastify.log.warn(
        { id: raw.id, errors: validation.errors },
        `Skipping integration ${raw.id}: manifest validation failed`,
      );
      continue;
    }

    const manifest = raw as IntegrationManifest;
    const id = manifest.id;

    if (integrations.has(id)) {
      fastify.log.warn(`Skipping duplicate integration: ${id}`);
      continue;
    }

    // Enforce platform version compatibility for community integrations
    if (!isBuiltIn && manifest.platform) {
      if (!satisfiesPlatformVersion(manifest.platform)) {
        fastify.log.warn(
          `Skipping community integration ${id}: requires platform >=${manifest.platform}, current is ${PLATFORM_VERSION}`,
        );
        continue;
      }
    }

    const config = injectRuntimeConfig(await resolveConfig(manifest, directory));
    warnInvalidConfig(manifest, config, id, (msg) => fastify.log.warn(msg));

    const log = createLogger(id, fastify);
    const http = createHttpClient(log);
    const cache = createCacheClient(id);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const providers = new Map<string, unknown[]>();

    const integration: LoadedIntegration = {
      id,
      manifest,
      config,
      directory,
      isBuiltIn,
      enabled: config.enabled !== false,
      providers,
      strings: loadStrings(directory),
      customHealthCheck: undefined,
      shutdownHandlers,
    };

    if (!integration.enabled) {
      integrations.set(id, integration);
      log.info(`Integration ${id} is disabled`);
      continue;
    }

    const integrationDb = buildIntegrationDb(manifest);

    const requiresMap = resolveRequiresForIntegration({
      manifestId: id,
      requires: manifest.requires,
      loadedServices,
      bindings: allBindings.get(id) ?? new Map(),
      onUnsatisfied: (requirement, reason) =>
        fastify.log.warn(
          { integration: id, requirement, reason },
          `Integration ${id}: required service unresolved`,
        ),
    });

    const ctx = buildIntegrationContext({
      id,
      manifest,
      config,
      log,
      http,
      cache,
      db: integrationDb,
      requiresMap,
      providers,
      shutdownHandlers,
      integration,
    });

    // Try to load the integration's setup function
    try {
      const entryPoint = resolveBackendEntryPoint(directory, isBuiltIn);

      if (entryPoint) {
        const mod = (await import(backendEntryImportSpecifier(entryPoint))) as {
          setup?: SetupFunction;
        };
        if (typeof mod.setup === "function") {
          await mod.setup(ctx);
        }
      }

      integrations.set(id, integration);
      log.info(`Integration ${id} v${manifest.version ?? "unknown"} loaded successfully`);
      eventBus.emit({ type: "integration.loaded", integrationId: id });
    } catch (err) {
      fastify.log.error(err, `Failed to load integration ${id}`);
      integration.enabled = false;
      integrations.set(id, integration);
      eventBus.emit({
        type: "integration.error",
        integrationId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // Register the /api/integrations endpoint
  fastify.get("/api/integrations", async () => {
    const disclosures = Array.from(integrations.values())
      .filter((i) => i.enabled)
      .flatMap((i) => i.disclosures ?? []);
    try {
      disclosures.push(await getEmailDisclosure());
    } catch (err) {
      // Don't fail the whole endpoint if the email disclosure can't be resolved.
      fastify.log.warn({ err }, "email disclosure unavailable; omitting from /api/integrations");
    }
    return {
      integrations: Array.from(integrations.values())
        .filter((i) => i.enabled)
        .map((i) => ({
          ...toIntegrationMeta(i),
          isBuiltIn: i.isBuiltIn,
        })),
      frameworkStrings: sharedStrings,
      disclosures,
    };
  });

  const warnedPreviewIds = new Set<string>();
  fastify.get<{ Params: { id: string } }>("/api/integrations/:id/preview", async (req, reply) => {
    const integration = integrations.get(req.params.id);
    if (!integration?.enabled) {
      return reply.status(404).send({ error: "Not found" });
    }

    let previewPath: string | null;
    try {
      previewPath = resolveLayerSelectorPreview(
        integration.directory,
        integration.manifest as Record<string, unknown>,
      );
    } catch (error) {
      if (!warnedPreviewIds.has(integration.id)) {
        warnedPreviewIds.add(integration.id);
        fastify.log.warn(
          { integrationId: integration.id, err: error },
          "Integration layer preview is unavailable",
        );
      }
      return reply.status(404).send({ error: "Not found" });
    }
    if (!previewPath) {
      return reply.status(404).send({ error: "Not found" });
    }

    const bytes = readFileSync(previewPath);
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    reply.header("Content-Type", "image/svg+xml; charset=utf-8");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    reply.header("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
    return reply.send(bytes);
  });

  // Serve community integration frontend bundles
  fastify.get<{ Params: { id: string; "*": string } }>(
    "/api/integrations/:id/bundle/*",
    async (req, reply) => {
      const integration = integrations.get(req.params.id);
      if (!integration || integration.isBuiltIn) {
        return reply.status(404).send({ error: "Not found" });
      }
      const fileName = req.params["*"];
      if (!fileName) {
        return reply.status(400).send({ error: "Invalid path" });
      }
      const filePath =
        fileName === "index.js"
          ? integrationFrontendBundlePath(integration.directory)
          : join(integration.directory, "dist", "frontend", fileName);
      const realRoot = canonicalizeExisting(integration.directory);
      const realFile = canonicalizeExisting(filePath);
      const rel = relative(realRoot, realFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return reply.status(400).send({ error: "Invalid path" });
      }
      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: "Bundle not found" });
      }
      const ext = fileName.split(".").pop();
      const mimeTypes: Record<string, string> = {
        js: "application/javascript",
        mjs: "application/javascript",
        css: "text/css",
        json: "application/json",
      };
      reply.header("Content-Type", mimeTypes[ext ?? ""] ?? "application/octet-stream");
      reply.header("Cache-Control", "public, max-age=3600");
      return reply.send(readFileSync(filePath));
    },
  );

  // Public status reads are deliberately cache-only. The background scheduler
  // below and the authenticated admin sweep are the only full-check callers.
  fastify.get("/api/integrations/health", () => {
    const all = Array.from(integrations.values()).filter((i) => i.enabled);
    const snapshot = getCachedIntegrationHealthSnapshot(all);
    return {
      timestamp: new Date(snapshot.updatedAt ?? Date.now()).toISOString(),
      services: snapshot.results,
    };
  });

  registerIntegrationRouteDispatcher(fastify, integrations);

  // Reload endpoint — re-discovers and re-initializes integrations (dev only)
  if (process.env.NODE_ENV !== "production") {
    fastify.post("/api/integrations/reload", async (_request, reply) => {
      try {
        const result = await reloadIntegrations();
        return result;
      } catch (err) {
        return reply.status(500).send({
          error: "Reload failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  fastify.log.info(
    `Loaded ${integrations.size} integrations (${Array.from(integrations.values()).filter((i) => i.enabled).length} enabled)`,
  );

  // Run initial health check to seed the cache, then periodically refresh
  const runHealthRefresh = () => {
    const enabled = Array.from(integrations.values()).filter((i) => i.enabled);
    executeAllIntegrationHealthChecks(enabled).catch((err) =>
      fastify.log.warn(err, "Health cache refresh failed"),
    );
  };
  // Seed asynchronously (don't block startup)
  setTimeout(runHealthRefresh, 5_000);
  // Refresh every 60 seconds
  const healthInterval = setInterval(runHealthRefresh, 60_000);
  healthInterval.unref();
}

export function getIntegration(id: string): LoadedIntegration | undefined {
  return integrations.get(id);
}

export function getAllIntegrations(): LoadedIntegration[] {
  return Array.from(integrations.values());
}

/**
 * True when `scheme` matches the id of an installed integration manifest —
 * regardless of whether its `setup()` succeeded. The places route uses this
 * to decide whether an unregistered resolver should 404 (the integration
 * owns the scheme but didn't boot) or fall through to the freeform name+
 * coord lookup (the scheme is a UI-side convention like `saved`/`stylePoi`,
 * not an integration). Manifest discovery runs before `setup()`, so this
 * stays accurate even when an integration crashes during boot — which is
 * the failure mode this gate exists to catch.
 */
export function isIntegrationScheme(scheme: string): boolean {
  return integrations.has(scheme);
}

/**
 * True when `scheme` matches an installed integration that is **not**
 * config-disabled (`config.enabled !== false`). The places route uses this
 * to decide whether a missing resolver should 404 (the integration owns the
 * scheme and is enabled, so the missing resolver is a boot failure) or fall
 * through to coord-fallback (the integration is config-disabled, so a stale
 * deep-link should degrade gracefully rather than hard-404).
 *
 * Keyed on `config.enabled`, not the runtime `enabled` flag: both a
 * config-disabled integration and an enabled-but-`setup()`-threw integration
 * have `enabled === false` at runtime, but only `config.enabled === false`
 * uniquely marks config-disabled. Using the runtime flag would let a broken
 * enabled integration fall through to coord-fallback, re-opening the
 * tag-substitution leak the 404 trap closes.
 */
export function isEnabledIntegrationScheme(scheme: string): boolean {
  const i = integrations.get(scheme);
  return i !== undefined && i.config?.enabled !== false;
}

export function getIntegrationsByDomain(domain: string): LoadedIntegration[] {
  return Array.from(integrations.values()).filter(
    (i) => i.enabled && i.manifest.domains.includes(domain),
  );
}

export function getIntegrationProviders<T>(id: string, domain: string): T[] {
  return (integrations.get(id)?.providers.get(domain) ?? []) as T[];
}

// A `type` (not `interface`) so it keeps an implicit index signature and stays
// assignable to Record<string, unknown> — the integration.reload job handler
// casts the result, and an interface would break that at the call site.
type ReloadResult = {
  message: string;
  reloaded: number;
  enabled: number;
};

let activeReload: Promise<ReloadResult> | null = null;
let pendingReload: Promise<ReloadResult> | null = null;

/**
 * Serialized reload. If a reload is in flight, callers share ONE trailing full
 * pass that starts after it finishes — a caller that just wrote new integration
 * files is guaranteed a discover+setup pass starting at or after its call,
 * while N concurrent callers cause at most one queued rebuild.
 */
export async function reloadIntegrations(): Promise<ReloadResult> {
  if (!activeReload) {
    activeReload = doReloadIntegrations().finally(() => {
      activeReload = null;
    });
    return activeReload;
  }
  if (!pendingReload) {
    pendingReload = activeReload
      .catch(() => undefined)
      .then(() => {
        pendingReload = null;
        return reloadIntegrations();
      });
  }
  return pendingReload;
}

/**
 * Reload all integrations: shutdown existing, re-discover manifests, re-setup.
 * Note: Fastify routes registered by integrations cannot be removed at runtime,
 * so only provider re-registration and lifecycle hooks are re-executed.
 */
async function doReloadIntegrations(): Promise<ReloadResult> {
  if (!_fastify) throw new Error("Integration host not initialized");

  const previousCount = integrations.size;

  // 1. Shutdown all existing integrations
  for (const integration of integrations.values()) {
    eventBus.emit({ type: "integration.unloaded", integrationId: integration.id });

    for (const handler of integration.shutdownHandlers) {
      try {
        await handler();
      } catch {
        // best effort
      }
    }
  }

  eventBus.removeAll();
  resetIntegrationRoutes();

  // Rebuild into a detached map, then swap the shared map's CONTENTS in one
  // synchronous burst after the loop — readers keep seeing the old registry
  // (and the route dispatcher keeps its shared reference) until then.
  const next = new Map<string, LoadedIntegration>();

  // 2. Re-discover and re-setup (topological sort by dependencies, same as cold start)
  const discovered = await discoverManifests(_integrationDirs);
  const sorted = topologicalSort(discovered);

  // Reload capability bindings and service registry for requires: resolution.
  let reloadBindings = new Map<string, Map<string, string>>();
  try {
    reloadBindings = await loadAllBindingsByIntegration();
  } catch {
    _fastify.log.debug("Capability bindings unavailable during reload");
  }

  let reloadRegistry: ReturnType<typeof getServiceRegistry> | null = null;
  let reloadServices: ReturnType<ReturnType<typeof getServiceRegistry>["list"]> = [];
  try {
    reloadRegistry = getServiceRegistry();
    reloadServices = reloadRegistry.list();
  } catch {
    _fastify.log.debug("Service registry unavailable during reload");
  }

  // Refresh the AttributionIndex with the freshly discovered manifests so
  // any added/removed integrations' dataSources are reflected in resolver
  // lookups.
  const existingIndex = getAttributionIndex();
  if (existingIndex) {
    existingIndex.setIntegrationManifests(collectManifestDataSources(sorted));
    try {
      await existingIndex.reload();
    } catch (err) {
      _fastify.log.warn(err, "AttributionIndex reload failed");
    }
  }

  for (const { manifest: raw, directory, isBuiltIn } of sorted) {
    const validation = validateManifest(raw);
    if (!validation.valid) {
      _fastify.log.warn(
        { id: raw.id, errors: validation.errors },
        `Skipping integration ${raw.id}: manifest validation failed`,
      );
      continue;
    }

    const manifest = raw as IntegrationManifest;
    const id = manifest.id;

    if (next.has(id)) {
      _fastify.log.warn(`Skipping duplicate integration: ${id}`);
      continue;
    }

    if (!isBuiltIn && manifest.platform) {
      if (!satisfiesPlatformVersion(manifest.platform)) {
        _fastify.log.warn(
          `Skipping community integration ${id}: requires platform >=${manifest.platform}, current is ${PLATFORM_VERSION}`,
        );
        continue;
      }
    }

    const config = injectRuntimeConfig(await resolveConfig(manifest, directory));
    const log = createLogger(id, _fastify);
    const http = createHttpClient(log);
    const cache = createCacheClient(id);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const providers = new Map<string, unknown[]>();

    warnInvalidConfig(manifest, config, id, (msg) => _fastify?.log.warn(msg));

    const integration: LoadedIntegration = {
      id,
      manifest,
      config,
      directory,
      isBuiltIn,
      enabled: config.enabled !== false,
      providers,
      strings: loadStrings(directory),
      customHealthCheck: undefined,
      shutdownHandlers,
    };

    if (!integration.enabled) {
      next.set(id, integration);
      continue;
    }

    const integrationDb = buildIntegrationDb(manifest);

    const fastifyForReload = _fastify;
    const reloadRequiresMap = resolveRequiresForIntegration({
      manifestId: id,
      requires: manifest.requires,
      loadedServices: reloadServices,
      bindings: reloadBindings.get(id) ?? new Map(),
      onUnsatisfied: (requirement, reason) =>
        fastifyForReload?.log.warn(
          { integration: id, requirement, reason },
          `Integration ${id}: required service unresolved`,
        ),
    });

    const ctx = buildIntegrationContext({
      id,
      manifest,
      config,
      log,
      http,
      cache,
      db: integrationDb,
      requiresMap: reloadRequiresMap,
      providers,
      shutdownHandlers,
      integration,
    });

    try {
      const entryPoint = resolveBackendEntryPoint(directory, isBuiltIn);

      if (entryPoint) {
        const mod = (await import(backendEntryImportSpecifier(entryPoint))) as {
          setup?: SetupFunction;
        };
        if (typeof mod.setup === "function") {
          await mod.setup(ctx);
        }
      }

      next.set(id, integration);
      log.info(`Integration ${id} v${manifest.version ?? "unknown"} reloaded successfully`);
      eventBus.emit({ type: "integration.loaded", integrationId: id });
    } catch (err) {
      _fastify.log.error(err, `Failed to reload integration ${id}`);
      integration.enabled = false;
      next.set(id, integration);
      eventBus.emit({
        type: "integration.error",
        integrationId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // Swap contents atomically (no awaits): readers never observe a partially
  // rebuilt registry — they see the old set until this point, the new set after.
  integrations.clear();
  for (const [id, integration] of next) {
    integrations.set(id, integration);
  }

  const enabledCount = Array.from(integrations.values()).filter((i) => i.enabled).length;
  _fastify.log.info(
    `Reloaded integrations: ${integrations.size} total (${enabledCount} enabled), was ${previousCount}`,
  );

  // The data-use policy memoizes gated sets derived from the (now-rebuilt)
  // registry; drop them so the next request re-derives against the new set.
  integrationsReloadedHook?.();

  return {
    message: "Integrations reloaded",
    reloaded: integrations.size,
    enabled: enabledCount,
  };
}

export async function shutdownIntegrations(): Promise<void> {
  for (const integration of integrations.values()) {
    eventBus.emit({ type: "integration.unloaded", integrationId: integration.id });

    for (const handler of integration.shutdownHandlers) {
      try {
        await handler();
      } catch {
        // best effort
      }
    }
  }
  integrations.clear();
  eventBus.removeAll();
  resetIntegrationRoutes();

  const idx = getAttributionIndex();
  if (idx) {
    idx.close();
    setAttributionIndex(null);
  }

  const ph = getProviderHealth();
  if (ph) {
    ph.close();
    setProviderHealth(null);
  }
}
