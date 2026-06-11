import type { PoiSource } from "@openmapx/poi-source-registry";
import type { GeocodingProvider } from "./contracts/geocoding-provider.js";
import type { GtfsCatalogProvider } from "./contracts/gtfs-catalog-provider.js";
import type { KnowledgeProvider } from "./contracts/knowledge-provider.js";
import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider.js";
import type { PhotoProvider } from "./contracts/photo-provider.js";
import type { PoiSearchProvider } from "./contracts/poi-search-provider.js";
import type { RealtimeProvider } from "./contracts/realtime-provider.js";
import type { ReviewProvider } from "./contracts/review-provider.js";
import type { RoutingProvider } from "./contracts/routing-provider.js";
import type { TransitProvider } from "./contracts/transit-provider.js";
import type { WeatherProvider } from "./contracts/weather-provider.js";
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

/**
 * Cross-process hash-store reader for the shared `poi:live:<sourceId>`
 * keyspace written by services/data-manager.
 *
 * Distinct from `CacheClient` because the keys are NOT integration-namespaced
 * — `data-manager` knows nothing about integration ids, only the source ids
 * registered in `@openmapx/poi-source-registry`. The host must NOT prefix
 * the key with `int:<integration>:` or reads will silently miss the writes.
 *
 * Currently only `createTwoTierPoiReader` uses this; widen the interface if
 * other shared Redis structures emerge.
 */
export interface LiveStoreClient {
  /**
   * Bulk-read fields from a Redis hash at the literal `key` (no prefixing).
   * Returns one entry per requested field, in the same order; null for
   * missing fields. JSON-decoded; values written via Redis `HSET` with a
   * JSON-stringified payload (data-manager's `write-live` stage) decode cleanly.
   */
  hmget<T = unknown>(key: string, fields: readonly string[]): Promise<(T | null)[]>;
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

export type CloudAiVendor = "anthropic" | "openai";

/**
 * A secret-free, server-computed legal disclosure signal surfaced to the
 * client on /api/integrations. Booleans + vendor names only — never config or
 * secrets.
 */
export interface AiSearchDisclosure {
  type: "ai-search";
  integrationId: string;
  /** Any AI provider (local or cloud) active → show the Terms AI disclaimer. */
  aiActive: boolean;
  localActive: boolean;
  /** A cloud provider configured + in chain → show the Privacy data-transfer row. */
  cloudActive: boolean;
  cloudVendors: CloudAiVendor[];
}
export type Disclosure = AiSearchDisclosure;

export interface SecretsClient {
  /** Retrieve a decrypted secret from the vault, or null if not stored. */
  get(key: string): Promise<string | null>;
}

/**
 * Minimal ProviderHealthHandle shape — the actual implementation lives in
 * `apps/api/src/services/provider-health/`. Declared here as a structural
 * interface so the integration framework doesn't depend on apps/api at
 * compile time.
 *
 * Orchestrators consult the handle before dispatching a provider call and
 * record success/failure (with timing) afterwards. Persistence + sliding
 * window failure rate live in the host implementation.
 */
export interface ProviderHealthHandle {
  /** Returns false when the provider is currently in cooldown. */
  isHealthy(providerId: string): Promise<boolean>;
  /** Record a successful call with its measured latency. */
  recordSuccess(providerId: string, latencyMs: number): Promise<void>;
  /**
   * Record a failed call. `reason` is truncated to 200 chars on the host.
   * `latencyMs` is the wall-clock time elapsed before the failure surfaced
   * (so timeouts still contribute to the EMA).
   */
  recordFailure(providerId: string, latencyMs: number, reason: string): Promise<void>;
}

/**
 * Minimal MetricsRecorder shape — the actual implementation lives in
 * `apps/api/src/services/metrics/`. Declared here as a structural interface
 * so the integration framework doesn't depend on apps/api at compile time.
 *
 * Outcome labels follow a closed enum: `"ok"` (call returned a value),
 * `"empty"` (call succeeded but returned null / empty list), `"error"` (call
 * threw / rejected), `"skipped"` (orchestrator pre-flight skipped the call
 * before invoking the provider, e.g. due to a health cooldown or a
 * capability mismatch).
 */
export type ProviderCallOutcome = "ok" | "empty" | "error" | "skipped";

export interface MetricsRecorder {
  recordProviderCall(
    labels: { providerId: string; method: string; outcome: ProviderCallOutcome },
    latencyMs: number,
  ): void;
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
  /**
   * Reader for the shared cross-process `poi:live:<sourceId>` keyspace
   * written by `services/data-manager`. Distinct from `cache` because
   * it must not be integration-namespaced. See `LiveStoreClient`.
   */
  readonly liveStore: LiveStoreClient;
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
   * Optional handle to the host's persistent ProviderHealth tracker. When
   * present, orchestrators record latency + outcome per call so the host can
   * compute sliding-window failure rates and auto-disable misbehaving
   * providers across process restarts. Undefined in tests / dev scripts; the
   * orchestrator treats the absence as "all providers healthy".
   */
  readonly providerHealth?: ProviderHealthHandle;

  /**
   * Optional handle to the host's OpenTelemetry metrics recorder. When
   * present, orchestrators bump a per-call counter + histogram alongside the
   * provider-health write — same `(providerId, method, outcome)` labels both
   * places. Undefined when the host has not wired OTEL (tests, CLI scripts).
   */
  readonly metricsRecorder?: MetricsRecorder;

  /**
   * Typed registrar for transit providers — enforces the canonical
   * `TransitProvider` shape at compile time. Registered providers are stored
   * under the `transit` domain key.
   */
  registerTransitProvider(provider: TransitProvider): void;
  /**
   * Typed registrar for realtime (live-transit) providers — vehicle
   * positions, alerts, trip updates. Stored under the `live-transit` key.
   */
  registerRealtimeProvider(provider: RealtimeProvider): void;
  /**
   * Typed registrar for mobility data-source providers (bike-sharing,
   * car-sharing, scooter-sharing, parking, fuel, EV charging, webcams).
   * Stored under the `data-source` key.
   */
  registerMobilityDataSource(provider: MobilityDataSourceProvider): void;
  /** Typed registrar for weather providers. Stored under the `weather` key. */
  registerWeatherProvider(provider: WeatherProvider): void;
  /** Typed registrar for geocoding providers. Stored under the `geocoding` key. */
  registerGeocodingProvider(provider: GeocodingProvider): void;
  /** Typed registrar for routing providers. Stored under the `routing` key. */
  registerRoutingProvider(provider: RoutingProvider): void;
  /** Typed registrar for photo providers. Stored under the `photos` key. */
  registerPhotoProvider(provider: PhotoProvider): void;
  /** Typed registrar for review providers. Stored under the `reviews` key. */
  registerReviewProvider(provider: ReviewProvider): void;
  /** Typed registrar for POI search providers. Stored under the `poi-search` key. */
  registerPoiSearchProvider(provider: PoiSearchProvider): void;
  /** Typed registrar for knowledge providers. Stored under the `knowledge` key. */
  registerKnowledgeProvider(provider: KnowledgeProvider): void;
  /** Typed registrar for GTFS catalog providers. Stored under the `gtfs-catalog` key. */
  registerGtfsCatalogProvider(provider: GtfsCatalogProvider): void;
  /**
   * Typed registrar for POI sources (EV charging, parking, etc.) that the
   * data-manager ingest pipeline consumes. The host forwards to the shared
   * `@openmapx/poi-source-registry` store; the same store is read by both
   * the data-source provider chain on apps/api and the ingest scheduler on
   * data-manager. Re-registering an id (within one integration or across
   * two) is warn-and-drop, not throw — operator drift surfaces in the admin
   * UI rather than crashing the host.
   */
  registerPoiSources(sources: readonly PoiSource[]): void;
  registerRoute(method: string, path: string, handler: RouteHandler, options?: RouteOptions): void;
  registerHealthCheck(fn: CustomHealthCheckFn): void;
  registerDisclosure(disclosure: Disclosure): void;

  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;

  onShutdown(cleanup: () => Promise<void>): void;

  /** Query all enabled integrations registered under a domain. */
  getIntegrationsByDomain(domain: string): LoadedIntegration[];

  /**
   * Source IDs (`dataSources[].sourceId`) currently disallowed by the operator's
   * data-use policy (non-commercial / grey-area). Orchestrators should skip
   * providers whose source is in this set and fall back to the next. Empty when
   * the policy permits everything; absent on hosts that don't enforce a policy.
   */
  getDisallowedSourceIds?(): Promise<Set<string>>;

  /**
   * Integration ids whose data sources are entirely disallowed by the operator's
   * data-use policy. Orchestrators that key on the integration/provider rather
   * than a per-item `source` field (transit, knowledge) skip providers belonging
   * to these integrations and fall back to the next. Empty when the policy permits
   * everything; absent on hosts that don't enforce a policy.
   */
  getDisallowedIntegrationIds?(): Promise<Set<string>>;

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
