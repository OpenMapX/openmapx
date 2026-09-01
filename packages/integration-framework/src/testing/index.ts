import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MobilityHttpRequestOptions,
  MobilityHttpTransport,
} from "@openmapx/mobility-core/json-transport";
import type { PoiSource } from "@openmapx/poi-source-registry";
import { runImmediateActivation } from "../activation-transaction";
import type {
  BinaryHttpResponse,
  CacheClient,
  CustomHealthCheckFn,
  DatabaseClient,
  Disclosure,
  HttpClient,
  HttpClientOptions,
  HttpResponse,
  IntegrationContext,
  LiveStoreClient,
  Logger,
  ResponseOptions,
  RouteHandler,
  RouteOptions,
  SecretsClient,
} from "../context.js";
import type { AirQualityProvider } from "../contracts/air-quality-provider.js";
import type { GeocodingProvider } from "../contracts/geocoding-provider.js";
import type { GtfsCatalogProvider } from "../contracts/gtfs-catalog-provider.js";
import type { KnowledgeProvider } from "../contracts/knowledge-provider.js";
import type { MobilityDataSourceProvider } from "../contracts/mobility-data-source-provider.js";
import type { PhotoProvider } from "../contracts/photo-provider.js";
import type { PoiSearchProvider } from "../contracts/poi-search-provider.js";
import type { RealtimeProvider } from "../contracts/realtime-provider.js";
import type { ReviewProvider } from "../contracts/review-provider.js";
import type { RideProvider } from "../contracts/ride-provider.js";
import type { RoadConditionsProvider } from "../contracts/road-conditions-provider.js";
import type { RoutingProvider } from "../contracts/routing-provider.js";
import type { SearchSuggestionProvider } from "../contracts/search-suggestion-provider.js";
import type { StreetLevelProvider } from "../contracts/street-level-imagery-provider.js";
import type { TransitProvider } from "../contracts/transit-provider.js";
import type { WeatherProvider } from "../contracts/weather-provider.js";

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
 * Promotes the per-file fakes that integration tests used to re-invent (see the
 * inline `makeCtx`/`makeCache`/`makeLogger` in `__tests__/poi-source-reader.test.ts`).
 */

export interface FakeHttpRequest {
  method: "get" | "post" | "getResponse" | "getBytes";
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
    get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T> {
      const req: FakeHttpRequest = { method: "get", url, options };
      calls.push(req);
      return Promise.resolve(resolve(req) as T);
    },
    post<T = unknown>(url: string, body?: unknown, options?: HttpClientOptions): Promise<T> {
      const req: FakeHttpRequest = { method: "post", url, body, options };
      calls.push(req);
      return Promise.resolve(resolve(req) as T);
    },
    getResponse<T = unknown>(url: string, options: ResponseOptions): Promise<HttpResponse<T>> {
      const req: FakeHttpRequest = { method: "getResponse", url, options };
      calls.push(req);
      const value = resolve(req);
      if (
        value &&
        typeof value === "object" &&
        "status" in value &&
        "headers" in value &&
        "body" in value
      ) {
        return Promise.resolve(value as HttpResponse<T>);
      }
      return Promise.resolve({ status: 200, headers: {}, body: value as T });
    },
    getBytes(url: string, options: ResponseOptions): Promise<BinaryHttpResponse> {
      const req: FakeHttpRequest = { method: "getBytes", url, options };
      calls.push(req);
      const value = resolve(req);
      if (
        value &&
        typeof value === "object" &&
        "status" in value &&
        "headers" in value &&
        "bytes" in value
      ) {
        return Promise.resolve(value as BinaryHttpResponse);
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(
          "fakeHttpClient: getBytes response must be Uint8Array or BinaryHttpResponse",
        );
      }
      return Promise.resolve({ status: 200, headers: {}, bytes: value });
    },
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
  photo: PhotoProvider[];
  streetLevel: StreetLevelProvider[];
  review: ReviewProvider[];
  poiSearch: PoiSearchProvider[];
  searchSuggestions: SearchSuggestionProvider[];
  knowledge: KnowledgeProvider[];
  gtfsCatalog: GtfsCatalogProvider[];
  poiSources: PoiSource[];
  routes: { method: string; path: string; handler: RouteHandler; options?: RouteOptions }[];
  healthChecks: CustomHealthCheckFn[];
  disclosures: Disclosure[];
}

export interface MockContextOverrides {
  id?: string;
  config?: Record<string, unknown>;
  http?: HttpClient;
  cache?: CacheClient;
  liveStore?: LiveStoreClient;
  secrets?: SecretsClient;
  db?: DatabaseClient;
  log?: Logger;
  manifest?: IntegrationContext["manifest"];
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
    photo: [],
    streetLevel: [],
    review: [],
    poiSearch: [],
    searchSuggestions: [],
    knowledge: [],
    gtfsCatalog: [],
    poiSources: [],
    routes: [],
    healthChecks: [],
    disclosures: [],
  };
  const noop = () => undefined;
  const liveStore: LiveStoreClient = overrides.liveStore ?? {
    hmget: async <T>(_key: string, fields: readonly string[]) => fields.map(() => null as T | null),
  };
  const ctx: MockIntegrationContext = {
    id: overrides.id ?? "test-integration",
    manifest: overrides.manifest ?? ({} as IntegrationContext["manifest"]),
    config: overrides.config ?? {},
    http:
      overrides.http ??
      fakeHttpClient(() => {
        throw new Error(
          "createMockIntegrationContext: HTTP not stubbed — pass { http: fakeHttpClient(...) }",
        );
      }),
    cache: overrides.cache ?? createPassthroughCache(),
    liveStore,
    db: overrides.db,
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
    registerPoiSources: (sources) => {
      registered.poiSources.push(...sources);
    },
    registerRoute: (method, path, handler, options) => {
      registered.routes.push({ method, path, handler, options });
    },
    registerHealthCheck: (fn) => {
      registered.healthChecks.push(fn);
    },
    registerDisclosure: (d) => {
      registered.disclosures.push(d);
    },
    emit: noop,
    on: () => () => undefined,
    onActivate: runImmediateActivation,
    onShutdown: noop,
    getIntegrationsByDomain: () => [],
    getRequiredService: () => null,
  };
  return ctx;
}

/** Read a fixture file as UTF-8 text, resolved relative to `baseDir`. */
export function loadFixture(baseDir: string, ...segments: string[]): string {
  return readFileSync(join(baseDir, ...segments), "utf-8");
}

/** Read and JSON-parse a fixture file, resolved relative to `baseDir`. */
export function loadJsonFixture<T = unknown>(baseDir: string, ...segments: string[]): T {
  return JSON.parse(loadFixture(baseDir, ...segments)) as T;
}
