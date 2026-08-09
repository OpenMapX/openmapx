import type {
  IntegrationContext,
  RideAvailability,
  RideBookingRules,
  RideHandoff,
  RideProduct,
  RideProvider,
  RideQuote,
  RideQuoteRequest,
} from "@openmapx/integration-framework";
import {
  type GofsBookingDetail,
  type GofsBookingRule,
  type GofsServiceBrand,
  type GofsVehicleType,
  gofsEstimateFare,
  gofsMatchingRules,
  gofsWaitTimeFor,
  gofsZonesContaining,
} from "@openmapx/mobility-formats";
import { createGofsFeedClient, type GofsFetchJson } from "./feed.js";
import type { GofsFeedConfig, GofsStaticFeed } from "./types.js";

const QUOTE_TTL_SECONDS = 60;

/** Local wall-clock `YYYY-MM-DDTHH:mm` in the feed's own timezone. */
function localWallClock(timezone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Interpret a `YYYY-MM-DDTHH:mm` wall clock in the feed's timezone and return
 * Unix seconds. Derives the zone's offset at that instant by formatting a
 * probe date, so it stays correct across daylight-saving changes without
 * pulling in a timezone library.
 */
export function wallClockToEpochSeconds(
  pickupAt: string | undefined,
  timezone: string,
): number | null {
  if (!pickupAt) return null;
  const asUtc = Date.parse(`${pickupAt}:00Z`);
  if (Number.isNaN(asUtc)) return null;
  try {
    const probe = new Date(asUtc);
    const local = new Date(probe.toLocaleString("en-US", { timeZone: timezone }));
    const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = local.getTime() - utc.getTime();
    return Math.floor((asUtc - offsetMs) / 1000);
  } catch {
    // An unknown timezone string should not lose the whole handoff.
    return Math.floor(asUtc / 1000);
  }
}

/**
 * GOFS brand colours are hex with no leading `#` in the live Freebee feed
 * ("042553"), and with one in the prose reference. Normalise so the UI can
 * drop the value straight into a CSS colour.
 */
function toCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/**
 * The largest capacity and the best accessibility among the vehicle types a
 * rule allows: a brand is bookable if *any* of its vehicles fits, so taking the
 * maximum is what a rider needs to know.
 */
function vehicleCapabilities(
  vehicleTypeIds: string[] | undefined,
  vehicleTypes: GofsVehicleType[],
): { seats?: number; wheelchairAccessible?: boolean } {
  if (!vehicleTypeIds?.length) return {};
  const matched = vehicleTypes.filter((v) => vehicleTypeIds.includes(v.vehicle_type_id));
  if (matched.length === 0) return {};
  const capacities = matched
    .map((v) => v.max_capacity)
    .filter((c): c is number => typeof c === "number");
  return {
    seats: capacities.length ? Math.max(...capacities) : undefined,
    wheelchairAccessible: matched.some((v) => v.wheelchair_boarding === "boarding_accessible"),
  };
}

function toProduct(
  brand: GofsServiceBrand,
  vehicles: { seats?: number; wheelchairAccessible?: boolean },
): RideProduct {
  return {
    id: brand.brand_id,
    name: brand.brand_name,
    seats: vehicles.seats,
    wheelchairAccessible: vehicles.wheelchairAccessible,
    color: toCssColor(brand.brand_color),
    textColor: toCssColor(brand.brand_text_color),
  };
}

function toBookingRules(rule: GofsBookingRule | undefined): RideBookingRules | undefined {
  if (!rule) return undefined;
  return {
    bookingType: rule.booking_type,
    priorNoticeMinutesMin: rule.prior_notice_duration_min,
    priorNoticeMinutesMax: rule.prior_notice_duration_max,
    message: rule.message,
    infoUrl: rule.info_url,
  };
}

/**
 * Append the GOFS deep-link parameters to a booking URL, per the spec's
 * "deeplink with query params" section.
 *
 * `pickup_time` is specified as seconds since the Unix epoch, not the
 * wall-clock string the rest of this codebase passes around, so `pickupAt` is
 * converted.
 */
function withDeepLinkParams(base: string, request: RideQuoteRequest, timezone: string): string {
  const url = new URL(base);
  url.searchParams.set("pickup_lat", String(request.pickup[1]));
  url.searchParams.set("pickup_lon", String(request.pickup[0]));
  if (request.pickupAddress) url.searchParams.set("pickup_address", request.pickupAddress);
  if (request.dropoff) {
    url.searchParams.set("drop_off_lat", String(request.dropoff[1]));
    url.searchParams.set("drop_off_lon", String(request.dropoff[0]));
    if (request.dropoffAddress) url.searchParams.set("drop_off_address", request.dropoffAddress);
  }
  const epochSeconds = wallClockToEpochSeconds(request.pickupAt, timezone);
  if (epochSeconds !== null) url.searchParams.set("pickup_time", String(epochSeconds));
  return url.toString();
}

function detailToHandoff(
  detail: GofsBookingDetail | undefined,
  request: RideQuoteRequest,
  timezone: string,
): RideHandoff | undefined {
  if (!detail?.web_uri) return undefined;
  return {
    webUrl: withDeepLinkParams(detail.web_uri, request, timezone),
    androidUrl: detail.android_uri,
    iosUrl: detail.ios_uri,
    phoneNumber: detail.phone_number,
    carriesCoordinates: true,
  };
}

/**
 * A GOFS 1.0 feed as a ride provider. GOFS exists so multi-brand trip planners
 * can present demand-responsive services, so this provider permits comparison —
 * unlike the closed-terms deep-link providers.
 */
export function createGofsRideProvider(
  ctx: IntegrationContext,
  config: GofsFeedConfig,
  fetchJson?: GofsFetchJson,
): RideProvider {
  const client = createGofsFeedClient(ctx, config, fetchJson);
  const sourceId = `gofs-${config.id}`;

  function attributionFor(feed: GofsStaticFeed) {
    return [
      {
        sourceId,
        name: feed.system.name,
        url: feed.system.url,
        publisher: feed.system.operator ? { name: feed.system.operator } : undefined,
      },
    ];
  }

  function freshnessNow() {
    return { fetchedAt: new Date().toISOString(), hasRealtimeData: true, isStale: false };
  }

  /** Resolve the brands serving this request, or null when out of area. */
  async function resolve(request: RideQuoteRequest): Promise<{
    feed: GofsStaticFeed;
    products: RideProduct[];
    fareIdByBrand: Map<string, string | undefined>;
    bookingRule: GofsBookingRule | undefined;
    fromZoneIds: string[];
    toZoneIds: string[] | null;
  } | null> {
    const feed = await client.loadStatic();
    const fromZoneIds = gofsZonesContaining(feed.zones, request.pickup);
    if (fromZoneIds.length === 0) return null;
    const toZoneIds = request.dropoff ? gofsZonesContaining(feed.zones, request.dropoff) : null;
    if (toZoneIds !== null && toZoneIds.length === 0) return null;

    const at = request.pickupAt ?? localWallClock(feed.system.timezone, new Date());
    const rules = gofsMatchingRules({
      rules: feed.rules,
      calendars: feed.calendars,
      fromZoneIds,
      toZoneIds,
      at,
    });
    if (rules.length === 0) return null;

    const fareIdByBrand = new Map<string, string | undefined>();
    const vehicleIdsByBrand = new Map<string, string[]>();
    const brandOrder: string[] = [];
    for (const rule of rules) {
      // `brand_id` is optional: the spec says a rule without one "applies to
      // every service brand defined in service_brands.json". Skipping such a
      // rule would report no products and drop a feed that does cover the trip.
      const brandIds = rule.brand_id ? [rule.brand_id] : feed.brands.map((b) => b.brand_id);
      for (const brandId of brandIds) {
        if (fareIdByBrand.has(brandId)) continue;
        fareIdByBrand.set(brandId, rule.fare_id);
        vehicleIdsByBrand.set(brandId, rule.vehicle_type_id ?? []);
        brandOrder.push(brandId);
      }
    }

    const byId = new Map(feed.brands.map((b) => [b.brand_id, b]));
    const products = brandOrder.flatMap((id) => {
      const brand = byId.get(id);
      if (!brand) return [];
      return [toProduct(brand, vehicleCapabilities(vehicleIdsByBrand.get(id), feed.vehicleTypes))];
    });

    const bookingRule = feed.bookingRules.find((r) =>
      r.from_zone_ids.some((z) => fromZoneIds.includes(z)),
    );

    return { feed, products, fareIdByBrand, bookingRule, fromZoneIds, toZoneIds };
  }

  return {
    id: sourceId,
    meta: {
      name: config.name,
      homepage: config.url,
      sourceId,
    },
    capabilities: { deepLink: true, quote: true, booking: false, tracking: false },
    // GOFS is published so third-party trip planners can present the service
    // alongside others; comparison is the intended use, not a tolerated one.
    permitsComparison: true,
    attribution: [{ sourceId, name: config.name }],
    quoteTtlSeconds: QUOTE_TTL_SECONDS,

    async getAvailability(request) {
      const resolved = await resolve(request);
      if (!resolved) {
        const feed = await client.loadStatic();
        const data: RideAvailability = {
          available: false,
          coverageChecked: true,
          reason: "outside-service-area",
          products: [],
        };
        return { data, attributions: attributionFor(feed), freshness: freshnessNow() };
      }
      const data: RideAvailability = {
        available: resolved.products.length > 0,
        coverageChecked: true,
        reason: resolved.products.length > 0 ? undefined : "no-products",
        products: resolved.products,
        bookingRules: toBookingRules(resolved.bookingRule),
      };
      return {
        data,
        attributions: attributionFor(resolved.feed),
        freshness: freshnessNow(),
      };
    },

    async getQuotes(request) {
      const resolved = await resolve(request);
      if (!resolved) {
        const feed = await client.loadStatic();
        return { data: [], attributions: attributionFor(feed), freshness: freshnessNow() };
      }

      const brandIds = resolved.products.map((p) => p.id);
      const query = {
        pickup: request.pickup,
        dropoff: request.dropoff,
        pickupAddress: request.pickupAddress,
        dropoffAddress: request.dropoffAddress,
        brandIds,
      };

      const booking = await client.fetchRealtimeBooking(query);
      const bookingByBrand = new Map(booking.map((b) => [b.brand_id, b]));

      // Only fall back to wait_time for brands realtime_booking did not cover.
      const missing = brandIds.filter((id) => !bookingByBrand.has(id));
      const waits =
        missing.length > 0 ? await client.fetchWaitTimes({ ...query, brandIds: missing }) : [];

      const faresById = new Map(resolved.feed.fares.map((f) => [f.fare_id, f]));
      // The orchestrator restamps expiresAt from quoteTtlSeconds; this value is
      // a floor so a provider used outside the orchestrator still expires.
      const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();

      const quotes: RideQuote[] = resolved.products.flatMap((product): RideQuote[] => {
        const live = bookingByBrand.get(product.id);
        if (live) {
          return [
            {
              productId: product.id,
              product,
              pickupEtaSeconds: live.wait_time,
              travelSeconds: live.travel_time,
              fare:
                live.travel_cost !== undefined && live.travel_cost_currency
                  ? {
                      amount: live.travel_cost,
                      currency: live.travel_cost_currency,
                      basis: "quoted" as const,
                    }
                  : undefined,
              handoff: detailToHandoff(live.booking_detail, request, resolved.feed.system.timezone),
              expiresAt,
            },
          ];
        }

        // Resolved through `gofsWaitTimeFor` rather than a brand lookup: the
        // live Freebee feed scopes wait times by zone pair with no brand at all.
        const wait = gofsWaitTimeFor(waits, product.id, resolved.fromZoneIds, resolved.toZoneIds);
        if (wait === null) return [];

        const fare = faresById.get(resolved.fareIdByBrand.get(product.id) ?? "");
        const amount =
          fare && request.route
            ? gofsEstimateFare(fare, {
                kilometers: request.route.distanceMeters / 1000,
                minutes: request.route.durationSeconds / 60,
                riders: request.passengers ?? 1,
              })
            : null;

        return [
          {
            productId: product.id,
            product,
            pickupEtaSeconds: wait,
            travelSeconds: request.route?.durationSeconds,
            fare:
              amount !== null && fare
                ? { amount, currency: fare.currency, basis: "estimated" as const }
                : undefined,
            expiresAt,
          },
        ];
      });

      return {
        data: quotes,
        attributions: attributionFor(resolved.feed),
        freshness: freshnessNow(),
      };
    },

    async createHandoff(request) {
      const feed = await client.loadStatic();
      const fromZoneIds = gofsZonesContaining(feed.zones, request.pickup);
      const rule = feed.bookingRules.find((r) =>
        r.from_zone_ids.some((z) => fromZoneIds.includes(z)),
      );

      if (rule?.booking_url) {
        return {
          webUrl: withDeepLinkParams(rule.booking_url, request, feed.system.timezone),
          phoneNumber: rule.phone_number ?? feed.system.phone_number,
          carriesCoordinates: true,
        };
      }
      return {
        webUrl: feed.system.url ?? config.url,
        phoneNumber: rule?.phone_number ?? feed.system.phone_number,
        carriesCoordinates: false,
      };
    },
  };
}
