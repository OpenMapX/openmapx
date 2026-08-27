import { createHash } from "node:crypto";
import { fetchWithRedirects, USER_AGENT_TRANSIT } from "@openmapx/core";
import { readBoundedBinaryResponse } from "@openmapx/core/server";
import type { CacheClient, Logger } from "@openmapx/integration-framework";
import {
  buildOjpLocationInformationRequestXml,
  decodeGtfsRtFeedToObject,
  type GtfsRtFeedObject,
} from "@openmapx/mobility-formats";

const DEFAULT_OJP_ENDPOINT = "https://api.opentransportdata.swiss/ojp20";
const DEFAULT_OJP_FALLBACK_ENDPOINT = "https://api.opentransportdata.swiss/ojp2020";
const DEFAULT_OJP_FARE_ENDPOINT = "https://api.opentransportdata.swiss/ojpfare";
const DEFAULT_GTFS_SA_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-sa";
const DEFAULT_GTFS_RT_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-rt";
const DEFAULT_SIRI_SX_ENDPOINT = "https://api.opentransportdata.swiss/la/siri-sx";
const DEFAULT_SIRI_SX_UNPLANNED_ENDPOINT =
  "https://api.opentransportdata.swiss/la/siri-sx-unplanned";
const DEFAULT_FORMATION_ENDPOINT = "https://api.opentransportdata.swiss/formation";
const SWISS_REDIRECT_HOSTS = ["opentransportdata.swiss", "*.opentransportdata.swiss"];

interface BinaryCacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface SwissRequestCacheOptions {
  cacheNamespace: string;
  cacheTtlSeconds: number;
}

export interface SwissTransitConfig {
  apiKey?: string;
  cache?: CacheClient;
  fallbackEndpoint?: string;
  formationEndpoint?: string;
  gtfsRtEndpoint?: string;
  gtfsSaEndpoint?: string;
  log?: Logger;
  ojpEndpoint?: string;
  ojpFareEndpoint?: string;
  requestLanguage?: string;
  requestorRef?: string;
  siriSxEndpoint?: string;
  siriSxUnplannedEndpoint?: string;
  userAgent?: string;
}

export interface SwissFormationRequest {
  evu: string;
  operationDate: string;
  trainNumber: string;
}

let config: SwissTransitConfig = {
  fallbackEndpoint: DEFAULT_OJP_FALLBACK_ENDPOINT,
  formationEndpoint: DEFAULT_FORMATION_ENDPOINT,
  gtfsRtEndpoint: DEFAULT_GTFS_RT_ENDPOINT,
  gtfsSaEndpoint: DEFAULT_GTFS_SA_ENDPOINT,
  ojpEndpoint: DEFAULT_OJP_ENDPOINT,
  ojpFareEndpoint: DEFAULT_OJP_FARE_ENDPOINT,
  requestLanguage: "de",
  requestorRef: "OpenMapX",
  siriSxEndpoint: DEFAULT_SIRI_SX_ENDPOINT,
  siriSxUnplannedEndpoint: DEFAULT_SIRI_SX_UNPLANNED_ENDPOINT,
};

let gtfsSaCache: BinaryCacheEntry<GtfsRtFeedObject> | null = null;
let gtfsRtCache: BinaryCacheEntry<GtfsRtFeedObject> | null = null;
const siriFeedCache = new Map<string, BinaryCacheEntry<string>>();
const formationCache = new Map<string, BinaryCacheEntry<unknown | null>>();

export function setSwissTransitConfig(nextConfig: SwissTransitConfig): void {
  config = {
    ...config,
    ...nextConfig,
  };
  gtfsSaCache = null;
  gtfsRtCache = null;
  siriFeedCache.clear();
  formationCache.clear();
}

export function getSwissTransitConfig(): SwissTransitConfig {
  return config;
}

export function isSwissTransitConfigured(): boolean {
  return Boolean(config.apiKey?.trim());
}

function authHeaders(options: { accept?: string; contentType?: string } = {}): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${config.apiKey}`,
    "Accept-Encoding": "gzip, br, deflate",
    "User-Agent": config.userAgent ?? USER_AGENT_TRANSIT,
  });
  if (options.accept) headers.set("Accept", options.accept);
  if (options.contentType) headers.set("Content-Type", options.contentType);
  return headers;
}

function trustedSwissRedirectHosts(url: string): string[] {
  return [new URL(url).hostname, ...SWISS_REDIRECT_HOSTS];
}

async function postXml(endpoint: string, body: string): Promise<string> {
  const response = await fetchWithRedirects(endpoint, {
    allowedRedirectHosts: trustedSwissRedirectHosts(endpoint),
    body,
    follow203Redirect: true,
    headers: authHeaders({
      accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
      contentType: "application/xml",
    }),
    method: "POST",
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Swiss OJP request failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.text();
}

function swissCacheKey(
  namespace: string,
  payload: { body?: string; endpoints?: string[]; label?: string; url?: string },
): string {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
  return `swiss-otdch:${namespace}:${hash}`;
}

async function requestSwissXml(
  requestXml: string,
  endpoints: Array<string | undefined>,
  label: string,
  cacheOptions?: SwissRequestCacheOptions,
): Promise<string> {
  if (!isSwissTransitConfigured()) {
    throw new Error(`${label} API key not configured`);
  }
  const candidates = endpoints.filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );

  const fetchFresh = async () => {
    let lastError: unknown = null;
    for (const endpoint of candidates) {
      try {
        return await postXml(endpoint, requestXml);
      } catch (error) {
        lastError = error;
        config.log?.warn?.(`${label} endpoint failed`, endpoint, error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} request failed`);
  };

  if (
    cacheOptions?.cacheNamespace &&
    cacheOptions.cacheTtlSeconds > 0 &&
    config.cache &&
    candidates.length > 0
  ) {
    return config.cache.withCache(
      swissCacheKey(cacheOptions.cacheNamespace, {
        body: requestXml,
        endpoints: candidates,
        label,
      }),
      cacheOptions.cacheTtlSeconds,
      fetchFresh,
    );
  }
  return fetchFresh();
}

export async function requestSwissOjp(
  requestXml: string,
  cacheOptions?: SwissRequestCacheOptions,
): Promise<string> {
  return requestSwissXml(
    requestXml,
    [config.ojpEndpoint, config.fallbackEndpoint],
    "Swiss OJP",
    cacheOptions,
  );
}

export async function requestSwissOjpFare(
  requestXml: string,
  cacheOptions?: SwissRequestCacheOptions,
): Promise<string> {
  return requestSwissXml(requestXml, [config.ojpFareEndpoint], "Swiss OJP fare", cacheOptions);
}

async function fetchBinaryFeed(url: string): Promise<ArrayBuffer> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: authHeaders({ accept: "application/octet-stream, application/protobuf, */*;q=0.1" }),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Swiss binary feed failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const { data } = await readBoundedBinaryResponse(response, {
    maxBytes: 32 * 1024 * 1024,
    fallbackContentType: "application/octet-stream",
    label: "Swiss realtime binary feed",
  });
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

async function fetchTextFeed(url: string): Promise<string> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: authHeaders({ accept: "application/xml, text/xml;q=0.9, */*;q=0.1" }),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Swiss text feed failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.text();
}

async function fetchJsonFeed<T>(url: string): Promise<T> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: authHeaders({ accept: "application/json, */*;q=0.1" }),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Swiss JSON feed failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function localCacheHit<T>(entry: BinaryCacheEntry<T> | null): T | null {
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

export async function fetchSwissGtfsSaFeed(): Promise<GtfsRtFeedObject> {
  if (!isSwissTransitConfigured()) {
    throw new Error("Swiss GTFS-SA API key not configured");
  }
  const local = localCacheHit(gtfsSaCache);
  if (local) {
    return local;
  }

  const endpoint = config.gtfsSaEndpoint ?? DEFAULT_GTFS_SA_ENDPOINT;
  const feed =
    config.cache && endpoint
      ? await config.cache.withCache(swissCacheKey("gtfs-sa", { url: endpoint }), 60, async () =>
          decodeGtfsRtFeedToObject(await fetchBinaryFeed(endpoint)),
        )
      : decodeGtfsRtFeedToObject(await fetchBinaryFeed(endpoint));
  gtfsSaCache = {
    expiresAt: Date.now() + 60_000,
    value: feed,
  };
  return feed;
}

export async function fetchSwissGtfsRtFeed(): Promise<GtfsRtFeedObject> {
  if (!isSwissTransitConfigured()) {
    throw new Error("Swiss GTFS-RT API key not configured");
  }
  const local = localCacheHit(gtfsRtCache);
  if (local) {
    return local;
  }

  const endpoint = config.gtfsRtEndpoint ?? DEFAULT_GTFS_RT_ENDPOINT;
  const feed =
    config.cache && endpoint
      ? await config.cache.withCache(swissCacheKey("gtfs-rt", { url: endpoint }), 30, async () =>
          decodeGtfsRtFeedToObject(await fetchBinaryFeed(endpoint)),
        )
      : decodeGtfsRtFeedToObject(await fetchBinaryFeed(endpoint));
  gtfsRtCache = {
    expiresAt: Date.now() + 30_000,
    value: feed,
  };
  return feed;
}

export async function fetchSwissSiriSxFeed(
  kind: "complete" | "unplanned" = "complete",
): Promise<string> {
  if (!isSwissTransitConfigured()) {
    throw new Error("Swiss SIRI-SX API key not configured");
  }
  const local = localCacheHit(siriFeedCache.get(kind) ?? null);
  if (local) {
    return local;
  }

  const endpoint =
    kind === "complete"
      ? (config.siriSxEndpoint ?? DEFAULT_SIRI_SX_ENDPOINT)
      : (config.siriSxUnplannedEndpoint ?? DEFAULT_SIRI_SX_UNPLANNED_ENDPOINT);
  const ttlSeconds = kind === "complete" ? 6 * 60 * 60 : 60;
  const feed =
    config.cache && endpoint
      ? await config.cache.withCache(
          swissCacheKey(`siri-sx:${kind}`, { url: endpoint }),
          ttlSeconds,
          async () => fetchTextFeed(endpoint),
        )
      : await fetchTextFeed(endpoint);
  siriFeedCache.set(kind, {
    expiresAt: Date.now() + ttlSeconds * 1000,
    value: feed,
  });
  return feed;
}

function formationCacheKey(request: SwissFormationRequest): string {
  return `${request.evu}|${request.operationDate}|${request.trainNumber}`;
}

export async function fetchSwissFormationJourney<T>(
  request: SwissFormationRequest,
): Promise<T | null> {
  if (!isSwissTransitConfigured()) {
    throw new Error("Swiss formation API key not configured");
  }
  const localKey = formationCacheKey(request);
  const localEntry = formationCache.get(localKey);
  if (localEntry && localEntry.expiresAt > Date.now()) {
    return localEntry.value as T | null;
  }

  const baseEndpoint = config.formationEndpoint ?? DEFAULT_FORMATION_ENDPOINT;
  const endpoint = new URL(
    "v2/formations_full",
    baseEndpoint.endsWith("/") ? baseEndpoint : `${baseEndpoint}/`,
  );
  endpoint.searchParams.set("evu", request.evu);
  endpoint.searchParams.set("operationDate", request.operationDate);
  endpoint.searchParams.set("trainNumber", request.trainNumber);

  const fetchFresh = async (): Promise<T | null> => {
    const url = endpoint.toString();
    try {
      return await fetchJsonFeed<T>(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(401)") || message.includes("(403)") || message.includes("(404)")) {
        config.log?.warn?.("Swiss formation request unavailable", url, message);
        return null;
      }
      throw error;
    }
  };

  const journey = config.cache
    ? await config.cache.withCache(
        swissCacheKey("formation", {
          label: "Swiss formation",
          url: endpoint.toString(),
        }),
        300,
        fetchFresh,
      )
    : await fetchFresh();
  formationCache.set(localKey, {
    expiresAt: Date.now() + 300_000,
    value: journey,
  });
  return journey as T | null;
}

export async function probeSwissOjp(): Promise<boolean> {
  if (!isSwissTransitConfigured()) return false;
  try {
    const xml = buildOjpLocationInformationRequestXml({
      language: config.requestLanguage,
      limit: 1,
      query: "Bern",
      requestorRef: config.requestorRef,
      types: ["stop"],
    });
    await requestSwissOjp(xml, {
      cacheNamespace: "probe",
      cacheTtlSeconds: 30,
    });
    return true;
  } catch {
    return false;
  }
}
