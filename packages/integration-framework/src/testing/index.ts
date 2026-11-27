import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FetchJsonHttpError } from "@openmapx/core/http/fetch-json-error";
import { parseRetryAfterMs } from "@openmapx/core/retry-after";
import { extensionSchemaName } from "@openmapx/extension-contracts/identifiers";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type {
  MobilityHttpRequestOptions,
  MobilityHttpTransport,
} from "@openmapx/mobility-core/json-transport";
import { runImmediateActivation } from "../activation-transaction";
import type {
  AttributionIndexHandle,
  BinaryHttpResponse,
  CacheClient,
  CustomHealthCheckFn,
  DatabaseClient,
  Disclosure,
  HttpClient,
  HttpClientOptions,
  HttpResponse,
  IntegrationContext,
  Logger,
  ResponseOptions,
  RouteHandler,
  RouteOptions,
  SecretsClient,
  StreamHttpResponse,
} from "../context.js";
import type { AirQualityProvider } from "../contracts/air-quality-provider.js";
import type { BorderCrossingProvider } from "../contracts/border-crossing-provider.js";
import type { CameraProvider } from "../contracts/camera-provider.js";
import type { ChargingSiteProvider } from "../contracts/charging-site-provider.js";
import type { FuelStationProvider } from "../contracts/fuel-station-provider.js";
import type { GeocodingProvider } from "../contracts/geocoding-provider.js";
import type { GtfsCatalogProvider } from "../contracts/gtfs-catalog-provider.js";
import type { HazardsProvider } from "../contracts/hazards-provider.js";
import type { KnowledgeProvider } from "../contracts/knowledge-provider.js";
import type { LandmarkModelProvider } from "../contracts/landmark-model-provider.js";
import type { MessageSignProvider } from "../contracts/message-sign-provider.js";
import type { MobilityDataSourceProvider } from "../contracts/mobility-data-source-provider.js";
import type { ParkingSiteProvider } from "../contracts/parking-site-provider.js";
import type { PhotoProvider } from "../contracts/photo-provider.js";
import type { PoiSearchProvider } from "../contracts/poi-search-provider.js";
import {
  PROVIDER_SHAPES,
  type ProviderDomain,
  type ProviderRegistrar,
} from "../contracts/provider-shapes";
import type { RealtimeProvider } from "../contracts/realtime-provider.js";
import type { ReviewProvider } from "../contracts/review-provider.js";
import type { RideProvider } from "../contracts/ride-provider.js";
import type { RoadConditionsProvider } from "../contracts/road-conditions-provider.js";
import type { RoadWeatherProvider } from "../contracts/road-weather-provider.js";
import type { RoutingProvider } from "../contracts/routing-provider.js";
import type { SearchSuggestionProvider } from "../contracts/search-suggestion-provider.js";
import type { ServiceVehicleProvider } from "../contracts/service-vehicle-provider.js";
import type { StreetLevelProvider } from "../contracts/street-level-imagery-provider.js";
import type { TransitProvider } from "../contracts/transit-provider.js";
import type { WeatherProvider } from "../contracts/weather-provider.js";
import { type IntegrationDataSource, validateDataSource } from "../manifest";
import { resolveIntegrationPlatformEndpoint } from "../platform-endpoints";
import { providerOrderFingerprintInput, readProviderOrder } from "../provider-order";
import { createProviderRegistrationCheck } from "../provider-registration";
import { storedRouteHandler } from "../route-handler";

export interface FakeMobilityHttpRequest {
  kind: "json" | "text";
  url: string;
  options?: MobilityHttpRequestOptions;
}

export interface FakeMobilityHttpTransport extends MobilityHttpTransport {
  readonly calls: FakeMobilityHttpRequest[];
}

export function fakeMobilityHttpTransport(
  responder: (request: FakeMobilityHttpRequest) => unknown | Promise<unknown>,
): FakeMobilityHttpTransport {
  const calls: FakeMobilityHttpRequest[] = [];
  return {
    calls,
    userAgent: "OpenMapX/test",
    async fetchJson<T>(url: string, options?: MobilityHttpRequestOptions): Promise<T> {
      const request: FakeMobilityHttpRequest = { kind: "json", url, options };
      calls.push(request);
      return (await responder(request)) as T;
    },
    async fetchText(url: string, options?: MobilityHttpRequestOptions): Promise<string> {
      const request: FakeMobilityHttpRequest = { kind: "text", url, options };
      calls.push(request);
      const response = await responder(request);
      if (typeof response !== "string") {
        throw new TypeError("fakeMobilityHttpTransport: text response must be a string");
      }
      return response;
    },
    hostMatchesAllowlist: (hostname, pattern) =>
      pattern.startsWith("*.")
        ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
        : hostname === pattern,
    privateFeedHostAllowlist: () => [],
  };
}

/**
 * Shared test harness for integration code. Deliberately free of any test
 * runner (`vitest`/`vi`) so it can be imported from any test file or the
 * runtime loader without pulling a dev dependency. Spies/assertions are the
 * caller's concern — pass your own `vi.fn()` as an override when you need one.
 *
 * Promotes the per-file fakes (`makeCtx`/`makeCache`/`makeLogger`) that
 * integration tests used to re-invent.
 */

export interface FakeHttpRequest {
  method:
    | "get"
    | "post"
    | "getResponse"
    | "postResponse"
    | "getBytes"
    | "getText"
    | "postText"
    | "getStream";
  url: string;
  body?: unknown;
  options?: HttpClientOptions | ResponseOptions;
}

/**
 * Either a function that maps a request to a response, or a map of
 * url-substring → response (first matching substring wins).
 */
export type FakeHttpResponder = ((req: FakeHttpRequest) => unknown) | Record<string, unknown>;

export interface FakeHttpClient extends HttpClient {
  /** Every request seen, in order — assert against this. */
  readonly calls: FakeHttpRequest[];
}

/** A canned upstream status with no body. Create it with {@link httpStatus}. */
class FakeHttpStatus {
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    readonly status: number,
    headers: Record<string, string> = {},
  ) {
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
  }
}

/**
 * Canned upstream status for {@link fakeHttpClient}. `get` and `post` reject
 * with the host's `FetchJsonHttpError` (status and `Retry-After` delay) when it
 * is not 2xx; the response methods return it with an empty body. Header names
 * are lowercased, as the host returns them.
 */
export function httpStatus(status: number, headers?: Record<string, string>): FakeHttpStatus {
  return new FakeHttpStatus(status, headers);
}

function jsonBody<T>(value: unknown): T {
  if (value instanceof FakeHttpStatus) {
    if (value.status >= 200 && value.status < 300) return undefined as T;
    throw new FetchJsonHttpError(
      `HTTP ${value.status}`,
      value.status,
      parseRetryAfterMs(value.headers["retry-after"]) ?? undefined,
    );
  }
  return value as T;
}

/** A canned `{ status, headers, body }` passes through; any other value is a 200 body. */
function asHttpResponse<T>(value: unknown): HttpResponse<T> {
  if (value instanceof FakeHttpStatus) {
    return { status: value.status, headers: value.headers, body: "" as T };
  }
  if (
    value &&
    typeof value === "object" &&
    "status" in value &&
    "headers" in value &&
    "body" in value
  ) {
    return value as HttpResponse<T>;
  }
  return { status: 200, headers: {}, body: value as T };
}

/**
 * An `HttpClient` that returns canned responses and records every call.
 * Unmatched requests throw, so an integration that reaches an un-stubbed
 * endpoint fails loudly instead of hitting the network.
 */
export function fakeHttpClient(responder: FakeHttpResponder = {}): FakeHttpClient {
  const calls: FakeHttpRequest[] = [];
  const resolve = (req: FakeHttpRequest): unknown => {
    if (typeof responder === "function") return responder(req);
    for (const [pattern, value] of Object.entries(responder)) {
      if (req.url.includes(pattern)) return value;
    }
    throw new Error(
      `fakeHttpClient: no canned response for ${req.method.toUpperCase()} ${req.url}`,
    );
  };
  return {
    calls,
    async get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T> {
      const req: FakeHttpRequest = { method: "get", url, options };
      calls.push(req);
      return jsonBody<T>(await resolve(req));
    },
    async post<T = unknown>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T> {
      const req: FakeHttpRequest = { method: "post", url, body, options };
      calls.push(req);
      return jsonBody<T>(await resolve(req));
    },
    async getResponse<T = unknown>(
      url: string,
      options: ResponseOptions,
    ): Promise<HttpResponse<T>> {
      const req: FakeHttpRequest = { method: "getResponse", url, options };
      calls.push(req);
      return asHttpResponse<T>(await resolve(req));
    },
    async postResponse<T = unknown>(
      url: string,
      body: unknown,
      options: ResponseOptions,
    ): Promise<HttpResponse<T>> {
      const req: FakeHttpRequest = { method: "postResponse", url, body, options };
      calls.push(req);
      return asHttpResponse<T>(await resolve(req));
    },
    async getBytes(url: string, options: ResponseOptions): Promise<BinaryHttpResponse> {
      const req: FakeHttpRequest = { method: "getBytes", url, options };
      calls.push(req);
      const value = await resolve(req);
      if (value instanceof FakeHttpStatus) {
        return { status: value.status, headers: value.headers, bytes: new Uint8Array() };
      }
      if (
        value &&
        typeof value === "object" &&
        "status" in value &&
        "headers" in value &&
        "bytes" in value
      ) {
        return value as BinaryHttpResponse;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(
          "fakeHttpClient: getBytes response must be Uint8Array or BinaryHttpResponse",
        );
      }
      return { status: 200, headers: {}, bytes: value };
    },
    async getText(url: string, options: ResponseOptions): Promise<HttpResponse<string>> {
      const req: FakeHttpRequest = { method: "getText", url, options };
      calls.push(req);
      return asHttpResponse<string>(await resolve(req));
    },
    async postText(
      url: string,
      body: string,
      options: ResponseOptions,
    ): Promise<HttpResponse<string>> {
      const req: FakeHttpRequest = { method: "postText", url, body, options };
      calls.push(req);
      return asHttpResponse<string>(await resolve(req));
    },
    async getStream(url: string, options: ResponseOptions): Promise<StreamHttpResponse> {
      const req: FakeHttpRequest = { method: "getStream", url, options };
      calls.push(req);
      const value = await resolve(req);
      if (value instanceof FakeHttpStatus) {
        return {
          status: value.status,
          headers: value.headers,
          stream: new ReadableStream({ start: (controller) => controller.close() }),
        };
      }
      if (
        value &&
        typeof value === "object" &&
        "status" in value &&
        "headers" in value &&
        "stream" in value
      ) {
        return value as StreamHttpResponse;
      }
      if (!(value instanceof ReadableStream)) {
        throw new TypeError(
          "fakeHttpClient: getStream response must be ReadableStream or StreamHttpResponse",
        );
      }
      return { status: 200, headers: {}, stream: value };
    },
  };
}

export interface RecordedReply {
  status: number;
  body: unknown;
  /** Header names lowercased. */
  headers: Record<string, string>;
  contentType?: string;
}

/** A route reply that records what a handler sent. The status defaults to 200. */
export function createRecordingReply(): {
  reply: Parameters<RouteHandler>[1];
  result: RecordedReply;
} {
  const result: RecordedReply = { status: 200, body: undefined, headers: {} };
  const send = (data: unknown) => {
    result.body = data;
  };
  return {
    result,
    reply: {
      send,
      status: (code) => {
        result.status = code;
        return { send };
      },
      header: (name, value) => {
        result.headers[name.toLowerCase()] = value;
      },
      type: (contentType) => {
        result.contentType = contentType;
      },
    },
  };
}

/**
 * The `ctx.db` the host would give an integration with `manifest`: none when
 * it neither requires PostGIS nor ships migrations, and the schema it owns
 * when it ships them. Its methods reject until a test passes its own `db`.
 */
function unstubbedDatabase(
  id: string,
  manifest: IntegrationContext["manifest"],
): DatabaseClient | undefined {
  const ownsSchema = manifest.database?.migrations === true;
  if (!ownsSchema && !manifest.requires?.some((requirement) => requirement.service === "postgis")) {
    return undefined;
  }
  const notStubbed = async (): Promise<never> => {
    throw new Error("createMockIntegrationContext: database not stubbed — pass { db }");
  };
  return {
    execute: notStubbed,
    transaction: notStubbed,
    ...(ownsSchema ? { schema: extensionSchemaName(id) } : {}),
  };
}

/**
 * `db` with the host's transaction rules: transactions run one at a time, in
 * the order they were called, and a `transaction` started inside the
 * callback of another one is refused, as the host refuses it, so a test
 * catches a nested call that would wait forever in the host and never passes
 * on an interleaving the host does not produce.
 */
function withHostTransactionRules(db: DatabaseClient): DatabaseClient {
  const insideTransaction = new AsyncLocalStorage<{ open: boolean }>();
  // Settles once the last transaction called so far has settled.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    execute: (...args) => db.execute(...args),
    transaction: (fn, options) => {
      if (insideTransaction.getStore()?.open) {
        return Promise.reject(
          new Error(
            "Nested transactions are not supported; use the transaction passed to the callback",
          ),
        );
      }
      const inside = { open: true };
      const result = queue
        .then(() => db.transaction((tx) => insideTransaction.run(inside, () => fn(tx)), options))
        .finally(() => {
          inside.open = false;
        });
      queue = result.catch(() => {});
      return result;
    },
    ...(db.schema === undefined ? {} : { schema: db.schema }),
  };
}

/** A `Logger` that swallows everything. Override per-call to assert. */
export function createNoopLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * A pass-through `CacheClient`: reads always miss and `withCache` always
 * runs its factory, so a cached path is exercised end-to-end without a real
 * store hiding work from call-count assertions.
 */
export function createPassthroughCache(): CacheClient {
  return {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
    withCache: async <T>(
      _key: string,
      _ttl: number,
      fn: (operationSignal: AbortSignal) => Promise<T>,
    ) => fn(new AbortController().signal),
  };
}

/** An in-memory `CacheClient` that models the host's administrative clear fence. */
export interface FencedMemoryCache extends CacheClient {
  /** Stored values by key. Reads return copies. */
  readonly values: Map<string, unknown>;
  /** TTL in seconds of the last accepted write per key. */
  readonly ttls: Map<string, number | undefined>;
  /** Admin clear: drops every entry and advances the invalidation epoch. */
  clear(): void;
}

/**
 * Mirrors the managed host: `captureWriter` and `withCache` capture the
 * invalidation epoch before acquisition and drop a write once a clear has
 * advanced it, while a direct `set` fences only its own invocation, so a late
 * direct write refills a cleared cache.
 */
export function createFencedMemoryCache(): FencedMemoryCache {
  const values = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  let epoch = 0;
  const writeIfCurrent = (captured: number, key: string, value: unknown, ttl?: number) => {
    if (captured !== epoch) return;
    values.set(key, structuredClone(value));
    ttls.set(key, ttl);
  };
  const get = async <T>(key: string): Promise<T | null> =>
    values.has(key) ? structuredClone(values.get(key) as T) : null;
  return {
    values,
    ttls,
    clear() {
      values.clear();
      ttls.clear();
      epoch += 1;
    },
    async captureWriter() {
      const captured = epoch;
      return { set: async (key, value, ttl) => writeIfCurrent(captured, key, value, ttl) };
    },
    get,
    async set(key, value, ttl) {
      writeIfCurrent(epoch, key, value, ttl);
    },
    async del(key) {
      values.delete(key);
      ttls.delete(key);
    },
    async withCache<T>(
      key: string,
      ttl: number,
      fn: (operationSignal: AbortSignal) => Promise<T>,
      _callerSignal?: AbortSignal,
      shouldCache?: (value: T) => boolean,
    ): Promise<T> {
      const captured = epoch;
      const cached = await get<T>(key);
      if (cached !== null && (shouldCache?.(cached) ?? true)) return cached;
      const result = await fn(new AbortController().signal);
      if (shouldCache?.(result) ?? true) writeIfCurrent(captured, key, result, ttl);
      return result;
    },
  };
}

/** Every provider/route/source an integration registered during `setup()`. */
export interface CapturedRegistrations {
  transit: TransitProvider[];
  realtime: RealtimeProvider[];
  mobilityDataSource: MobilityDataSourceProvider[];
  weather: WeatherProvider[];
  airQuality: AirQualityProvider[];
  geocoding: GeocodingProvider[];
  routing: RoutingProvider[];
  ride: RideProvider[];
  roadConditions: RoadConditionsProvider[];
  fuelStations: FuelStationProvider[];
  parkingSites: ParkingSiteProvider[];
  chargingSites: ChargingSiteProvider[];
  cameras: CameraProvider[];
  messageSigns: MessageSignProvider[];
  landmarkModels: LandmarkModelProvider[];
  roadWeather: RoadWeatherProvider[];
  serviceVehicles: ServiceVehicleProvider[];
  borderCrossings: BorderCrossingProvider[];
  hazards: HazardsProvider[];
  photo: PhotoProvider[];
  streetLevel: StreetLevelProvider[];
  review: ReviewProvider[];
  poiSearch: PoiSearchProvider[];
  searchSuggestions: SearchSuggestionProvider[];
  knowledge: KnowledgeProvider[];
  gtfsCatalog: GtfsCatalogProvider[];
  routes: { method: string; path: string; handler: RouteHandler; options?: RouteOptions }[];
  healthChecks: CustomHealthCheckFn[];
  disclosures: Disclosure[];
  /** Every list passed to `setDataSources()`, in call order. */
  dataSourceLists: IntegrationDataSource[][];
}

export interface MockContextOverrides {
  id?: string;
  config?: Record<string, unknown>;
  http?: HttpClient;
  cache?: CacheClient;
  secrets?: SecretsClient;
  db?: DatabaseClient;
  log?: Logger;
  manifest?: IntegrationContext["manifest"];
  /** Required services the host has running, by service id, each with its URL. */
  requiredServices?: Record<string, string>;
  /** The operator's provider order, by domain; empty for a domain not named. */
  providerOrder?: Record<string, readonly string[]>;
}

export interface MockIntegrationContext extends IntegrationContext {
  /** Captured registrations from `setup()` — drives contract conformance. */
  readonly registered: CapturedRegistrations;
}

/**
 * Build an `IntegrationContext` backed by inert fakes. Pass overrides for
 * the pieces a test cares about (typically `config` + `http`). The returned
 * `registered` collects everything `setup(ctx)` wires up, which is how the
 * repo-wide provider-contract conformance test inspects real integrations.
 */
export function createMockIntegrationContext(
  overrides: MockContextOverrides = {},
): MockIntegrationContext {
  const registered: CapturedRegistrations = {
    transit: [],
    realtime: [],
    mobilityDataSource: [],
    weather: [],
    airQuality: [],
    geocoding: [],
    routing: [],
    ride: [],
    roadConditions: [],
    fuelStations: [],
    parkingSites: [],
    chargingSites: [],
    cameras: [],
    messageSigns: [],
    landmarkModels: [],
    roadWeather: [],
    serviceVehicles: [],
    borderCrossings: [],
    hazards: [],
    photo: [],
    streetLevel: [],
    review: [],
    poiSearch: [],
    searchSuggestions: [],
    knowledge: [],
    gtfsCatalog: [],
    routes: [],
    healthChecks: [],
    disclosures: [],
    dataSourceLists: [],
  };
  const noop = () => undefined;
  const id = overrides.id ?? "test-integration";
  const manifest = overrides.manifest ?? ({} as IntegrationContext["manifest"]);
  const db = overrides.db ?? unstubbedDatabase(id, manifest);
  const ctx: MockIntegrationContext = {
    id,
    manifest,
    config: overrides.config ?? {},
    http:
      overrides.http ??
      fakeHttpClient(() => {
        throw new Error(
          "createMockIntegrationContext: HTTP not stubbed — pass { http: fakeHttpClient(...) }",
        );
      }),
    cache: overrides.cache ?? createPassthroughCache(),
    db: db && withHostTransactionRules(db),
    log: overrides.log ?? createNoopLogger(),
    secrets: overrides.secrets ?? { get: async () => null },
    registered,
    registerTransitProvider: (p) => {
      registered.transit.push(p);
    },
    registerRealtimeProvider: (p) => {
      registered.realtime.push(p);
    },
    registerMobilityDataSource: (p) => {
      registered.mobilityDataSource.push(p);
    },
    registerWeatherProvider: (p) => {
      registered.weather.push(p);
    },
    registerAirQualityProvider: (p) => {
      registered.airQuality.push(p);
    },
    registerGeocodingProvider: (p) => {
      registered.geocoding.push(p);
    },
    registerRoutingProvider: (p) => {
      registered.routing.push(p);
    },
    registerRideProvider: (p) => {
      registered.ride.push(p);
    },
    registerRoadConditionsProvider: (p) => {
      registered.roadConditions.push(p);
    },
    registerFuelStationProvider: (p) => {
      registered.fuelStations.push(p);
    },
    registerParkingSiteProvider: (p) => {
      registered.parkingSites.push(p);
    },
    registerChargingSiteProvider: (p) => {
      registered.chargingSites.push(p);
    },
    registerCameraProvider: (p) => {
      registered.cameras.push(p);
    },
    registerMessageSignProvider: (p) => {
      registered.messageSigns.push(p);
    },
    registerLandmarkModelProvider: (p) => {
      registered.landmarkModels.push(p);
    },
    registerRoadWeatherProvider: (p) => {
      registered.roadWeather.push(p);
    },
    registerServiceVehicleProvider: (p) => {
      registered.serviceVehicles.push(p);
    },
    registerBorderCrossingProvider: (p) => {
      registered.borderCrossings.push(p);
    },
    registerHazardsProvider: (p) => {
      registered.hazards.push(p);
    },
    registerPhotoProvider: (p) => {
      registered.photo.push(p);
    },
    registerStreetLevelProvider: (p) => {
      registered.streetLevel.push(p);
    },
    registerReviewProvider: (p) => {
      registered.review.push(p);
    },
    registerPoiSearchProvider: (p) => {
      registered.poiSearch.push(p);
    },
    registerSearchSuggestionProvider: (p) => {
      registered.searchSuggestions.push(p);
    },
    registerKnowledgeProvider: (p) => {
      registered.knowledge.push(p);
    },
    registerGtfsCatalogProvider: (p) => {
      registered.gtfsCatalog.push(p);
    },
    registerRoute: (method, path, handler, options) => {
      registered.routes.push({ method, path, handler: storedRouteHandler(handler), options });
    },
    registerHealthCheck: (fn) => {
      registered.healthChecks.push(fn);
    },
    registerDisclosure: (d) => {
      registered.disclosures.push(d);
    },
    setDataSources: (list) => {
      registered.dataSourceLists.push([...list]);
      // The host's rules for one integration: valid against the manifest
      // domains, each sourceId once.
      const accepted: IntegrationDataSource[] = [];
      for (const candidate of list) {
        const result = validateDataSource(candidate, ctx.manifest.domains ?? []);
        if (!result.valid || accepted.some((ds) => ds.sourceId === candidate.sourceId)) continue;
        accepted.push(result.dataSource);
      }
      return accepted;
    },
    emit: noop,
    on: () => () => undefined,
    onActivate: runImmediateActivation,
    onShutdown: noop,
    getIntegrationsByDomain: () => [],
    getProviderOrder: (domain) => {
      const orders = overrides.providerOrder ?? {};
      return Object.hasOwn(orders, domain) ? readProviderOrder(orders[domain]) : [];
    },
    // Reads the context's own members at call time, so a test that replaces
    // them sees the fingerprint follow.
    getProviderOrderFingerprint: (domain) =>
      createHash("sha256")
        .update(providerOrderFingerprintInput(ctx, domain))
        .digest("hex")
        .slice(0, 16),
    getRequiredService: (serviceId) => {
      const services = overrides.requiredServices ?? {};
      const url = Object.hasOwn(services, serviceId) ? services[serviceId] : undefined;
      return url === undefined ? null : { serviceId, url, enabled: true };
    },
    resolvePlatformEndpoint: (endpointId) =>
      resolveIntegrationPlatformEndpoint(
        { manifest: ctx.manifest, config: ctx.config },
        (serviceId) => ctx.getRequiredService(serviceId),
        endpointId,
      ),
  };
  // The host's checks, so a provider the host would refuse fails the test.
  const check = createProviderRegistrationCheck({
    integrationId: ctx.id,
    manifest: {
      get id() {
        return ctx.manifest.id ?? ctx.id;
      },
      get dataSources() {
        return ctx.manifest.dataSources;
      },
    },
  });
  const registrars = ctx as unknown as Record<ProviderRegistrar, (provider: object) => void>;
  for (const domain of Object.keys(PROVIDER_SHAPES) as ProviderDomain[]) {
    const { registrar } = PROVIDER_SHAPES[domain];
    const store = registrars[registrar];
    registrars[registrar] = (provider) => {
      check(domain, provider);
      store(provider);
    };
  }
  return ctx;
}

/** Host capabilities a test installs on a context; integrations only read them. */
export type HostCapabilities = Partial<
  Pick<
    IntegrationContext,
    "manifest" | "attributionIndex" | "providerHealth" | "metricsRecorder" | "upstreamRuntime"
  >
>;

/** Install host capability doubles on an existing context, typed against the context. */
export function installHostCapabilities<T extends IntegrationContext>(
  ctx: T,
  capabilities: HostCapabilities,
): T {
  return Object.assign(ctx, capabilities);
}

/**
 * An attribution index that resolves the sources `current` returns at the
 * moment of each lookup, so a test can change them between calls.
 */
export function fakeAttributionIndex(
  current: () => readonly Attribution[],
): AttributionIndexHandle {
  return {
    list: () => [...current()],
    getById: (sourceId) => current().find((source) => source.sourceId === sourceId),
    getForMotisFile: () => undefined,
    dedupAndOrder: (attributions) => attributions,
    listMotisFeedTags: () => [],
  };
}

/** The request the host passes to a route handler. */
export type RouteRequest = Parameters<RouteHandler>[0];

/**
 * A route request as the host builds it: no query, params, body or headers
 * and a fixed client key, unless the test passes its own.
 */
export function routeRequest(fields: Partial<RouteRequest> = {}): RouteRequest {
  return {
    query: {},
    params: {},
    body: undefined,
    headers: {},
    clientKey: "test-client",
    ...fields,
  };
}

/** Read a fixture file as UTF-8 text, resolved relative to `baseDir`. */
export function loadFixture(baseDir: string, ...segments: string[]): string {
  return readFileSync(join(baseDir, ...segments), "utf-8");
}

/** Read and JSON-parse a fixture file, resolved relative to `baseDir`. */
export function loadJsonFixture<T = unknown>(baseDir: string, ...segments: string[]): T {
  return JSON.parse(loadFixture(baseDir, ...segments)) as T;
}

export { nth } from "./nth";
