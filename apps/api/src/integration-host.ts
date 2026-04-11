import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CacheClient,
  type CustomHealthCheckFn,
  type HttpClient,
  type HttpClientOptions,
  type IntegrationContext,
  IntegrationEventBus,
  type IntegrationManifest,
  type IntegrationStrings,
  type LoadedIntegration,
  type Logger,
  PLATFORM_VERSION,
  type RouteHandler,
  satisfiesPlatformVersion,
  toIntegrationMeta,
  validateManifest,
} from "@openmapx/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db, sql as pgClient } from "./db";
import { integrationConfig } from "./db/schema";
import { redis } from "./redis";
import { executeAllIntegrationHealthChecks } from "./services/integration-health";
import { getSecret, resolveVaultSecrets } from "./services/secrets";
import { providerHealth } from "./services/transit/health";
import type { TransitProvider } from "./services/transit/orchestrator";
import { transitOrchestrator } from "./services/transit/orchestrator";

type SetupFunction = (ctx: IntegrationContext) => void | Promise<void>;

const eventBus = new IntegrationEventBus();
const integrations = new Map<string, LoadedIntegration>();

// Stored for reload support
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _fastify: FastifyInstance<any, any, any, any> | null = null;
let _integrationDirs: string[] = [];

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

function createLogger(integrationId: string, fastify: FastifyInstance): Logger {
  return {
    info: (msg, ...args) => fastify.log.info({ integration: integrationId }, msg, ...args),
    warn: (msg, ...args) => fastify.log.warn({ integration: integrationId }, msg, ...args),
    error: (msg, ...args) => fastify.log.error({ integration: integrationId }, msg, ...args),
    debug: (msg, ...args) => fastify.log.debug({ integration: integrationId }, msg, ...args),
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

  if (schema) {
    const props = (schema.properties ?? schema) as Record<string, { default?: unknown }>;
    for (const [key, def] of Object.entries(props)) {
      if (key === "type" || key === "properties") continue;
      knownKeys.add(key);
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

  const prefix = `INTEGRATION_${manifest.id.replace(/-/g, "_").toUpperCase()}_`;
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith(prefix) && envVal !== undefined) {
      const key = envKey.slice(prefix.length).toLowerCase();
      if (knownKeys.has(key)) result[key] = { value: envVal, source: "env" };
    }
  }

  return result;
}

async function resolveConfig(
  manifest: {
    id: string;
    configSchema?: Record<string, unknown>;
    envVars?: string[];
  },
  directory: string,
): Promise<Record<string, unknown>> {
  const withSources = await resolveConfigWithSources(manifest as IntegrationManifest, directory);
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(withSources)) {
    config[key] = entry.value;
  }

  // Also load env vars declared in manifest (legacy direct-access pattern)
  for (const envVar of manifest.envVars ?? []) {
    const val = process.env[envVar];
    if (val !== undefined) {
      config[envVar] = val;
    }
  }

  return config;
}

async function discoverManifests(
  dirs: string[],
): Promise<
  Array<{ manifest: ReturnType<typeof JSON.parse>; directory: string; isBuiltIn: boolean }>
> {
  const results: Array<{
    manifest: ReturnType<typeof JSON.parse>;
    directory: string;
    isBuiltIn: boolean;
  }> = [];

  for (const baseDir of dirs) {
    if (!existsSync(baseDir)) continue;
    const isBuiltIn = !baseDir.includes("custom_integrations");

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

export async function initIntegrations(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  integrationDirs: string[],
): Promise<void> {
  _fastify = fastify;
  _integrationDirs = integrationDirs;

  // Reset transit provider health state when an integration is unloaded
  // (prevents stale failure counters from poisoning reloaded providers)
  eventBus.on("integration.unloaded", (event) => {
    const integration = integrations.get(event.integrationId);
    if (!integration) return;
    const transitProviders = (integration.providers.get("transit") ?? []) as TransitProvider[];
    for (const tp of transitProviders) {
      providerHealth.reset(tp.id);
    }
  });

  const discovered = await discoverManifests(integrationDirs);

  // Topological sort by manifest.dependencies to ensure deps load first
  const sorted = topologicalSort(discovered);

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

    const config = await resolveConfig(manifest, directory);

    // Validate config against configSchema if present
    const configSchema = manifest.configSchema as Record<string, unknown> | undefined;
    if (configSchema?.properties) {
      const props = configSchema.properties as Record<
        string,
        { type?: string; enum?: unknown[]; required?: boolean }
      >;
      for (const [key, def] of Object.entries(props)) {
        if (def.required && config[key] === undefined) {
          fastify.log.warn(`Integration ${id}: missing required config key "${key}"`);
        }
        if (def.enum && config[key] !== undefined && !def.enum.includes(config[key])) {
          fastify.log.warn(
            `Integration ${id}: config "${key}" value "${config[key]}" not in allowed values: ${def.enum.join(", ")}`,
          );
        }
      }
    }

    const log = createLogger(id, fastify);
    const http = createHttpClient(log);
    const cache = createCacheClient(id);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const providers = new Map<string, unknown[]>();
    let _customHealthCheck: CustomHealthCheckFn | undefined;

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

    const needsDb = manifest.infrastructure?.services?.includes("postgres");
    const integrationDb = needsDb
      ? {
          async execute<T = unknown>(query: string, params?: unknown[]): Promise<T> {
            const result = params
              ? await pgClient.unsafe(query, params as never[])
              : await pgClient.unsafe(query);
            return result as T;
          },
        }
      : undefined;

    const ctx: IntegrationContext = {
      id,
      manifest,
      config,
      http,
      cache,
      db: integrationDb,
      log,
      secrets: { get: (key: string) => getSecret(id, key) },
      registerProvider(domain: string, provider: unknown) {
        const existing = providers.get(domain) ?? [];
        existing.push(provider);
        providers.set(domain, existing);
      },
      registerRoute(method: string, path: string, handler: RouteHandler) {
        const fullPath = `/api/integrations/${id}${path.startsWith("/") ? path : `/${path}`}`;
        fastify.route({
          method: method.toUpperCase() as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          url: fullPath,
          async handler(request, reply) {
            await handler(
              {
                query: request.query as Record<string, string>,
                params: request.params as Record<string, string>,
                body: request.body,
              },
              {
                send: (data) => reply.send(data),
                status: (code) => ({
                  send: (data) => reply.status(code).send(data),
                }),
                header: (name, value) => reply.header(name, value),
                type: (contentType) => reply.type(contentType),
              },
            );
          },
        });
      },
      registerHealthCheck(fn: CustomHealthCheckFn) {
        _customHealthCheck = fn;
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
    };

    // Try to load the integration's setup function
    try {
      const modulePath = join(directory, "index.ts");
      const jsModulePath = join(directory, "index.js");
      const entryPoint = existsSync(modulePath) ? modulePath : jsModulePath;

      if (existsSync(entryPoint)) {
        const mod = (await import(entryPoint)) as { setup?: SetupFunction };
        if (typeof mod.setup === "function") {
          await mod.setup(ctx);
        }
      }

      // Bridge transit providers into the orchestrator
      const transitProviders = (providers.get("transit") ?? []) as TransitProvider[];
      for (const tp of transitProviders) {
        transitOrchestrator.register(tp);
      }

      // Geocoding providers are read directly from the integration framework
      // by the geocoding orchestrator via getIntegrationsByDomain("geocoding")
      const geocodingProviders = providers.get("geocoding") ?? [];
      if (geocodingProviders.length > 0) {
        log.info(`Registered ${geocodingProviders.length} geocoding provider(s)`);
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
    return Array.from(integrations.values())
      .filter((i) => i.enabled)
      .map((i) => ({
        ...toIntegrationMeta(i),
        isBuiltIn: i.isBuiltIn,
      }));
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
      const filePath = join(integration.directory, "dist", fileName);
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

export function getIntegrationsByDomain(domain: string): LoadedIntegration[] {
  return Array.from(integrations.values()).filter(
    (i) => i.enabled && i.manifest.domains.includes(domain),
  );
}

export function getIntegrationProviders<T>(id: string, domain: string): T[] {
  return (integrations.get(id)?.providers.get(domain) ?? []) as T[];
}

/**
 * Build a provider attribution map from transit integration manifests.
 * Keys are the provider prefixes (e.g. "db", "tfl") extracted from the
 * registered TransitProvider instances; values are attribution data
 * from the integration manifest.
 */
export function getTransitProviderAttribution(): Record<
  string,
  { label: string; url: string; license?: string; licenseUrl?: string }
> {
  const result: Record<
    string,
    { label: string; url: string; license?: string; licenseUrl?: string }
  > = {};

  for (const provider of transitOrchestrator.getAll()) {
    const prefix = provider.prefix.replace(/:$/, "");
    if (result[prefix]) continue;

    // Find the integration that registered this provider
    for (const integration of integrations.values()) {
      if (!integration.enabled) continue;
      const domainProviders = integration.providers.get("transit") ?? [];
      if (domainProviders.includes(provider)) {
        const ds = integration.manifest.dataSources?.[0];
        if (ds) {
          result[prefix] = {
            label: ds.name,
            url: ds.url,
            license: ds.license,
            licenseUrl: ds.licenseUrl,
          };
        }
        break;
      }
    }
  }

  return result;
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

    // Unregister transit providers from the orchestrator
    const transitProviders = (integration.providers.get("transit") ?? []) as TransitProvider[];
    for (const tp of transitProviders) {
      transitOrchestrator.unregister(tp.id);
    }
  }

  integrations.clear();
  eventBus.removeAll();

  // 2. Re-discover and re-setup (topological sort by dependencies, same as cold start)
  const discovered = await discoverManifests(_integrationDirs);
  const sorted = topologicalSort(discovered);

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

    if (integrations.has(id)) continue;

    if (!isBuiltIn && manifest.platform) {
      if (!satisfiesPlatformVersion(manifest.platform)) {
        _fastify.log.warn(
          `Skipping community integration ${id}: requires platform >=${manifest.platform}, current is ${PLATFORM_VERSION}`,
        );
        continue;
      }
    }

    const config = await resolveConfig(manifest, directory);
    const log = createLogger(id, _fastify);
    const http = createHttpClient(log);
    const cache = createCacheClient(id);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const providers = new Map<string, unknown[]>();

    // Validate config against configSchema if present
    const reloadConfigSchema = manifest.configSchema as Record<string, unknown> | undefined;
    if (reloadConfigSchema?.properties) {
      const props = reloadConfigSchema.properties as Record<
        string,
        { type?: string; enum?: unknown[]; required?: boolean }
      >;
      for (const [key, def] of Object.entries(props)) {
        if (def.required && config[key] === undefined) {
          _fastify.log.warn(`Integration ${id}: missing required config key "${key}"`);
        }
        if (def.enum && config[key] !== undefined && !def.enum.includes(config[key])) {
          _fastify.log.warn(
            `Integration ${id}: config "${key}" value "${config[key]}" not in allowed values: ${def.enum.join(", ")}`,
          );
        }
      }
    }

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

    const needsDb = manifest.infrastructure?.services?.includes("postgres");
    const integrationDb = needsDb
      ? {
          async execute<T = unknown>(query: string, params?: unknown[]): Promise<T> {
            const result = params
              ? await pgClient.unsafe(query, params as never[])
              : await pgClient.unsafe(query);
            return result as T;
          },
        }
      : undefined;

    const ctx: IntegrationContext = {
      id,
      manifest,
      config,
      http,
      cache,
      db: integrationDb,
      log,
      secrets: { get: (key: string) => getSecret(id, key) },
      registerProvider(domain: string, provider: unknown) {
        const existing = providers.get(domain) ?? [];
        existing.push(provider);
        providers.set(domain, existing);
      },
      registerRoute(_method: string, _path: string, _handler: RouteHandler) {
        // Routes cannot be re-registered in Fastify at runtime.
        // The original routes from initIntegrations still work.
        log.debug("registerRoute skipped during reload (routes persist from init)");
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
    };

    try {
      const modulePath = join(directory, "index.ts");
      const jsModulePath = join(directory, "index.js");
      const entryPoint = existsSync(modulePath) ? modulePath : jsModulePath;

      if (existsSync(entryPoint)) {
        const mod = (await import(entryPoint)) as { setup?: SetupFunction };
        if (typeof mod.setup === "function") {
          await mod.setup(ctx);
        }
      }

      const transitProviders = (providers.get("transit") ?? []) as TransitProvider[];
      for (const tp of transitProviders) {
        transitOrchestrator.register(tp);
      }

      integrations.set(id, integration);
      log.info(`Integration ${id} v${manifest.version ?? "unknown"} reloaded successfully`);
      eventBus.emit({ type: "integration.loaded", integrationId: id });
    } catch (err) {
      _fastify.log.error(err, `Failed to reload integration ${id}`);
      integration.enabled = false;
      integrations.set(id, integration);
    }
  }

  const enabledCount = Array.from(integrations.values()).filter((i) => i.enabled).length;
  _fastify.log.info(
    `Reloaded integrations: ${integrations.size} total (${enabledCount} enabled), was ${previousCount}`,
  );

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
}
