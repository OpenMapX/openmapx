import { createCachedHafasClient } from "cached-hafas-client";
import { createRedisStore } from "cached-hafas-client/stores/redis.js";
import { createClient } from "hafas-client";
import { redis } from "../../../redis";
import { mapProducts, normalizeFptfDeparture, productToMode } from "../fptf";
import type { RegistryEntry } from "../registry/types";
import type {
  BBox,
  Departure,
  GeoJSONLineString,
  ServiceAlert,
  TransitStop,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripRemark,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "../types";
import type { ProtocolAdapter } from "./types";

const TIMEOUT_MS = 8_000;

// Mode mappings

/**
 * Maps transport-apis product IDs to the FPTF `mode` field required by
 * hafas-client profile product definitions.
 * FPTF modes: train | bus | watercraft | aircraft | gondola | bicycle | car | taxi | walking
 */
const PRODUCT_ID_TO_FPTF_MODE: Record<string, string> = {
  "express-train": "train",
  "long-distance-train": "train",
  "long-distance-train-1": "train",
  "long-distance-train-2": "train",
  "long-distance-train-3": "train",
  "long-distance-train-4": "train",
  "regional-train": "train",
  regional: "train",
  suburban: "train",
  "s-bahn": "train",
  subway: "train",
  "u-bahn": "train",
  tram: "train",
  bus: "bus",
  ferry: "watercraft",
  "on-call": "bus",
  "on-demand": "bus",
  taxi: "bus",
  gondola: "gondola",
  funicular: "train",
  cableCar: "gondola",
};

/**
 * Maps hafas-client FPTF product names (the profile-specific product labels
 * returned on stop.products and line.product) to our TransportMode.
 */
// productToMode, mapProducts, normalizeRemarks imported from ../fptf

// Profile building

interface TransportApiProduct {
  id: string;
  bitmasks: number[];
  name: string;
}

function buildProducts(rawProducts: TransportApiProduct[]): Array<{
  id: string;
  mode: string;
  bitmasks: number[];
  name: string;
  short: string;
  default: boolean;
}> {
  return rawProducts.map((p) => ({
    id: p.id,
    mode: PRODUCT_ID_TO_FPTF_MODE[p.id] ?? "train",
    bitmasks: p.bitmasks,
    name: p.name,
    short: p.id.slice(0, 6),
    default: true,
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: hafas-client uses untyped profiles
function buildProfile(entry: RegistryEntry): Record<string, any> {
  const opts = entry.options;
  // biome-ignore lint/suspicious/noExplicitAny: external config object
  const profile: Record<string, any> = {};

  if (opts.endpoint) profile.endpoint = opts.endpoint;
  if (opts.auth) profile.auth = opts.auth;
  if (opts.client) profile.client = opts.client;
  if (opts.ver) profile.ver = opts.ver;
  if (opts.ext) profile.ext = opts.ext;
  if (opts.checksumSalt) profile.salt = opts.checksumSalt;
  if (opts.micMacSalt) profile.micMacSalt = opts.micMacSalt;

  if (entry.timezone) profile.timezone = entry.timezone;
  if (entry.supportedLanguages[0]) profile.defaultLanguage = entry.supportedLanguages[0];
  profile.locale = entry.supportedLanguages[0]
    ? `${entry.supportedLanguages[0]}-${entry.id.split("/")[0].toUpperCase()}`
    : "en";

  const rawProducts = (opts.products ?? []) as TransportApiProduct[];
  if (rawProducts.length > 0) {
    profile.products = buildProducts(rawProducts);
  }

  // Enable trip for journey planning and tripsByName for vehicle detail
  profile.trip = true;
  profile.radar = true;

  return profile;
}

// Client cache

// biome-ignore lint/suspicious/noExplicitAny: cached-hafas-client store
const redisStore: any = redis ? createRedisStore(redis) : null;

// biome-ignore lint/suspicious/noExplicitAny: hafas-client client type
const clientCache = new Map<string, any>();

// biome-ignore lint/suspicious/noExplicitAny: hafas-client client type
function getClient(entry: RegistryEntry): any {
  let client = clientCache.get(entry.id);
  if (!client) {
    const profile = buildProfile(entry);
    const rawClient = createClient(profile, "OpenMapX (github.com/openmapx)");
    client = redisStore ? createCachedHafasClient(rawClient, redisStore) : rawClient;
    clientCache.set(entry.id, client);
  }
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Helpers: raw-ID extraction

function rawId(stopId: string, entry: RegistryEntry): string {
  return stopId.startsWith(entry.prefix) ? stopId.slice(entry.prefix.length) : stopId;
}

// Normalisation helpers

// biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF stop
function normalizeStop(s: any, entry: RegistryEntry): TransitStop {
  return {
    id: `${entry.prefix}${s.id}`,
    name: s.name ?? "Unknown",
    lat: s.location?.latitude ?? 0,
    lng: s.location?.longitude ?? 0,
    modes: mapProducts(s.products),
    provider: entry.slug,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF remark
function mapRemark(r: any): TripRemark {
  const text = (
    r.summary && r.text && r.text !== r.summary
      ? `${r.summary}: ${r.text}`
      : (r.summary ?? r.text ?? "")
  ).trim();
  return {
    text,
    type: r.type === "warning" ? "warning" : "info",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF departure
function normalizeDeparture(d: any, entry: RegistryEntry): Departure {
  return normalizeFptfDeparture(d, entry.prefix);
}

// biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF leg
function legToTripLeg(leg: any, entry: RegistryEntry): TripLeg {
  const line = leg.line ?? {};
  const isWalking = leg.walking === true || !line.id;
  // Walking legs must use the "walking" mode, not "bus"
  const mode: TransportMode = isWalking ? "walking" : productToMode(line.product);

  const fromLat: number = leg.origin?.location?.latitude ?? 0;
  const fromLng: number = leg.origin?.location?.longitude ?? 0;
  const toLat: number = leg.destination?.location?.latitude ?? 0;
  const toLng: number = leg.destination?.location?.longitude ?? 0;

  // Use the GeoJSON polyline returned by hafas-client (when polylines: true)
  let geometry: GeoJSONLineString = {
    type: "LineString",
    coordinates: [
      [fromLng, fromLat],
      [toLng, toLat],
    ],
  };
  const polyFeature = leg.polyline?.features?.[0]?.geometry;
  if (polyFeature?.type === "LineString" && Array.isArray(polyFeature.coordinates)) {
    geometry = polyFeature as GeoJSONLineString;
  }

  const intermediateStops: number = Array.isArray(leg.stopovers)
    ? Math.max(0, leg.stopovers.length - 2) // stopovers includes origin + destination
    : 0;

  return {
    mode,
    startTime: leg.departure ?? leg.plannedDeparture ?? "",
    endTime: leg.arrival ?? leg.plannedArrival ?? "",
    from: {
      name: leg.origin?.name ?? "",
      lat: fromLat,
      lng: fromLng,
      stopId: leg.origin?.id ? `${entry.prefix}${leg.origin.id}` : undefined,
    },
    to: {
      name: leg.destination?.name ?? "",
      lat: toLat,
      lng: toLng,
      stopId: leg.destination?.id ? `${entry.prefix}${leg.destination.id}` : undefined,
    },
    route: isWalking
      ? undefined
      : {
          shortName: line.name ?? "",
          longName: line.productName ?? line.name ?? "",
          color: line.color?.bg?.replace(/^#/, "") ?? undefined,
        },
    geometry,
    tripId: !isWalking && leg.tripId ? `${entry.prefix}${leg.tripId}` : undefined,
    _intermediateStopCount: intermediateStops,
  };
}

// Adapter

export const hafasMgateAdapter: ProtocolAdapter = {
  async getStopsNearby(entry, lat, lng, radiusMeters) {
    try {
      const client = getClient(entry);
      const results = await withTimeout(
        client.nearby(
          { type: "location", latitude: lat, longitude: lng },
          { results: 30, distance: Math.round(radiusMeters) },
        ),
        TIMEOUT_MS,
      );
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      return (results as any[]).map((s: any) => normalizeStop(s, entry));
    } catch {
      return [];
    }
  },

  async getStopById(entry, stopId) {
    try {
      const client = getClient(entry);
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF stop
      const result = (await withTimeout(client.stop(rawId(stopId, entry)), TIMEOUT_MS)) as any;
      if (!result) return null;
      return normalizeStop(result, entry);
    } catch {
      return null;
    }
  },

  async getDepartures(entry, stopId, minutes) {
    try {
      const client = getClient(entry);
      const result = await withTimeout(
        client.departures(rawId(stopId, entry), {
          duration: minutes,
          results: Math.min(500, Math.max(50, minutes * 3)),
          remarks: true,
        }),
        TIMEOUT_MS,
      );
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      const deps = (result as any).departures ?? result;
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF departure
      return (Array.isArray(deps) ? deps : []).map((d: any) => normalizeDeparture(d, entry));
    } catch {
      return [];
    }
  },

  async getArrivals(entry, stopId, minutes) {
    try {
      const client = getClient(entry);
      const result = await withTimeout(
        client.arrivals(rawId(stopId, entry), {
          duration: minutes,
          results: Math.min(500, Math.max(50, minutes * 3)),
          remarks: true,
        }),
        TIMEOUT_MS,
      );
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      const arrs = (result as any).arrivals ?? result;
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF departure
      return (Array.isArray(arrs) ? arrs : []).map((d: any) => normalizeDeparture(d, entry));
    } catch {
      return [];
    }
  },

  async searchByName(entry, query, limit) {
    try {
      const client = getClient(entry);
      const results = await withTimeout(
        client.locations(query, {
          results: limit,
          stops: true,
          addresses: false,
          poi: false,
        }),
        TIMEOUT_MS,
      );
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      return (results as any[])
        .filter((s) => s.type === "stop" || s.type === "station")
        .map((s) => normalizeStop(s, entry));
    } catch {
      return [];
    }
  },

  async getAlerts(entry, params) {
    try {
      const client = getClient(entry);
      // client.remarks() fetches all regional service alerts known to the endpoint.
      // Not all HAFAS endpoints support this method — the catch handles that.
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF remarks response
      const result = (await withTimeout(client.remarks(), TIMEOUT_MS)) as any;
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF remark
      const remarks: any[] = result?.remarks ?? (Array.isArray(result) ? result : []);

      const filterRouteId = params?.routeId ? rawId(params.routeId, entry) : undefined;

      return remarks
        .filter((r) => {
          if (r.type !== "warning") return false;
          // If a routeId filter is requested, only include alerts affecting that line
          if (filterRouteId && Array.isArray(r.affectedLines) && r.affectedLines.length > 0) {
            return r.affectedLines.some(
              // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF line
              (l: any) => l.id === filterRouteId || l.fahrtNr === filterRouteId,
            );
          }
          return true;
        })
        .map(
          // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF remark
          (r: any): ServiceAlert => ({
            // Prefer the server-assigned ID; fall back to a hash of the text
            id: r.id ?? `${entry.slug}:${(r.summary ?? r.text ?? "").slice(0, 40)}`,
            providers: [entry.slug],
            // HAFAS priority: lower number = higher priority. Treat priority < 50 as severe.
            severity: typeof r.priority === "number" && r.priority < 50 ? "severe" : "warning",
            title: r.summary ?? (r.text ?? "").slice(0, 120),
            description: r.text,
            affectedRouteIds: (r.affectedLines ?? [])
              // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF line
              .map((l: any) => {
                const id = l.id ?? l.fahrtNr ?? "";
                return id ? `${entry.prefix}${id}` : "";
              })
              .filter(Boolean),
            affectedStopIds: [],
            activePeriods: r.validFrom
              ? [{ start: r.validFrom as string, end: r.validUntil as string | undefined }]
              : [],
          }),
        );
    } catch {
      return [];
    }
  },

  async getTrip(entry, tripId): Promise<VehicleJourney | null> {
    try {
      const client = getClient(entry);
      const raw = rawId(tripId, entry);
      const data = (await withTimeout(
        client.trip(raw, { stopovers: true, remarks: true }),
        TIMEOUT_MS,
        // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      )) as any;
      const trip = data?.trip ?? data;
      if (!trip) return null;
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF stopover
      const stopovers: any[] = trip.stopovers ?? [];
      const stops: VehicleJourneyStop[] = stopovers.map(
        // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF stopover
        (s: any): VehicleJourneyStop => ({
          stopId: `${entry.prefix}${s.stop?.id ?? ""}`,
          name: s.stop?.name ?? "",
          lat: s.stop?.location?.latitude ?? 0,
          lng: s.stop?.location?.longitude ?? 0,
          platform: s.platform ?? s.plannedPlatform ?? undefined,
          scheduledArrival: s.plannedArrival ?? undefined,
          scheduledDeparture: s.plannedDeparture ?? undefined,
          expectedArrival: s.arrival ?? undefined,
          expectedDeparture: s.departure ?? undefined,
          delaySeconds:
            typeof s.arrivalDelay === "number"
              ? s.arrivalDelay
              : typeof s.departureDelay === "number"
                ? s.departureDelay
                : undefined,
          canceled: s.cancelled ?? false,
          departed: s.departure != null && new Date(s.departure).getTime() < Date.now(),
        }),
      );
      const remarks: TripRemark[] | undefined =
        Array.isArray(trip.remarks) && trip.remarks.length > 0
          ? trip.remarks.map(mapRemark).filter((r: TripRemark) => r.text.length > 0)
          : undefined;
      return {
        id: `${entry.prefix}${trip.id ?? raw}`,
        name: trip.line?.name ?? trip.direction ?? "",
        provider: entry.slug,
        remarks: remarks?.length ? remarks : undefined,
        stops,
      };
    } catch {
      return null;
    }
  },

  async getVehicleRadar(entry, bbox) {
    try {
      const client = getClient(entry);
      const [west, south, east, north] = bbox as BBox;
      const rawRadarResult = await withTimeout(
        client.radar(
          { north, west, south, east },
          // duration:30 computes one position snapshot 30 s ahead; frames:1 keeps payload small
          { results: 256, duration: 30, frames: 1 },
        ),
        TIMEOUT_MS,
      );
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF radar response
      const result = rawRadarResult as any;
      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF movement
      const movements: any[] = result?.movements ?? [];
      return movements
        .filter((m) => m.location?.latitude != null && m.location?.longitude != null)
        .map(
          // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF movement
          (m: any, idx: number): VehiclePosition => ({
            id: `${entry.prefix}${m.tripId ?? m.trip ?? `r${idx}`}`,
            provider: entry.slug,
            tripId:
              m.tripId != null
                ? `${entry.prefix}${m.tripId}`
                : m.trip != null
                  ? `${entry.prefix}${m.trip}`
                  : undefined,
            routeId: m.line?.id ? `${entry.prefix}${m.line.id}` : undefined,
            lat: m.location.latitude as number,
            lng: m.location.longitude as number,
            // HAFAS does not return bearing or speed in the radar response
            label: m.line?.name ?? m.direction,
            currentStopId: m.nextStopovers?.[0]?.stop?.id
              ? `${entry.prefix}${m.nextStopovers[0].stop.id as string}`
              : undefined,
            updatedAt: new Date().toISOString(),
          }),
        );
    } catch {
      return [];
    }
  },

  async planJourney(entry, fromLat, fromLng, toLat, toLng, date, time, arriveBy, numItineraries) {
    try {
      const client = getClient(entry);
      const dt = new Date(`${date}T${time}`);
      const result = await withTimeout(
        client.journeys(
          { type: "location", latitude: fromLat, longitude: fromLng },
          { type: "location", latitude: toLat, longitude: toLng },
          {
            ...(arriveBy ? { arrival: dt } : { departure: dt }),
            results: numItineraries ?? 3,
            stopovers: true,
            polylines: true,
            remarks: true,
          },
        ),
        TIMEOUT_MS,
      );

      // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF response
      const journeys = (result as any).journeys ?? [];
      if (!journeys.length) return null;

      const itineraries: TripItinerary[] = journeys.map(
        // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF journey
        (j: any): TripItinerary => {
          const rawLegs = j.legs ?? [];
          // biome-ignore lint/suspicious/noExplicitAny: hafas-client FPTF leg
          const legs: TripLeg[] = rawLegs.map((l: any) => legToTripLeg(l, entry));
          const startTime = legs[0]?.startTime ?? "";
          const endTime = legs[legs.length - 1]?.endTime ?? "";
          const durationMs =
            startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
          const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);
          // Walk distance: use the distance field from raw legs (consistent with hafas/db-vendo)
          const walkDistance = (rawLegs as Array<{ walking?: boolean; distance?: number }>)
            .filter((l) => l.walking === true)
            .reduce((sum, l) => sum + (l.distance ?? 0), 0);
          return {
            duration: Math.round(durationMs / 1000),
            startTime,
            endTime,
            transfers,
            walkDistance: Math.round(walkDistance),
            legs,
          };
        },
      );

      const firstLeg = itineraries[0]?.legs[0];
      const lastItinerary = itineraries[0];
      const lastLeg = lastItinerary?.legs[lastItinerary.legs.length - 1];

      return {
        from: {
          name: firstLeg?.from.name ?? "",
          lat: firstLeg?.from.lat ?? fromLat,
          lng: firstLeg?.from.lng ?? fromLng,
        },
        to: {
          name: lastLeg?.to.name ?? "",
          lat: lastLeg?.to.lat ?? toLat,
          lng: lastLeg?.to.lng ?? toLng,
        },
        itineraries,
      };
    } catch {
      return null;
    }
  },
};
