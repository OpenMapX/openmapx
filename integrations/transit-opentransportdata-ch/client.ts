import { createHash } from "node:crypto";
import { USER_AGENT_TRANSIT } from "@openmapx/core";
import type {
  CacheClient,
  HttpClient,
  Logger,
  QuotaWindow,
  ResponseOptions,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import {
  buildOjpLocationInformationRequestXml,
  decodeGtfsRtFeedToObject,
} from "@openmapx/mobility-formats";

const DEFAULTS = {
  fallbackEndpoint: "https://api.opentransportdata.swiss/ojp2020",
  formationEndpoint: "https://api.opentransportdata.swiss/formation",
  gtfsRtEndpoint: "https://api.opentransportdata.swiss/la/gtfs-rt",
  gtfsSaEndpoint: "https://api.opentransportdata.swiss/la/gtfs-sa",
  ojpEndpoint: "https://api.opentransportdata.swiss/ojp20",
  ojpFareEndpoint: "https://api.opentransportdata.swiss/ojpfare",
  requestLanguage: "de",
  requestorRef: "OpenMapX",
  siriSxEndpoint: "https://api.opentransportdata.swiss/la/siri-sx",
  siriSxUnplannedEndpoint: "https://api.opentransportdata.swiss/la/siri-sx-unplanned",
  userAgent: USER_AGENT_TRANSIT,
};

export interface SwissTransitConfig {
  apiKey?: string;
  fallbackEndpoint?: string;
  formationEndpoint?: string;
  gtfsRtEndpoint?: string;
  gtfsSaEndpoint?: string;
  ojpEndpoint?: string;
  ojpFareEndpoint?: string;
  requestLanguage?: string;
  requestorRef?: string;
  siriSxEndpoint?: string;
  siriSxUnplannedEndpoint?: string;
  userAgent?: string;
}
interface SwissRequestCacheOptions {
  cacheNamespace: string;
  cacheTtlSeconds: number;
}
export interface SwissFormationRequest {
  evu: string;
  operationDate: string;
  trainNumber: string;
}
export interface SwissClientOptions {
  config: Readonly<Record<string, unknown>> | SwissTransitConfig;
  http: HttpClient;
  cache: CacheClient;
  log?: Logger;
  upstreamRuntime?: UpstreamRuntime;
  contributors: Readonly<Record<string, readonly Attribution[]>>;
  isSourceAllowed?: (sourceId: string) => Promise<boolean>;
}

const API_WINDOWS: readonly QuotaWindow[] = [
  { id: "minute", limit: 50, durationMs: 60_000 },
  { id: "day", limit: 20_000, durationMs: 86_400_000 },
];
const QUOTAS: Readonly<Record<string, readonly QuotaWindow[]>> = {
  ojp: API_WINDOWS,
  "ojp-fare": API_WINDOWS,
  formation: API_WINDOWS,
  "gtfs-sa": [{ id: "minute", limit: 5, durationMs: 60_000 }],
  "gtfs-rt": [{ id: "minute", limit: 5, durationMs: 60_000 }],
  "siri-complete": [
    { id: "hour", limit: 10, durationMs: 3_600_000 },
    { id: "day", limit: 48, durationMs: 86_400_000 },
  ],
  "siri-unplanned": [
    { id: "minute", limit: 2, durationMs: 60_000 },
    { id: "day", limit: 3_000, durationMs: 86_400_000 },
  ],
};
class SwissAcquisitionDenied extends Error {}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Configuration and receipts belong to this setup generation, never the module. */
export function createSwissTransitClient(options: SwissClientOptions) {
  const configured = Object.fromEntries(
    Object.entries(options.config).filter(([, value]) => typeof value === "string"),
  ) as SwissTransitConfig;
  const config = Object.freeze({
    ...DEFAULTS,
    ...configured,
    apiKey: configured.apiKey?.trim(),
    log: options.log,
  });
  for (const [name, value] of Object.entries(config)) {
    if (!name.endsWith("Endpoint")) continue;
    const endpoint = new URL(value as string);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("Swiss API endpoints require HTTPS without URL credentials");
    }
  }
  const contributors = Object.fromEntries(
    Object.entries(options.contributors)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, receipts]) => [id, snapshotContributors(receipts)]),
  );
  const identity = hash({ config: { ...config, log: undefined }, contributors });
  const credentialIdentity = hash(config.apiKey ?? "");
  const lifetime = new AbortController();
  const isSwissTransitConfigured = () => Boolean(config.apiKey);
  const sourceId = (source: string) => `opentransportdata-ch-${source}`;
  const checkPolicy = async (source: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!isSwissTransitConfigured())
      throw new SwissAcquisitionDenied("Swiss API key not configured");
    if (options.isSourceAllowed && !(await options.isSourceAllowed(sourceId(source))))
      throw new SwissAcquisitionDenied("Swiss source disabled by policy");
    signal.throwIfAborted();
  };
  const assertAllowed = (source: string) => checkPolicy(source, lifetime.signal);
  // This is called inside acquisition, so cache hits do not consume provider quota.
  const consume = async (family: string, signal: AbortSignal) => {
    await checkPolicy(family.startsWith("siri-") ? "siri-sx" : family, signal);
    if (!options.upstreamRuntime)
      throw new SwissAcquisitionDenied("Swiss shared quota runtime unavailable");
    const windows = QUOTAS[family];
    if (!windows) throw new SwissAcquisitionDenied("Unknown Swiss quota family");
    let allowed = false;
    try {
      const decision = await options.upstreamRuntime.consumeQuota({
        bucket: `swiss-otdch:${family}:${credentialIdentity}`,
        cost: 1,
        windows,
      });
      allowed = decision.allowed && decision.diagnostic !== "store_unavailable";
    } catch {
      throw new SwissAcquisitionDenied("Swiss shared quota runtime unavailable");
    }
    signal.throwIfAborted();
    if (!allowed) throw new SwissAcquisitionDenied("Swiss upstream quota unavailable");
  };
  const requestOptions = (
    url: string,
    signal: AbortSignal,
    contentTypes: readonly string[],
    maxBytes = 32 * 1024 * 1024,
  ): ResponseOptions => ({
    signal,
    timeoutMs: 20_000,
    maxBytes,
    contentTypes,
    fallbackContentType: contentTypes[0],
    redirect: {
      allowedHosts: [new URL(url).hostname, "opentransportdata.swiss", "*.opentransportdata.swiss"],
      follow203: true,
    },
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Accept-Encoding": "gzip, br, deflate",
      "User-Agent": config.userAgent,
    },
  });
  const checkStatus = (status: number) => {
    if (status < 200 || status >= 300) throw new Error(`Swiss upstream request failed (${status})`);
  };
  const cached = async <T>(
    source: string,
    namespace: string,
    payload: unknown,
    ttl: number,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    await assertAllowed(source);
    const result = await options.cache.withCache(
      `swiss-otdch:v2:${identity}:${namespace}:${hash(payload)}`,
      ttl,
      load,
      lifetime.signal,
    );
    await assertAllowed(source);
    return result;
  };
  const requestXml = async (
    xml: string,
    endpoints: readonly string[],
    family: "ojp" | "ojp-fare",
    cacheOptions?: SwissRequestCacheOptions,
  ): Promise<string> => {
    await assertAllowed(family);
    const candidates = [...new Set(endpoints)];
    const load = async (signal: AbortSignal): Promise<string> => {
      let lastError: unknown;
      for (const endpoint of candidates) {
        await consume(family, signal);
        try {
          const response = await options.http.postText(endpoint, xml, {
            ...requestOptions(
              endpoint,
              signal,
              ["application/xml", "text/xml", "text/plain"],
              8 * 1024 * 1024,
            ),
            headers: {
              ...requestOptions(endpoint, signal, []).headers,
              Accept: "application/xml, text/xml;q=0.9",
              "Content-Type": "application/xml",
            },
          });
          checkStatus(response.status);
          return response.body;
        } catch (error) {
          signal.throwIfAborted();
          lastError = error;
          options.log?.warn("Swiss XML endpoint failed");
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Swiss XML request failed");
    };
    if (cacheOptions && cacheOptions.cacheTtlSeconds > 0)
      return cached(
        family,
        cacheOptions.cacheNamespace,
        { xml, candidates },
        cacheOptions.cacheTtlSeconds,
        load,
      );
    const result = await load(lifetime.signal);
    await assertAllowed(family);
    return result;
  };
  const requestSwissOjp = (xml: string, cacheOptions?: SwissRequestCacheOptions) =>
    requestXml(xml, [config.ojpEndpoint, config.fallbackEndpoint], "ojp", cacheOptions);
  const requestSwissOjpFare = (xml: string, cacheOptions?: SwissRequestCacheOptions) =>
    requestXml(xml, [config.ojpFareEndpoint], "ojp-fare", cacheOptions);
  const binaryFeed = (family: "gtfs-sa" | "gtfs-rt", endpoint: string, ttl: number) =>
    cached(family, family, endpoint, ttl, async (signal) => {
      await consume(family, signal);
      const response = await options.http.getBytes(
        endpoint,
        requestOptions(endpoint, signal, [
          "application/octet-stream",
          "application/protobuf",
          "application/x-protobuf",
        ]),
      );
      checkStatus(response.status);
      return decodeGtfsRtFeedToObject(response.bytes);
    });
  return {
    config,
    cacheIdentity: identity,
    isSwissTransitConfigured,
    requestSwissOjp,
    requestSwissOjpFare,
    fetchSwissGtfsSaFeed: () => binaryFeed("gtfs-sa", config.gtfsSaEndpoint, 60),
    fetchSwissGtfsRtFeed: () => binaryFeed("gtfs-rt", config.gtfsRtEndpoint, 30),
    fetchSwissSiriSxFeed: (kind: "complete" | "unplanned" = "complete") => {
      const endpoint = kind === "complete" ? config.siriSxEndpoint : config.siriSxUnplannedEndpoint;
      return cached(
        "siri-sx",
        `siri-${kind}`,
        endpoint,
        kind === "complete" ? 6 * 60 * 60 : 60,
        async (signal) => {
          await consume(`siri-${kind}`, signal);
          const response = await options.http.getText(
            endpoint,
            requestOptions(endpoint, signal, ["application/xml", "text/xml", "text/plain"]),
          );
          checkStatus(response.status);
          return response.body;
        },
      );
    },
    fetchSwissFormationJourney: <T>(request: SwissFormationRequest): Promise<T | null> => {
      const base = config.formationEndpoint;
      const endpoint = new URL("v2/formations_full", base.endsWith("/") ? base : `${base}/`);
      for (const [key, value] of Object.entries(request)) endpoint.searchParams.set(key, value);
      return cached("formation", "formation", endpoint.toString(), 300, async (signal) => {
        await consume("formation", signal);
        const response = await options.http.getText(
          endpoint.toString(),
          requestOptions(
            endpoint.toString(),
            signal,
            ["application/json", "text/json", "text/plain"],
            8 * 1024 * 1024,
          ),
        );
        if ([401, 403, 404].includes(response.status)) return null;
        checkStatus(response.status);
        return JSON.parse(response.body) as T;
      });
    },
    async probeSwissOjp(): Promise<boolean> {
      if (!isSwissTransitConfigured()) return false;
      try {
        await requestSwissOjp(
          buildOjpLocationInformationRequestXml({
            language: config.requestLanguage,
            limit: 1,
            query: "Bern",
            requestorRef: config.requestorRef,
            types: ["stop"],
          }),
          { cacheNamespace: "probe", cacheTtlSeconds: 30 },
        );
        return true;
      } catch {
        return false;
      }
    },
    async dispose() {
      lifetime.abort(new Error("Swiss client retired"));
    },
  };
}
export type SwissTransitClient = ReturnType<typeof createSwissTransitClient>;
