import { safeFetchJson } from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import {
  type GofsRealtimeBookingEntry,
  type GofsWaitTimeEntry,
  gofsFeedUrl,
  parseGofsDiscovery,
  parseGofsRealtimeBooking,
  parseGofsWaitTimes,
} from "@openmapx/mobility-formats";
import type { GofsAuth, GofsFeedConfig, GofsPointQuery, GofsStaticFeed } from "./types.js";

/** Fallback when a feed omits `ttl`, or reports a nonsensical one. */
const DEFAULT_STATIC_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;

export type GofsFetchJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

/**
 * Feed URLs come from a third-party registry and from operator input, so every
 * fetch goes through the DNS-aware SSRF-safe downloader rather than bare fetch.
 * Tests inject their own fetcher.
 *
 * When the request carries a credential header, redirects are pinned to the
 * feed's own host: `safeFetchJson` follows redirects, and without
 * `allowedRedirectHosts` a 302 from the feed would hand the API key to whatever
 * host the `Location` names.
 */
const defaultFetchJson: GofsFetchJson = (url, headers) =>
  safeFetchJson(url, {
    headers,
    allowedRedirectHosts:
      headers && Object.keys(headers).length > 0 ? [new URL(url).hostname] : undefined,
  });

/**
 * Apply a feed's credential to one request. Header auth is preferred where a
 * feed supports it — a key in a query string ends up in access logs and
 * referrers.
 */
export function applyGofsAuth(
  url: string,
  auth: GofsAuth | undefined,
): { url: string; headers: Record<string, string> } {
  if (!auth) return { url, headers: {} };
  if (auth.kind === "header") return { url, headers: { [auth.name]: auth.value } };
  const withKey = new URL(url);
  withKey.searchParams.set(auth.name, auth.value);
  return { url: withKey.toString(), headers: {} };
}

function envelopeData(doc: unknown): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null) return {};
  const data = (doc as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/**
 * Cache lifetime for a fetched file, in seconds. `ttl: 0` means "always
 * refresh" in GOFS and must not be floored into a positive lifetime — the live
 * Freebee feed sends 0 on every file, so flooring it would serve a day-old
 * service area as if it were current. Returns 0 for "do not cache".
 */
function envelopeTtl(doc: unknown): number {
  if (typeof doc !== "object" || doc === null) return DEFAULT_STATIC_TTL_SECONDS;
  const ttl = (doc as { ttl?: unknown }).ttl;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) return DEFAULT_STATIC_TTL_SECONDS;
  if (ttl <= 0) return 0;
  return Math.max(MIN_TTL_SECONDS, Math.floor(ttl));
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function createGofsFeedClient(
  ctx: IntegrationContext,
  config: GofsFeedConfig,
  fetchJson: GofsFetchJson = defaultFetchJson,
) {
  const cacheKey = (name: string) => `gofs:${config.id}:${name}`;

  /** Every request this client makes carries the feed's credential, if it has one. */
  function authedFetch(rawUrl: string): Promise<unknown> {
    const { url, headers } = applyGofsAuth(rawUrl, config.auth);
    return fetchJson(url, headers);
  }

  async function cachedFetch(name: string, url: string): Promise<unknown> {
    const cached = await ctx.cache.get(cacheKey(name));
    if (cached !== null && cached !== undefined) return cached;
    const doc = await authedFetch(url);
    const ttl = envelopeTtl(doc);
    // A feed declaring ttl 0 is telling us its data can change at any moment;
    // honour that by not caching it at all rather than picking a lifetime for it.
    if (ttl > 0) await ctx.cache.set(cacheKey(name), doc, ttl);
    return doc;
  }

  /** Fetch an optional file, treating any failure as "the feed omits it". */
  async function optional(name: string, url: string | null): Promise<unknown> {
    if (!url) return null;
    try {
      return await cachedFetch(name, url);
    } catch (err) {
      ctx.log.warn(
        `GOFS optional file unavailable: ${config.id}/${name}`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  async function loadStatic(): Promise<GofsStaticFeed> {
    // Discovery is mandatory: without it there is no feed at all, so a failure
    // here propagates rather than degrading to an empty feed.
    const discovery = await cachedFetch("gofs", config.url);
    const feeds = parseGofsDiscovery(discovery);

    const [system, brands, zones, rules, calendars, fares, bookingRules, vehicleTypes] =
      await Promise.all([
        cachedFetch("system_information", gofsFeedUrl(feeds, "system_information") ?? config.url),
        optional("service_brands", gofsFeedUrl(feeds, "service_brands")),
        optional("zones", gofsFeedUrl(feeds, "zones")),
        optional("operating_rules", gofsFeedUrl(feeds, "operating_rules")),
        optional("calendars", gofsFeedUrl(feeds, "calendars")),
        optional("fares", gofsFeedUrl(feeds, "fares")),
        optional("booking_rules", gofsFeedUrl(feeds, "booking_rules")),
        optional("vehicle_types", gofsFeedUrl(feeds, "vehicle_types")),
      ]);

    const systemData = envelopeData(system);
    return {
      system: {
        language: String(systemData.language ?? "en"),
        timezone: String(systemData.timezone ?? "UTC"),
        name: String(systemData.name ?? config.name),
        operator: typeof systemData.operator === "string" ? systemData.operator : undefined,
        url: typeof systemData.url === "string" ? systemData.url : undefined,
        phone_number:
          typeof systemData.phone_number === "string" ? systemData.phone_number : undefined,
      },
      brands: asArray(envelopeData(brands).service_brands),
      zones: asArray(
        (envelopeData(zones).zones as { features?: unknown } | undefined)?.features ?? [],
      ),
      rules: asArray(envelopeData(rules).operating_rules),
      calendars: asArray(envelopeData(calendars).calendars),
      fares: asArray(envelopeData(fares).fares),
      bookingRules: asArray(envelopeData(bookingRules).booking_rules),
      vehicleTypes: asArray(envelopeData(vehicleTypes).vehicle_types),
      realtimeBookingUrl: gofsFeedUrl(feeds, "realtime_booking"),
      // `gofsFeedUrl` resolves the `wait_times` alias too.
      waitTimeUrl: gofsFeedUrl(feeds, "wait_time"),
    };
  }

  /** Build the GOFS-specified query string for the dynamic endpoints. */
  function dynamicUrl(base: string, query: GofsPointQuery): string {
    const url = new URL(base);
    url.searchParams.set("pickup_lat", String(query.pickup[1]));
    url.searchParams.set("pickup_lon", String(query.pickup[0]));
    if (query.dropoff) {
      url.searchParams.set("drop_off_lat", String(query.dropoff[1]));
      url.searchParams.set("drop_off_lon", String(query.dropoff[0]));
    }
    if (query.pickupAddress) url.searchParams.set("pickup_address", query.pickupAddress);
    if (query.dropoffAddress) url.searchParams.set("drop_off_address", query.dropoffAddress);
    for (const brandId of query.brandIds ?? []) url.searchParams.append("brand_id", brandId);
    return url.toString();
  }

  /**
   * Dynamic responses are per-rider and expire in seconds, so they are fetched
   * fresh every time and never written to the cache.
   */
  async function fetchRealtimeBooking(query: GofsPointQuery): Promise<GofsRealtimeBookingEntry[]> {
    const { realtimeBookingUrl } = await loadStatic();
    if (!realtimeBookingUrl) return [];
    return parseGofsRealtimeBooking(await authedFetch(dynamicUrl(realtimeBookingUrl, query)));
  }

  async function fetchWaitTimes(query: GofsPointQuery): Promise<GofsWaitTimeEntry[]> {
    const { waitTimeUrl } = await loadStatic();
    if (!waitTimeUrl) return [];
    return parseGofsWaitTimes(await authedFetch(dynamicUrl(waitTimeUrl, query)));
  }

  return { id: config.id, name: config.name, loadStatic, fetchRealtimeBooking, fetchWaitTimes };
}
