import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider.js";
import type { RealtimeProvider } from "./contracts/realtime-provider.js";
import type { TransitProvider } from "./contracts/transit-provider.js";
import type { LoadedIntegration } from "./loader";
import type { IntegrationManifest } from "./manifest";

export interface HttpClientOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  cache?: { ttl: number };
}

export interface HttpClient {
  get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T>;
}

export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  withCache<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T>;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface DatabaseClient {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export type RouteHandler = (
  req: {
    query: Record<string, string>;
    params: Record<string, string>;
    body: unknown;
    /**
     * Authenticated user id. Only populated when the route was registered
     * with `{ requireAuth: true }`; the host rejects unauthenticated callers
     * with 401 before invoking the handler, so this field is non-null inside
     * auth-required handlers.
     */
    userId?: string;
  },
  reply: {
    send: (data: unknown) => void;
    status: (code: number) => { send: (data: unknown) => void };
    header: (name: string, value: string) => void;
    type: (contentType: string) => void;
  },
) => Promise<void> | void;

export interface RouteOptions {
  /** Require a valid session; respond 401 before invoking the handler otherwise. */
  requireAuth?: boolean;
}

export interface HealthCheckResult {
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

export type CustomHealthCheckFn = () => Promise<HealthCheckResult>;

export interface SecretsClient {
  /** Retrieve a decrypted secret from the vault, or null if not stored. */
  get(key: string): Promise<string | null>;
}

/**
 * Minimal AttributionIndex shape — the actual implementation lives in
 * `apps/api/src/services/attribution/`. Declared here as a structural
 * interface so the integration framework doesn't depend on apps/api at
 * compile time.
 */
export interface AttributionIndexHandle {
  getById(sourceId: string): import("@openmapx/mobility-core/attribution").Attribution | undefined;
  getForMotisFile(
    filename: string,
  ): import("@openmapx/mobility-core/attribution").Attribution | undefined;
  dedupAndOrder(
    attrs: import("@openmapx/mobility-core/attribution").Attribution[],
  ): import("@openmapx/mobility-core/attribution").Attribution[];
  /** Enumerate every loaded MOTIS feed tag. */
  listMotisFeedTags(): string[];
}

export interface IntegrationContext {
  readonly id: string;
  readonly manifest: IntegrationManifest;
  readonly config: Record<string, unknown>;

  readonly http: HttpClient;
  readonly cache: CacheClient;
  readonly db?: DatabaseClient;
  readonly log: Logger;
  readonly secrets: SecretsClient;

  /**
   * Optional handle to the host's AttributionIndex. When present, providers
   * and orchestrators can resolve sourceIds against the MOTIS license.json +
   * integration-manifest dataSources without re-reading those sources.
   * Undefined when the host has not initialised an index (e.g. tests, dev
   * scripts).
   */
  readonly attributionIndex?: AttributionIndexHandle;

  /**
   * Untyped registrar for domains that don't yet have a canonical contract.
   * Currently used by: `geocoding`, `routing`, `weather`, `knowledge`,
   * `photos`, `reviews`, `poi-search`, `gtfs-catalog`. Each of these passes
   * a domain-specific provider shape; the host stores them by domain key
   * and exposes them via `getIntegrationsByDomain(domain)`. The mobility
   * data domains have typed registrars (see below) — do NOT register
   * a transit / live-transit / data-source provider via this method.
   */
  registerProvider(domain: string, provider: unknown): void;
  /**
   * Typed registrar for transit providers. Stores the provider in the same
   * slot as the legacy `registerProvider("transit", p)` for orchestrator
   * compatibility, but enforces the canonical `TransitProvider` shape at
   * compile time.
   */
  registerTransitProvider(provider: TransitProvider): void;
  /**
   * Typed registrar for realtime (live-transit) providers — vehicle
   * positions, alerts, trip updates. Stores in the same slot as the legacy
   * `registerProvider("live-transit", p)`.
   */
  registerRealtimeProvider(provider: RealtimeProvider): void;
  /**
   * Typed registrar for mobility data-source providers (bike-sharing,
   * car-sharing, scooter-sharing, parking, fuel, EV charging, webcams).
   * Stores in the same slot as the legacy `registerProvider("data-source", p)`.
   */
  registerMobilityDataSource(provider: MobilityDataSourceProvider): void;
  registerRoute(method: string, path: string, handler: RouteHandler, options?: RouteOptions): void;
  registerHealthCheck(fn: CustomHealthCheckFn): void;

  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;

  onShutdown(cleanup: () => Promise<void>): void;

  /** Query all enabled integrations registered under a domain. */
  getIntegrationsByDomain(domain: string): LoadedIntegration[];

  /**
   * Returns the resolved target for a `requires:` entry declared by this integration.
   *
   * @param key - Either a specific service slug ("valhalla") for `{ service: "valhalla" }`
   *   requirements, or a capability name ("routing-engine") for `{ capability: "routing-engine" }`
   *   requirements.
   * @returns `{ serviceId, url, enabled }` when the requirement is satisfied and the service
   *   is reachable, `null` otherwise.
   */
  getRequiredService(key: string): { serviceId: string; url: string; enabled: boolean } | null;
}
