import type { PoiSource } from "@openmapx/poi-source-registry";
import type { AirQualityProvider } from "./contracts/air-quality-provider.js";
import type { GeocodingProvider } from "./contracts/geocoding-provider.js";
import type { GtfsCatalogProvider } from "./contracts/gtfs-catalog-provider.js";
import type { KnowledgeProvider } from "./contracts/knowledge-provider.js";
import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider.js";
import type { PhotoProvider } from "./contracts/photo-provider.js";
import type { PoiSearchProvider } from "./contracts/poi-search-provider.js";
import type { RealtimeProvider } from "./contracts/realtime-provider.js";
import type { ReviewProvider } from "./contracts/review-provider.js";
import type { RideProvider } from "./contracts/ride-provider.js";
import type { RoadConditionsProvider } from "./contracts/road-conditions-provider.js";
import type { RoutingProvider } from "./contracts/routing-provider.js";
import type { AiCloudProcessor } from "./contracts/search-nlp-provider.js";
import type { SearchSuggestionProvider } from "./contracts/search-suggestion-provider.js";
import type { StreetLevelProvider } from "./contracts/street-level-imagery-provider.js";
import type { TransitProvider } from "./contracts/transit-provider.js";
import type { WeatherProvider } from "./contracts/weather-provider.js";
import type { OpaqueCursorCodec } from "./cursor";
import type { LoadedIntegration } from "./loader";
import type { IntegrationManifest } from "./manifest";
import type { RouteQuery } from "./query";
import type { UpstreamRuntime } from "./upstream-runtime";

export interface HttpClientOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Request/provider cancellation; combined with the client's own timeout. */
  signal?: AbortSignal;
  cache?: { ttl: number };
  /**
   * Abort the request after this many milliseconds. Defaults to the
   * host's shared upstream timeout (10 000 ms). Raise it explicitly for
   * legitimately slow upstreams (bulk downloads, LLM generation).
   */
  timeoutMs?: number;
  /** Maximum successful JSON response bytes. Bulk operations must opt in explicitly. */
  maxResponseBytes?: number;
}

export interface HttpResponse<T> {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: T;
}

export interface BinaryHttpResponse extends Omit<HttpResponse<never>, "body"> {
  bytes: Uint8Array;
}

export interface ResponseOptions extends HttpClientOptions {
  /** Hard ceiling applied before and while buffering the response body. */
  maxBytes: number;
  /** Exact, case-insensitive media types accepted after parameters are removed. */
  contentTypes: readonly string[];
  /** Response headers to expose. Names are matched case-insensitively and returned lowercase. */
  responseHeaders?: readonly string[];
  /** Reject redirects rather than following an untrusted upstream Location. */
  redirect?: "error";
}

export interface HttpClient {
  get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T>;
  getResponse<T = unknown>(url: string, options: ResponseOptions): Promise<HttpResponse<T>>;
  getBytes(url: string, options: ResponseOptions): Promise<BinaryHttpResponse>;
}

export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Coalesce equal cache misses. The loader receives the shared operation
   * signal; `callerSignal` cancels only that caller, and shared work is aborted
   * once no callers remain. `shouldCache` can keep a useful but degraded
   * fulfilled value out of the shared cache.
   */
  withCache<T>(
    key: string,
    ttlSeconds: number,
    fn: (operationSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    shouldCache?: (value: T) => boolean,
  ): Promise<T>;
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
  execute<T = unknown>(
    query: string,
    params?: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

export type RouteHandler = (
  req: {
    query: RouteQuery;
    params: Record<string, string>;
    body: unknown;
    /**
     * Authenticated user id. Only populated when the route was registered
     * with `{ requireAuth: true }`; the host rejects unauthenticated callers
     * with 401 before invoking the handler, so this field is non-null inside
     * auth-required handlers.
     */
    userId?: string;
    /**
     * The incoming request's HTTP headers, forwarded as-is from Fastify.
     * Node lowercases every header name when parsing the request, so read
     * `if-none-match`, not `If-None-Match`.
     */
    headers: Record<string, string | string[] | undefined>;
    /** Aborts when the caller disconnects. */
    signal?: AbortSignal;
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
  /** Host-owned limiter bucket. Every integration route uses exactly one tier. */
  rateLimitTier?: "public" | "expensive" | "tile";
}

export interface HealthCheckResult {
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

export type CustomHealthCheckFn = () => Promise<HealthCheckResult>;

/**
 * A secret-free, server-computed legal disclosure signal surfaced to the
 * client on /api/integrations. Processor metadata only — never config or secrets.
 */
export interface AiSearchDisclosure {
  type: "ai-search";
  integrationId: string;
  /** Any AI provider (local or cloud) active → show the Terms AI disclaimer. */
  aiActive: boolean;
  localActive: boolean;
  /** A cloud provider configured + in chain → show the Privacy data-transfer row. */
  cloudActive: boolean;
  cloudProcessors: AiCloudProcessor[];
  /** Cloud execution is permitted by the instance privacy policy. */
  cloudAvailable: boolean;
  /** The client must obtain an explicit opt-in before sending a query to cloud AI. */
  cloudConsentRequired: boolean;
  /** Secret-free, operator-facing labels for the configured cloud provider chain. */
  cloudProviderLabels: string[];
}

export type EmailProvider = "emaillabs" | "lettermint" | "smtp";
/** Art. 44+ transfer safeguard for a non-EEA recipient. */
export type TransferSafeguard = "eea" | "adequacy" | "dpf" | "scc" | "none";

/**
 * The transactional-email provider currently active for this instance, so the
 * Privacy Policy can name the correct processor. Vendor metadata only — never
 * keys or SMTP credentials.
 */
export interface EmailDisclosure {
  type: "email";
  provider: EmailProvider;
  /** Human-readable vendor name; empty for an unnamed self-hosted SMTP server. */
  vendorName: string;
  /** ISO 3166-1 alpha-2 country code for localization ("PL", "NL", "US"); empty if unknown. */
  countryCode: string;
  privacyUrl?: string;
  transfer: TransferSafeguard;
}

export type Disclosure = AiSearchDisclosure | EmailDisclosure;

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
export type ProviderHealthCountedOutcome =
  | "timeout"
  | "connection"
  | "upstream_5xx"
  | "auth"
  | "invalid_payload";

export type ProviderHealthNonCountedOutcome =
  | "valid_empty"
  | "policy"
  | "input"
  | "quota"
  | "caller_cancelled";

export type ProviderHealthFailureOutcome =
  | ProviderHealthCountedOutcome
  | ProviderHealthNonCountedOutcome;

export interface ProviderHealthSnapshot {
  state: "healthy" | "degraded" | "open" | "half-open";
  successCount: number;
  failureCount: number;
  countedFailureCount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  windowFailureRate: number | null;
  emaLatencyMs: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureOutcome: ProviderHealthFailureOutcome | null;
  lastOperatorMessage: string | null;
  retryAt: string | null;
  ownsHalfOpenProbe: boolean;
  diagnostic?: "store_unavailable" | "invalid_record";
}

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
  recordFailure(
    providerId: string,
    latencyMs: number,
    outcome: ProviderHealthFailureOutcome,
    operatorMessage?: string,
  ): Promise<void>;
  /** Read the deterministic state and atomically claim an eligible half-open probe. */
  getSnapshot(providerId: string): Promise<ProviderHealthSnapshot>;
}

/**
 * Minimal MetricsRecorder shape — the actual implementation lives in
 * `apps/api/src/services/metrics/`. Declared here as a structural interface
 * so the integration framework doesn't depend on apps/api at compile time.
 *
 * Outcome labels follow a closed enum: `"ok"` (call returned a value),
 * `"empty"` (call succeeded but returned null / empty list), `"error"` (call
 * threw / rejected), `"timeout"` and `"cancelled"` (deadline and caller
 * cancellation respectively), or `"skipped"` (orchestrator pre-flight
 * skipped the call before invoking the provider).
 */
export type ProviderCallOutcome = "ok" | "empty" | "error" | "skipped" | "timeout" | "cancelled";

export interface AirQualityMetrics {
  method: "current" | "forecast" | "stations" | "pollutants" | "raster-times" | "raster-tile";
  outcome: "ok" | "partial" | "empty" | "unavailable" | "rejected" | "error";
  cacheResult: "fresh" | "stale" | "stale-if-error" | "miss" | "bypass";
  headlineClass: "official" | "computed-ground" | "raw-ground" | "hybrid" | "model" | "none";
  rejectionCode:
    | "none"
    | "wrong-standard"
    | "unverified-method"
    | "invalid-schema"
    | "invalid-time"
    | "incomplete-window"
    | "incoherent-evidence"
    | "policy"
    | "quota";
  compatibilityUse: "none" | "legacy-openaq" | "legacy-open-meteo";
  quotaTruncated: boolean;
  evidenceCount: number;
  latencyMs: number;
}

export interface AirQualityProviderCallMetrics {
  providerId: string;
  method: "current" | "forecast" | "stations" | "raster-times" | "raster-tile";
  outcome: ProviderCallOutcome;
  cacheResult:
    | "fresh"
    | "stale"
    | "stale-if-error"
    | "miss"
    | "bypass"
    | "provider-managed"
    | "unknown";
  suppression: "none" | "health" | "policy";
  latencyMs: number;
}

export interface AirQualityRasterMetrics {
  state: "current" | "stale" | "unavailable";
  ageSeconds: number;
}

export type TransitDecisionOperation = "plan" | "routes" | "refresh" | "realtime";
export type TransitDecisionReason =
  | "selected"
  | "authoritative_empty"
  | "transport_failure"
  | "unsupported"
  | "refresh_success"
  | "refresh_fallback"
  | "realtime_complete";

export interface TransitReachabilityMetrics {
  operation: "capabilities" | "surface" | "exact";
  source: "self-hosted-motis" | "transitous" | "none";
  capabilityState:
    | "available"
    | "operator-disabled"
    | "hosted-source"
    | "street-routing-disabled"
    | "endpoint-unverified"
    | "runtime-unhealthy";
  outcome: "ok" | "unavailable" | "error" | "timeout" | "cancelled";
  cacheOutcome: "hit" | "miss" | "none";
  errorKind: "none" | "unavailable" | "timeout" | "invalid-response" | "unsupported" | "upstream";
  latencyMs: number;
  rawSeedCount?: number;
  seedCount?: number;
  gridMetres?: number;
  destinationCount?: number;
  batchCount?: number;
}

export interface MetricsRecorder {
  recordProviderCall(
    labels: { providerId: string; method: string; outcome: ProviderCallOutcome },
    latencyMs: number,
  ): void;
  recordTransitDecision?(
    labels: {
      operation: TransitDecisionOperation;
      providerId: string;
      role: "baseline" | "fallback" | "enrichment" | "regional" | "none";
      reason: TransitDecisionReason;
    },
    value?: number,
  ): void;
  recordTransitReachability?(metrics: TransitReachabilityMetrics): void;
  /**
   * Record the end-to-end result of a routing request. The host implementation
   * keeps these labels bounded to provider/mode/operation and uses the values
   * for route-count, latency, and traffic-baseline observability.
   */
  recordRoutingRequest?(metrics: {
    providerId: string;
    mode: string;
    operation: "directions" | "optimize";
    outcome: "ok" | "error";
    liveTraffic: boolean;
    closureAvoidance: boolean;
    latencyMs: number;
    routeCount?: number;
    alternateCount?: number;
    trafficDelaySeconds?: number;
    baselineAvailable: boolean;
  }): void;
  recordAirQuality?(metrics: AirQualityMetrics): void;
  recordAirQualityProviderCall?(metrics: AirQualityProviderCallMetrics): void;
  recordAirQualityRasterAge?(metrics: AirQualityRasterMetrics): void;
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

  /** Host-signed, purpose-scoped cursor codec. Absent when no server signing secret is configured. */
  readonly cursorCodec?: OpaqueCursorCodec;

  /** Distributed cache/lease/quota runtime. Absent when no production store is configured. */
  readonly upstreamRuntime?: UpstreamRuntime;

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
  /** Typed registrar for air-quality evidence providers. Stored under the `air-quality` key. */
  registerAirQualityProvider(provider: AirQualityProvider): void;
  /** Typed registrar for geocoding providers. Stored under the `geocoding` key. */
  registerGeocodingProvider(provider: GeocodingProvider): void;
  /** Typed registrar for routing providers. Stored under the `routing` key. */
  registerRoutingProvider(provider: RoutingProvider): void;
  /**
   * Typed registrar for ride-hailing providers. Stored under the
   * `ride-hailing` key; the `ride-hailing` orchestrator collects them.
   */
  registerRideProvider(provider: RideProvider): void;
  /**
   * Typed registrar for road-conditions providers (live incidents, roadworks,
   * closures, hazards). Stored under the `road-conditions` key; the
   * `road-conditions` orchestrator merges all registered providers.
   */
  registerRoadConditionsProvider(provider: RoadConditionsProvider): void;
  /** Typed registrar for photo providers. Stored under the `photos` key. */
  registerPhotoProvider(provider: PhotoProvider): void;
  /** Typed registrar for street-level imagery providers. Stored under the `street-level-imagery` key. */
  registerStreetLevelProvider(provider: StreetLevelProvider): void;
  /** Typed registrar for review providers. Stored under the `reviews` key. */
  registerReviewProvider(provider: ReviewProvider): void;
  /** Typed registrar for POI search providers. Stored under the `poi-search` key. */
  registerPoiSearchProvider(provider: PoiSearchProvider): void;
  /** Typed registrar for unified search suggestion providers. Stored under `search-suggestions`. */
  registerSearchSuggestionProvider(provider: SearchSuggestionProvider): void;
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

  /**
   * Publish a synchronous process-wide runtime mutation with this integration
   * generation. During a hot reload the host defers the callback until every
   * integration has staged successfully; during initial startup it runs now.
   * A rollback restores the prior state if the candidate generation is discarded.
   */
  onActivate(activate: () => void, rollback?: () => void): void;
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
