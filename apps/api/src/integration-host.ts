import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CacheClient,
  type CustomHealthCheckFn,
  type HttpClient,
  type HttpClientOptions,
  type IntegrationContext,
  IntegrationEventBus,
  type IntegrationManifest,
  type IntegrationStrings,
  type LiveStoreClient,
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
} from "@openmapx/integration-framework/installer";
import { sharedStrings } from "@openmapx/integration-framework/strings";
import { registerPoiSources as registerPoiSourcesInStore } from "@openmapx/poi-source-registry";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db, sql as pgClient } from "./db";
import { integrationConfig } from "./db/schema";
import { redis } from "./redis";
import {
  AttributionIndex,
  defaultMotisLicenseFile,
  getAttributionIndex,
  setAttributionIndex,
} from "./services/attribution";
import type { ManifestDataSource } from "./services/attribution/types";
import { loadAllBindingsByIntegration } from "./services/capability-bindings";
import { searchCatalog } from "./services/gtfs/catalog";
import { gtfsManager } from "./services/gtfs/index";
import * as gtfsQueries from "./services/gtfs/queries";
import { executeAllIntegrationHealthChecks } from "./services/integration-health";
import { getMetricsRecorder } from "./services/metrics/recorder";
import {
  getProviderHealth,
  ProviderHealth,
  setProviderHealth,
} from "./services/provider-health/registry";
import { getSecret, isSecretsConfigured, resolveVaultSecrets } from "./services/secrets";
import { getServiceRegistry, resolveRequiresForIntegration } from "./services/service-registry";
import { createIntegrationLogger } from "./utils/integration-logger";
import { requireAuth } from "./utils/require-auth";

type SetupFunction = (ctx: IntegrationContext) => void | Promise<void>;

const eventBus = new IntegrationEventBus();
const integrations = new Map<string, LoadedIntegration>();

export type IntegrationDirectoryInput = string | { directory: string; isBuiltIn: boolean };
type NormalizedIntegrationDirectory = { directory: string; isBuiltIn: boolean };
type RegisteredIntegrationRoute = {
  integrationId: string;
  method: string;
  path: string;
  handler: RouteHandler;
  options?: RouteOptions;
  score: number;
};

const integrationRoutes: RegisteredIntegrationRoute[] = [];
const ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _routeDispatcherFastify: FastifyInstance<any, any, any, any> | null = null;

// Stored for reload support
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _fastify: FastifyInstance<any, any, any, any> | null = null;
let _integrationDirs: NormalizedIntegrationDirectory[] = [];

function createHttpClient(_log: Logger): HttpClient {
  return {
    async get<T>(url: string, options?: HttpClientOptions): Promise<T> {
      const u = new URL(url);
      if (options?.params) {
        for (const [k, v] of Object.entries(options.params)) {
          if (v !== undefined) u.searchParams.set(k, String(v));
        }
      }

      if (options?.cache?.ttl && redis) {
        const cacheKey = `int:http:${u.toString()}`;
        try {
          const cached = await redis.get(cacheKey);
          if (cached) return JSON.parse(cached) as T;
        } catch {
          // cache miss
        }

        const res = await fetch(u.toString(), { headers: options?.headers });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as T;
        redis.setex(cacheKey, options.cache.ttl, JSON.stringify(data)).catch(() => {});
        return data;
      }

      const res = await fetch(u.toString(), { headers: options?.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    },

    async post<T>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options?.headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    },
  };
}

function createCacheClient(prefix: string): CacheClient {
  return {
    async get<T>(key: string): Promise<T | null> {
      if (!redis) return null;
      const val = await redis.get(`int:${prefix}:${key}`);
      return val ? (JSON.parse(val) as T) : null;
    },
    async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      if (!redis) return;
      const k = `int:${prefix}:${key}`;
      if (ttlSeconds) {
        await redis.setex(k, ttlSeconds, JSON.stringify(value));
      } else {
        await redis.set(k, JSON.stringify(value));
      }
    },
    async del(key: string): Promise<void> {
      if (!redis) return;
      await redis.del(`int:${prefix}:${key}`);
    },
    async withCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
      if (redis) {
        const k = `int:${prefix}:${key}`;
        try {
          const cached = await redis.get(k);
          if (cached) return JSON.parse(cached) as T;
        } catch {
          // cache miss
        }
        const result = await fn();
        redis.setex(k, ttlSeconds, JSON.stringify(result)).catch(() => {});
        return result;
      }
      return fn();
    },
  };
}

/**
 * Reader for the cross-process `poi:live:<sourceId>` keyspace that
 * `services/data-manager`'s `write-live` stage populates. The keys are
 * deliberately NOT integration-namespaced — data-manager has no notion of
 * integration ids, only the source ids in `@openmapx/poi-source-registry`.
 * Prefixing here would silently miss every write.
 *
 * Process-scoped (one client shared across all integrations); per-key
 * isolation already happens via `@openmapx/poi-source-registry` ensuring
 * source ids are globally unique.
 */
function createLiveStoreClient(): LiveStoreClient {
  return {
    async hmget<T>(key: string, fields: readonly string[]): Promise<(T | null)[]> {
      if (!redis) return fields.map(() => null);
      if (fields.length === 0) return [];
      const values = await redis.hmget(key, ...fields);
      return values.map((v) => (v ? (JSON.parse(v) as T) : null));
    },
  };
}

const liveStore: LiveStoreClient = createLiveStoreClient();

function createLogger(integrationId: string, fastify: FastifyInstance): Logger {
  return createIntegrationLogger(integrationId, fastify);
}

function buildGtfsDeps() {
  return {
    manager: gtfsManager,
    queries: gtfsQueries,
  };
}

function buildSwissGtfsDeps() {
  return {
    ...buildGtfsDeps(),
    async ensureSwissOfficialFeed() {
      if (!gtfsManager.initialized) return null;

      const existing = gtfsManager
        .getFeeds()
        .find(
          (feed) =>
            feed.countryCode.toLowerCase() === "ch" && feed.source === "opentransportdata-swiss",
        );

      // Always consult the catalog — the Swiss feed id encodes the timetable year
      // (e.g. `opentransportdata-swiss:ch:timetable-2026-gtfs2020`), so the latest
      // entry's slug changes when the year rolls over and must trigger a re-import.
      const swissFeed = (await searchCatalog(undefined, "ch")).find(
        (feed) => feed.source === "opentransportdata-swiss",
      );
      if (!swissFeed) return existing ?? null;

      const slug = swissFeed.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

      if (existing && existing.slug === slug) {
        if (existing.status === "active" || gtfsManager.isImporting(existing.slug)) {
          return existing;
        }
      }

      if (gtfsManager.isImporting(slug)) {
        return gtfsManager.getFeeds().find((feed) => feed.slug === slug) ?? existing ?? null;
      }

      await gtfsManager.startImport(swissFeed, slug);
      return gtfsManager.getFeeds().find((feed) => feed.slug === slug) ?? existing ?? null;
    },
  };
}

function injectRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    gtfsDeps: buildGtfsDeps(),
    swissGtfsDeps: buildSwissGtfsDeps(),
  };
}

export type ConfigSource = "default" | "database" | "vault" | "config.json" | "env";

export interface ConfigValueWithSource {
  value: unknown;
  source: ConfigSource;
}

export async function resolveConfigWithSources(
  manifest: IntegrationManifest,
  directory: string,
): Promise<Record<string, ConfigValueWithSource>> {
  const result: Record<string, ConfigValueWithSource> = {};
  const schema = manifest.configSchema as Record<string, unknown> | undefined;
  const knownKeys = new Set<string>();
  // Uppercased config key → canonical (original-case) key. Used to match env
  // vars like `INTEGRATION_PHOTOS_FLICKR_APIKEY` against configSchema key
  // `apiKey` without forcing operators to lowercase the suffix (or forcing
  // schema authors to pick all-lowercase keys).
  const upperToKey = new Map<string, string>();

  if (schema) {
    const props = (schema.properties ?? schema) as Record<string, { default?: unknown }>;
    for (const [key, def] of Object.entries(props)) {
      if (key === "type" || key === "properties") continue;
      knownKeys.add(key);
      upperToKey.set(key.toUpperCase(), key);
      if (def && typeof def === "object" && "default" in def && def.default !== undefined) {
        result[key] = { value: def.default, source: "default" };
      }
    }
  }

  if (knownKeys.size === 0) return result;

  try {
    const [row] = await db
      .select({ config: integrationConfig.config })
      .from(integrationConfig)
      .where(eq(integrationConfig.integrationId, manifest.id))
      .limit(1);
    if (row?.config && typeof row.config === "object") {
      for (const [key, value] of Object.entries(row.config as Record<string, unknown>)) {
        if (knownKeys.has(key)) result[key] = { value, source: "database" };
      }
    }
  } catch {
    // DB not available
  }

  // 3. Apply vault secrets
  try {
    const vaultSecrets = await resolveVaultSecrets(manifest.id);
    for (const [key, value] of Object.entries(vaultSecrets)) {
      if (knownKeys.has(key)) result[key] = { value, source: "vault" };
    }
  } catch {
    // vault unavailable
  }

  const configJsonPath = join(directory, "config.json");
  if (existsSync(configJsonPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configJsonPath, "utf-8"));
      if (typeof fileConfig === "object" && fileConfig !== null) {
        for (const [key, value] of Object.entries(fileConfig as Record<string, unknown>)) {
          if (knownKeys.has(key)) result[key] = { value, source: "config.json" };
        }
      }
    } catch {
      // ignore
    }
  }

  // Env layer — highest priority. Pattern: `INTEGRATION_<ID>_<KEY>` (upper-cased
  // id with hyphens replaced by underscores, then the upper-cased config key).
  // Matching is case-insensitive on the configSchema key so both snake_case
  // and camelCase keys work (`apiKey` matches `INTEGRATION_X_APIKEY`).
  const prefix = `INTEGRATION_${manifest.id.replace(/-/g, "_").toUpperCase()}_`;
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envVal === undefined) continue;
    if (!envKey.startsWith(prefix)) continue;
    const rest = envKey.slice(prefix.length);
    const canonical = upperToKey.get(rest);
    if (canonical) result[canonical] = { value: envVal, source: "env" };
  }

  return result;
}

async function resolveConfig(
  manifest: {
    id: string;
    configSchema?: Record<string, unknown>;
  },
  directory: string,
): Promise<Record<string, unknown>> {
  const withSources = await resolveConfigWithSources(manifest as IntegrationManifest, directory);
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(withSources)) {
    config[key] = entry.value;
  }
  return config;
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

// Mini-router for integration-defined paths. Fastify can't re-register routes
// at runtime (which we need for reload), so a single Fastify route catches
// `/api/integrations/:id/*` and dispatches here. Supported pattern subset:
//   - literal segments: `/foo/bar`
//   - named params: `:name` (one segment)
//   - trailing wildcard: `*` (matches the rest of the path, exposed as `*`)
// Not supported: regex constraints, optional segments, multi-segment globs
// in the middle of a path. Integrations needing more should compose multiple
// `registerRoute` calls.

function normalizeRoutePath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function routeScore(path: string): number {
  if (path === "/") return 0;
  return path
    .slice(1)
    .split("/")
    .reduce((score, segment) => {
      if (segment === "*") return score;
      if (!segment.includes(":")) return score + 10;
      return score + (segment.replace(/:[A-Za-z_$][\w$]*/g, "").length > 0 ? 6 : 4);
    }, path.length);
}

function registerIntegrationRoute(
  integrationId: string,
  method: string,
  path: string,
  handler: RouteHandler,
  options?: RouteOptions,
): void {
  integrationRoutes.push({
    integrationId,
    method: method.toUpperCase(),
    path: normalizeRoutePath(path),
    handler,
    options,
    score: routeScore(path),
  });
  integrationRoutes.sort((a, b) => b.score - a.score);
}

function resetIntegrationRoutes(): void {
  integrationRoutes.length = 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchRoutePath(pattern: string, path: string): Record<string, string> | null {
  const patternSegments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const pathSegments = path === "/" ? [] : path.slice(1).split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    if (patternSegment === "*") {
      params["*"] = decodeParam(pathSegments.slice(i).join("/"));
      return params;
    }

    const pathSegment = pathSegments[i];
    if (pathSegment === undefined) return null;

    const names: string[] = [];
    const regexSource = escapeRegex(patternSegment ?? "").replace(
      /:([A-Za-z_$][\w$]*)/g,
      (_full, name: string) => {
        names.push(name);
        return "([^/]+)";
      },
    );
    const match = pathSegment.match(new RegExp(`^${regexSource}$`));
    if (!match) return null;
    for (let j = 0; j < names.length; j++) {
      const captured = match[j + 1];
      if (captured !== undefined) params[names[j] as string] = decodeParam(captured);
    }
  }

  return patternSegments.length === pathSegments.length ? params : null;
}

function findIntegrationRoute(
  integrationId: string,
  method: string,
  path: string,
): { route: RegisteredIntegrationRoute; params: Record<string, string> } | null {
  const normalizedMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const normalizedPath = normalizeRoutePath(path);
  for (const route of integrationRoutes) {
    if (route.integrationId !== integrationId || route.method !== normalizedMethod) continue;
    const params = matchRoutePath(route.path, normalizedPath);
    if (params) return { route, params };
  }
  return null;
}

function registerIntegrationRouteDispatcher(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
): void {
  if (_routeDispatcherFastify === fastify) return;
  _routeDispatcherFastify = fastify;

  const dispatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id?: string; "*"?: string };
    const id = params.id;
    if (!id) return reply.status(404).send({ error: "Not found" });
    const integration = integrations.get(id);
    if (!integration?.enabled) return reply.status(404).send({ error: "Not found" });

    const routePath = params["*"] ? `/${params["*"]}` : "/";
    const matched = findIntegrationRoute(id, request.method, routePath);
    if (!matched) return reply.status(404).send({ error: "Not found" });

    let userId: string | undefined;
    if (matched.route.options?.requireAuth === true) {
      userId = await requireAuth(request);
    }

    await matched.route.handler(
      {
        query: request.query as Record<string, string>,
        params: matched.params,
        body: request.body,
        userId,
      },
      {
        send: (data) => {
          reply.send(data);
        },
        status: (code) => ({
          send: (data) => {
            reply.status(code).send(data);
          },
        }),
        header: (name, value) => {
          reply.header(name, value);
        },
        type: (contentType) => {
          reply.type(contentType);
        },
      },
    );

    // The integration handler sent its response through the shim above and
    // resolves to undefined; returning the reply hands control back to Fastify
    // as "already handled". Without it, the resolved-undefined handler races a
    // second send against the async preSerialization hook → ERR_HTTP_HEADERS_SENT
    // (see [[project-fastify-return-reply-contract]]).
    return reply;
  };

  fastify.route({ method: [...ROUTE_METHODS], url: "/api/integrations/:id", handler: dispatch });
  fastify.route({
    method: [...ROUTE_METHODS],
    url: "/api/integrations/:id/*",
    handler: dispatch,
  });
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

// In dev we mtime-bust so editing `index.ts` and hitting `/api/integrations/reload`
// picks up the change. In prod we never cache-bust — ESM `import()` is
// process-lifetime cached, so re-importing the same file URL would return the
// old module *and* leak nothing. Production updates require restarting app-api
// to load fresh backend code; the install/update job handlers say so in their
// logs.
function backendEntryImportSpecifier(entryPoint: string): string {
  const url = pathToFileURL(entryPoint);
  if (process.env.NODE_ENV !== "production") {
    try {
      const stats = statSync(entryPoint);
      url.searchParams.set("v", `${stats.mtimeMs}-${stats.size}`);
    } catch {
      url.searchParams.set("v", Date.now().toString());
    }
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
 * postgis (via `requires:` or the legacy `infrastructure.services`); returns
 * `undefined` otherwise. Shared by cold start and reload.
 */
function buildIntegrationDb(manifest: IntegrationManifest, raw: unknown): IntegrationContext["db"] {
  const rawInfra = (raw as Record<string, unknown>).infrastructure as
    | { services?: string[] }
    | undefined;
  const needsDb =
    manifest.requires?.some((r) => r.service === "postgis") ||
    rawInfra?.services?.includes("postgres");
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
 * Emits advisory warnings for required/enum config keys that violate the
 * manifest's `configSchema`. Never blocks load. Shared by cold start and reload.
 */
function warnInvalidConfig(
  manifest: IntegrationManifest,
  config: Record<string, unknown>,
  id: string,
  warn: (msg: string) => void,
): void {
  const configSchema = manifest.configSchema as Record<string, unknown> | undefined;
  if (!configSchema?.properties) return;
  const props = configSchema.properties as Record<
    string,
    { type?: string; enum?: unknown[]; required?: boolean }
  >;
  for (const [key, def] of Object.entries(props)) {
    if (def.required && config[key] === undefined) {
      warn(`Integration ${id}: missing required config key "${key}"`);
    }
    if (def.enum && config[key] !== undefined && !def.enum.includes(config[key])) {
      warn(
        `Integration ${id}: config "${key}" value "${config[key]}" not in allowed values: ${def.enum.join(", ")}`,
      );
    }
  }
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
    registerPhotoProvider(provider) {
      const existing = providers.get("photos") ?? [];
      existing.push(provider);
      providers.set("photos", existing);
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

    const integrationDb = buildIntegrationDb(manifest, raw);

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
    return {
      integrations: Array.from(integrations.values())
        .filter((i) => i.enabled)
        .map((i) => ({
          ...toIntegrationMeta(i),
          isBuiltIn: i.isBuiltIn,
        })),
      frameworkStrings: sharedStrings,
    };
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
      if (!fileName || fileName.includes("..")) {
        return reply.status(400).send({ error: "Invalid path" });
      }
      const filePath =
        fileName === "index.js"
          ? integrationFrontendBundlePath(integration.directory)
          : join(integration.directory, "dist", "frontend", fileName);
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

  // Health check endpoint for integration-managed services
  fastify.get("/api/integrations/health", async () => {
    const all = Array.from(integrations.values()).filter((i) => i.enabled);
    const results = await executeAllIntegrationHealthChecks(all);
    return { timestamp: new Date().toISOString(), services: results };
  });

  registerIntegrationRouteDispatcher(fastify);

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

export function getIntegrationsByDomain(domain: string): LoadedIntegration[] {
  return Array.from(integrations.values()).filter(
    (i) => i.enabled && i.manifest.domains.includes(domain),
  );
}

export function getIntegrationProviders<T>(id: string, domain: string): T[] {
  return (integrations.get(id)?.providers.get(domain) ?? []) as T[];
}

/**
 * Reload all integrations: shutdown existing, re-discover manifests, re-setup.
 * Note: Fastify routes registered by integrations cannot be removed at runtime,
 * so only provider re-registration and lifecycle hooks are re-executed.
 */
export async function reloadIntegrations(): Promise<{
  message: string;
  reloaded: number;
  enabled: number;
}> {
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

  integrations.clear();
  eventBus.removeAll();
  resetIntegrationRoutes();

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

    if (integrations.has(id)) {
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
      integrations.set(id, integration);
      continue;
    }

    const integrationDb = buildIntegrationDb(manifest, raw);

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

      integrations.set(id, integration);
      log.info(`Integration ${id} v${manifest.version ?? "unknown"} reloaded successfully`);
      eventBus.emit({ type: "integration.loaded", integrationId: id });
    } catch (err) {
      _fastify.log.error(err, `Failed to reload integration ${id}`);
      integration.enabled = false;
      integrations.set(id, integration);
      eventBus.emit({
        type: "integration.error",
        integrationId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
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
