import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CacheClient,
  type CustomHealthCheckFn,
  type HttpClient,
  type HttpClientOptions,
  type IntegrationContext,
  IntegrationEventBus,
  type LoadedIntegration,
  type Logger,
  type RouteHandler,
  toIntegrationMeta,
  validateManifest,
} from "@openmapx/core";
import type { FastifyInstance } from "fastify";
import { redis } from "./redis";
import { dataSourceRegistry } from "./services/data-sources/registry";
import type { DataSourceProvider as LegacyDataSourceProvider } from "./services/data-sources/types";
import { executeAllIntegrationHealthChecks } from "./services/integration-health";
import type { TransitProviderImpl } from "./services/transit/orchestrator";
import { transitOrchestrator } from "./services/transit/orchestrator";

type SetupFunction = (ctx: IntegrationContext) => void | Promise<void>;

const eventBus = new IntegrationEventBus();
const integrations = new Map<string, LoadedIntegration>();

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

function resolveConfig(manifest: {
  id: string;
  configSchema?: Record<string, unknown>;
  envVars?: string[];
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Apply defaults from configSchema (supports both JSON Schema with "properties" wrapper
  // and flat format where keys are directly under configSchema)
  const schema = manifest.configSchema as Record<string, unknown> | undefined;
  if (schema) {
    const props = (schema.properties ?? schema) as Record<string, { default?: unknown }>;
    for (const [key, def] of Object.entries(props)) {
      if (key === "type" || key === "properties") continue;
      if (def && typeof def === "object" && "default" in def && def.default !== undefined) {
        config[key] = def.default;
      }
    }
  }

  // Apply env var overrides: INTEGRATION_<ID>_<KEY>
  const prefix = `INTEGRATION_${manifest.id.replace(/-/g, "_").toUpperCase()}_`;
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith(prefix) && envVal !== undefined) {
      const key = envKey.slice(prefix.length).toLowerCase();
      config[key] = envVal;
    }
  }

  // Load env vars declared in manifest
  for (const envVar of manifest.envVars ?? []) {
    const val = process.env[envVar];
    if (val !== undefined) {
      config[envVar] = val;
    }
  }

  // Check for config.json in integration directory (gitignored, for local dev)
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

export async function initIntegrations(
  fastify: FastifyInstance,
  integrationDirs: string[],
): Promise<void> {
  const discovered = await discoverManifests(integrationDirs);

  for (const { manifest: raw, directory, isBuiltIn } of discovered) {
    const validation = validateManifest(raw);
    if (!validation.valid) {
      fastify.log.warn(
        { id: raw.id, errors: validation.errors },
        `Skipping integration ${raw.id}: manifest validation failed`,
      );
      continue;
    }

    const manifest = raw;
    const id = manifest.id as string;

    if (integrations.has(id)) {
      fastify.log.warn(`Skipping duplicate integration: ${id}`);
      continue;
    }

    const config = resolveConfig(manifest);
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
      customHealthCheck: undefined,
      shutdownHandlers,
    };

    if (!integration.enabled) {
      integrations.set(id, integration);
      log.info(`Integration ${id} is disabled`);
      continue;
    }

    const ctx: IntegrationContext = {
      id,
      manifest,
      config,
      http,
      cache,
      log,
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

      // Bridge data-source providers into the legacy registry
      const dsProviders = (providers.get("data-source") ?? []) as LegacyDataSourceProvider[];
      for (const dsp of dsProviders) {
        dataSourceRegistry.register(dsp);
      }

      // Bridge transit providers into the orchestrator
      const transitProviders = (providers.get("transit") ?? []) as TransitProviderImpl[];
      for (const tp of transitProviders) {
        transitOrchestrator.register(tp);
      }

      // Geocoding providers are read directly from the integration framework
      // by geocoding.factory.ts via getIntegrationsByDomain("geocoding")
      const geocodingProviders = providers.get("geocoding") ?? [];
      if (geocodingProviders.length > 0) {
        log.info(`Registered ${geocodingProviders.length} geocoding provider(s)`);
      }

      integrations.set(id, integration);
      log.info(`Integration ${id} loaded successfully`);
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
      .map(toIntegrationMeta);
  });

  // Health check endpoint for integration-managed services
  fastify.get("/api/integrations/health", async () => {
    const all = Array.from(integrations.values()).filter((i) => i.enabled);
    const results = await executeAllIntegrationHealthChecks(all);
    return { timestamp: new Date().toISOString(), services: results };
  });

  fastify.log.info(
    `Loaded ${integrations.size} integrations (${Array.from(integrations.values()).filter((i) => i.enabled).length} enabled)`,
  );
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

export async function shutdownIntegrations(): Promise<void> {
  for (const integration of integrations.values()) {
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
