import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { oauthClient } from "../../db/schema.js";
import { envString } from "../../utils/env.js";
import { resolveEffectiveServiceConfig } from "../service-config-resolver.js";
import { getServiceRegistry, serviceUrl } from "../service-registry.js";
import { getServiceSecretStrict } from "../service-secrets.js";
import {
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_POSTGIS_SERVICE_ID,
  DAWARICH_REDIS_SERVICE_ID,
  DAWARICH_SOFTWARE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  type ManagedOAuthClient,
  managedOAuthClientMatchesExpected,
  validatePublicHostname,
} from "./provisioning.js";

const MAX_HEALTH_CACHE_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;
const BUNDLE_SERVICE_IDS = [
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  DAWARICH_POSTGIS_SERVICE_ID,
  DAWARICH_REDIS_SERVICE_ID,
] as const;

export interface ManagedDawarichState {
  internalBaseUrl: string;
  publicOrigin: string;
  healthy: boolean;
  provisioned: boolean;
}

export interface ManagedDawarichResolver {
  resolve(): Promise<ManagedDawarichState | null> | ManagedDawarichState | null;
}

interface RuntimeState {
  installed: boolean;
  selected: boolean;
  internalBaseUrl: string | null;
}

export interface ManagedDawarichResolverDependencies {
  getRuntimeState(): RuntimeState;
  getConfig(serviceId: string): Promise<Record<string, unknown>>;
  getSecret(serviceId: string, key: string): Promise<string | null>;
  getOAuthAuthority(): Promise<ManagedOAuthAuthoritySnapshot>;
  fetchHealth(url: string, init: RequestInit): Promise<Pick<Response, "ok">>;
  now(): number;
}

export interface ManagedOAuthAuthoritySnapshot {
  issuer: string | null;
  clients: readonly ManagedOAuthClient[];
}

interface HealthCacheEntry {
  internalBaseUrl: string;
  healthy: boolean;
  expiresAt: number;
}

function exactPublicOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      validatePublicHostname(parsed.hostname) !== parsed.hostname
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function exactIssuer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/api/auth" &&
      !parsed.search &&
      !parsed.hash &&
      validatePublicHostname(parsed.hostname) === parsed.hostname
    );
  } catch {
    return false;
  }
}

function sameSecret(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

interface ReadyConfig {
  publicOrigin: string;
  issuer: string;
  clientId: string;
}

function configsReady(
  app: Record<string, unknown>,
  worker: Record<string, unknown>,
  postgis: Record<string, unknown>,
): ReadyConfig | null {
  const publicOrigin = exactPublicOrigin(app.APPLICATION_URL);
  if (!publicOrigin) return null;
  const hostname = new URL(publicOrigin).hostname;
  const expected = {
    APPLICATION_HOSTS: hostname,
    APPLICATION_URL: publicOrigin,
    DOMAIN: hostname,
    APPLICATION_PROTOCOL: "https",
    REDIS_URL: "redis://dawarich-redis:6379",
    DATABASE_HOST: DAWARICH_POSTGIS_SERVICE_ID,
    DATABASE_PORT: "5432",
    DATABASE_USERNAME: "postgres",
    DATABASE_NAME: "dawarich_production",
    TIME_ZONE: "UTC",
    OIDC_REDIRECT_URI: `${publicOrigin}/users/auth/openid_connect/callback`,
    OIDC_PROVIDER_NAME: "OpenMapX",
    OIDC_AUTO_REGISTER: "true",
    OIDC_PKCE_ENABLED: "true",
  } as const;
  if (
    Object.entries(expected).some(([key, value]) => app[key] !== value || worker[key] !== value) ||
    typeof app.OIDC_CLIENT_ID !== "string" ||
    app.OIDC_CLIENT_ID.length === 0 ||
    worker.OIDC_CLIENT_ID !== app.OIDC_CLIENT_ID ||
    !exactIssuer(app.OIDC_ISSUER) ||
    worker.OIDC_ISSUER !== app.OIDC_ISSUER ||
    postgis.POSTGRES_USER !== "postgres" ||
    postgis.POSTGRES_DB !== "dawarich_production"
  ) {
    return null;
  }
  return {
    publicOrigin,
    issuer: app.OIDC_ISSUER as string,
    clientId: app.OIDC_CLIENT_ID as string,
  };
}

function authorityReady(config: ReadyConfig, authority: ManagedOAuthAuthoritySnapshot): boolean {
  if (authority.issuer !== config.issuer || authority.clients.length !== 1) return false;
  const client = authority.clients[0];
  return Boolean(
    client &&
      client.client_id === config.clientId &&
      managedOAuthClientMatchesExpected(client, config.publicOrigin),
  );
}

async function secretsReady(dependencies: ManagedDawarichResolverDependencies): Promise<boolean> {
  const [postgisDb, appDb, workerDb, appRails, workerRails, appOidc, workerOidc] =
    await Promise.all([
      dependencies.getSecret(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD"),
      dependencies.getSecret(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD"),
      dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD"),
      dependencies.getSecret(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE"),
      dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE"),
      dependencies.getSecret(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"),
      dependencies.getSecret(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET"),
    ]);
  return (
    sameSecret(postgisDb, appDb) &&
    sameSecret(appDb, workerDb) &&
    sameSecret(appRails, workerRails) &&
    sameSecret(appOidc, workerOidc)
  );
}

export class ManagedDawarichServiceResolver implements ManagedDawarichResolver {
  private healthCache: HealthCacheEntry | null = null;
  private readonly healthTtlMs: number;

  constructor(
    private readonly dependencies: ManagedDawarichResolverDependencies = defaultDependencies,
    healthTtlMs = MAX_HEALTH_CACHE_MS,
  ) {
    this.healthTtlMs = Math.max(0, Math.min(healthTtlMs, MAX_HEALTH_CACHE_MS));
  }

  async resolve(): Promise<ManagedDawarichState | null> {
    const runtime = this.dependencies.getRuntimeState();
    if (!runtime.installed || !runtime.selected || !runtime.internalBaseUrl) return null;

    const [app, worker, postgis] = await Promise.all([
      this.dependencies.getConfig(DAWARICH_APP_SERVICE_ID),
      this.dependencies.getConfig(DAWARICH_WORKER_SERVICE_ID),
      this.dependencies.getConfig(DAWARICH_POSTGIS_SERVICE_ID),
    ]);
    const config = configsReady(app, worker, postgis);
    const provisioned = Boolean(
      config &&
        authorityReady(config, await this.dependencies.getOAuthAuthority()) &&
        (await secretsReady(this.dependencies)),
    );
    if (!provisioned) {
      return {
        internalBaseUrl: runtime.internalBaseUrl,
        publicOrigin: "",
        provisioned: false,
        healthy: false,
      };
    }
    return {
      internalBaseUrl: runtime.internalBaseUrl,
      publicOrigin: (config as ReadyConfig).publicOrigin,
      provisioned: true,
      healthy: await this.resolveHealth(runtime.internalBaseUrl),
    };
  }

  private async resolveHealth(internalBaseUrl: string): Promise<boolean> {
    const now = this.dependencies.now();
    if (this.healthCache?.internalBaseUrl === internalBaseUrl && this.healthCache.expiresAt > now) {
      return this.healthCache.healthy;
    }
    let healthy = false;
    try {
      const response = await this.dependencies.fetchHealth(`${internalBaseUrl}/api/v1/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
    this.healthCache = {
      internalBaseUrl,
      healthy,
      expiresAt: now + this.healthTtlMs,
    };
    return healthy;
  }
}

async function readConfig(serviceId: string): Promise<Record<string, unknown>> {
  const service = getServiceRegistry().get(serviceId);
  if (!service) return {};
  return resolveEffectiveServiceConfig({
    id: service.manifest.id,
    configSchema: service.manifest.configSchema,
    containerEnv: service.manifest.container.environment,
  });
}

function authoritativeIssuer(): string | null {
  const configured = envString("BETTER_AUTH_URL", "http://localhost:3001");
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      validatePublicHostname(parsed.hostname) !== parsed.hostname
    ) {
      return null;
    }
    return `${parsed.origin}/api/auth`;
  } catch {
    return null;
  }
}

/**
 * Read-only authority snapshot for user-facing readiness. Better Auth 1.6.25
 * has no supported system/headerless client inspector and its full API is
 * intentionally admin-session protected. Select only non-secret client
 * metadata from Better Auth's own persistence; all client writes remain
 * exclusively behind Better Auth's authenticated public API.
 */
async function readOAuthAuthority(): Promise<ManagedOAuthAuthoritySnapshot> {
  const clients = await db
    .select({
      client_id: oauthClient.clientId,
      client_name: oauthClient.name,
      client_uri: oauthClient.uri,
      software_id: oauthClient.softwareId,
      software_version: oauthClient.softwareVersion,
      reference_id: oauthClient.referenceId,
      redirect_uris: oauthClient.redirectUris,
      token_endpoint_auth_method: oauthClient.tokenEndpointAuthMethod,
      grant_types: oauthClient.grantTypes,
      response_types: oauthClient.responseTypes,
      scopes: oauthClient.scopes,
      require_pkce: oauthClient.requirePKCE,
      skip_consent: oauthClient.skipConsent,
      enable_end_session: oauthClient.enableEndSession,
      public: oauthClient.public,
      disabled: oauthClient.disabled,
      type: oauthClient.type,
    })
    .from(oauthClient)
    .where(eq(oauthClient.softwareId, DAWARICH_SOFTWARE_ID));
  return {
    issuer: authoritativeIssuer(),
    clients: clients.map(({ scopes, ...client }) => ({
      ...client,
      scope: scopes?.join(" "),
    })) as ManagedOAuthClient[],
  };
}

function runtimeState(): RuntimeState {
  try {
    const registry = getServiceRegistry();
    const installed = BUNDLE_SERVICE_IDS.every((serviceId) => Boolean(registry.get(serviceId)));
    const selected =
      installed && BUNDLE_SERVICE_IDS.every((serviceId) => registry.get(serviceId)?.enabled);
    return {
      installed,
      selected,
      internalBaseUrl: selected ? serviceUrl(DAWARICH_APP_SERVICE_ID) : null,
    };
  } catch {
    return { installed: false, selected: false, internalBaseUrl: null };
  }
}

const defaultDependencies: ManagedDawarichResolverDependencies = {
  getRuntimeState: runtimeState,
  getConfig: readConfig,
  getSecret: getServiceSecretStrict,
  getOAuthAuthority: readOAuthAuthority,
  fetchHealth: (url, init) => fetch(url, init),
  now: Date.now,
};

/** Shared runtime resolver so every caller uses the same bounded health-only cache. */
export const managedDawarichResolver = new ManagedDawarichServiceResolver();
