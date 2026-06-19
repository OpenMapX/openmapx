import {
  mapFptfLoadFactor,
  mapProducts,
  normalizeFptfDeparture,
  normalizeRemarks,
  productToMode,
  USER_AGENT_TRANSIT,
} from "@openmapx/core";
import type {
  Departure,
  GeoJSONLineString,
  ServiceAlert,
  TransitStop,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
} from "@openmapx/mobility-core/transit";
import { createClient } from "db-vendo-client";
// dbnav uses app.services-bahn.de — documented as more stable than the db
// profile (app.vendo.noncd.db.de, "possibly shut off soon" per readme).
// @ts-expect-error — no type declarations for the dbnav profile sub-path
import { profile as dbnavProfile } from "db-vendo-client/p/dbnav/index.js";
// @ts-expect-error — no type declarations for the dbweb profile sub-path
import { profile as dbwebProfile } from "db-vendo-client/p/dbweb/index.js";
// @ts-expect-error — no type declarations for throttle/retry sub-paths
import { withRetrying } from "db-vendo-client/retry.js";
// @ts-expect-error — no type declarations for throttle/retry sub-paths
import { withThrottling } from "db-vendo-client/throttle.js";

const PREFIX = "db:";

// biome-ignore lint/suspicious/noExplicitAny: external untyped package
function buildClients(userAgent: string): { client: any; dbwebClient: any } {
  // Primary client for journey planning, departures, stops, etc.
  // dbnav quota: 60 req/min → throttle to 1/s. Retry up to 3× on transient
  // failures (network timeouts, 5xx); HafasErrors are never retried.
  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  const mainClient: any = createClient(
    withRetrying(withThrottling(dbnavProfile, 1, 1000)),
    userAgent,
    { enrichStations: true },
  );

  // Secondary client for polyline geometry via /reiseloesung/fahrt?poly=true.
  // dbweb is "aggressively blocked" per docs, so we:
  //   • throttle to 1 req/2 s (very conservative)
  //   • retry up to 2× with a short backoff (3 s, 6 s) so the UI doesn't stall
  //   • randomize the User-Agent to reduce fingerprinting-based blocking
  // biome-ignore lint/suspicious/noExplicitAny: external untyped package
  const dbweb: any = createClient(
    withRetrying(withThrottling({ ...dbwebProfile, randomizeUserAgent: true }, 1, 2000), {
      retries: 2,
      minTimeout: 3_000,
      factor: 2,
    }),
    userAgent,
  );

  return { client: mainClient, dbwebClient: dbweb };
}

// Module-level defaults; setup(ctx) rebuilds with the resolved User-Agent.
// biome-ignore lint/suspicious/noExplicitAny: external untyped package
let client: any;
// biome-ignore lint/suspicious/noExplicitAny: external untyped package
let dbwebClient: any;
({ client, dbwebClient } = buildClients(USER_AGENT_TRANSIT));

/**
 * Rebuild both underlying db-vendo clients with a new User-Agent. Called from
 * setup(ctx) so operators can override the header via `ctx.config.userAgent`
 * (or the `DB_USER_AGENT` env alias).
 */
export function setDbVendoUserAgent(userAgent: string | undefined): void {
  const ua = userAgent && userAgent.length > 0 ? userAgent : USER_AGENT_TRANSIT;
  ({ client, dbwebClient } = buildClients(ua));
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeStop(s: any): TransitStop {
  return {
    id: `${PREFIX}${s.id}`,
    name: s.name ?? "Unknown",
    lat: s.location?.latitude ?? 0,
    lng: s.location?.longitude ?? 0,
    modes: mapProducts(s.products),
    provider: "db",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: external API response
function normalizeDeparture(d: any): Departure {
  return normalizeFptfDeparture(d, PREFIX);
}

function stripPrefix(id: string): string {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id;
}

// Stops

export async function getStopsNearby(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  try {
    const data = await client.nearby(
      { type: "location", latitude: lat, longitude: lng },
      { results: 30, distance: Math.round(radiusMeters) },
    );
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    return (data as any[]).map(normalizeStop);
  } catch {
    return [];
  }
}

export async function getStop(stopId: string): Promise<TransitStop | null> {
  const rawId = stripPrefix(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.stop(rawId);
    return data ? normalizeStop(data) : null;
  } catch {
    return null;
  }
}

/**
 * Return platform-level child stops for a DB station.
 * The db-vendo-client stop() response for a station can include a `stops` array
 * (FPTF Station format) containing individual platform stops.
 */
export async function getPlatformStops(stopId: string): Promise<TransitStop[]> {
  const rawId = stripPrefix(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.stop(rawId, { subStops: true });
    const childStops: unknown[] = Array.isArray(data?.stops) ? data.stops : [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    return childStops.map((s) => normalizeStop(s as any));
  } catch {
    return [];
  }
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  try {
    const data = await client.locations(query, {
      results: limit,
      stops: true,
      addresses: false,
      poi: false,
    });
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    return (data as any[])
      .filter((s) => s.type === "stop" || s.type === "station")
      .map(normalizeStop);
  } catch {
    return [];
  }
}

// Departures & Arrivals

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const rawId = stripPrefix(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.departures(rawId, {
      duration: minutes,
      results: Math.min(500, Math.max(50, minutes * 3)),
      remarks: true,
    });
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    return (data.departures ?? []).map((d: any) => normalizeDeparture(d));
  } catch {
    return [];
  }
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const rawId = stripPrefix(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.arrivals(rawId, {
      duration: minutes,
      results: Math.min(500, Math.max(50, minutes * 3)),
      remarks: true,
    });
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    return (data.arrivals ?? []).map((d: any) => normalizeDeparture(d));
  } catch {
    return [];
  }
}

// Alerts

export async function getStopAlerts(_stopId: string): Promise<ServiceAlert[]> {
  // DB has no station-level alerts API. Remarks are now embedded in Departure.remarks.
  return [];
}

// Journey Planning

// biome-ignore lint/suspicious/noExplicitAny: external API response
function legToTripLeg(leg: any): TripLeg {
  const line = leg.line ?? {};
  const isWalking = leg.walking === true || !line.id;
  // Walking legs must use "walking" mode, not "bus"
  const mode: TransportMode = isWalking ? "walking" : productToMode(line.product ?? "");

  const fromLat: number = leg.origin?.location?.latitude ?? leg.origin?.latitude ?? 0;
  const fromLng: number = leg.origin?.location?.longitude ?? leg.origin?.longitude ?? 0;
  const toLat: number = leg.destination?.location?.latitude ?? leg.destination?.latitude ?? 0;
  const toLng: number = leg.destination?.location?.longitude ?? leg.destination?.longitude ?? 0;

  let geometry: GeoJSONLineString = {
    type: "LineString",
    coordinates: [
      [fromLng, fromLat],
      [toLng, toLat],
    ],
  };
  if (Array.isArray(leg.stopovers) && leg.stopovers.length >= 2) {
    // db-vendo-client does not support polylines in journeys(); use stopover
    // coordinates as a multi-point fallback so the route passes through real
    // intermediate stations instead of drawing a single straight line.
    const coords: [number, number][] = [];
    for (const s of leg.stopovers) {
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      const sv = s as any;
      const lat = sv.stop?.location?.latitude ?? sv.location?.latitude;
      const lng = sv.stop?.location?.longitude ?? sv.location?.longitude;
      if (typeof lat === "number" && typeof lng === "number") {
        coords.push([lng, lat]);
      }
    }
    if (coords.length >= 2) {
      geometry = { type: "LineString", coordinates: coords };
    }
  }

  // stopovers includes origin + destination; subtract 2 for intermediate count
  const _intermediateStopCount = Array.isArray(leg.stopovers)
    ? Math.max(0, leg.stopovers.length - 2)
    : 0;

  return {
    mode,
    startTime: leg.departure ?? leg.plannedDeparture ?? "",
    endTime: leg.arrival ?? leg.plannedArrival ?? "",
    from: {
      name: leg.origin?.name ?? "",
      lat: fromLat,
      lng: fromLng,
      stopId: leg.origin?.id ? `${PREFIX}${leg.origin.id}` : undefined,
    },
    to: {
      name: leg.destination?.name ?? "",
      lat: toLat,
      lng: toLng,
      stopId: leg.destination?.id ? `${PREFIX}${leg.destination.id}` : undefined,
    },
    route: isWalking
      ? undefined
      : {
          shortName: line.name ?? "",
          longName: line.productName ?? line.name ?? "",
          color: line.color?.bg?.replace(/^#/, "") ?? undefined,
        },
    geometry,
    tripId: !isWalking && leg.tripId ? `${PREFIX}${leg.tripId}` : undefined,
    routeId: !isWalking && line.id ? `${PREFIX}${line.id}` : undefined,
    // DB occupancy forecast (auslastungsmeldungen), surfaced by db-vendo-client
    // as an FPTF loadFactor on rail/bus legs. Undefined on walking legs.
    occupancy: mapFptfLoadFactor(leg.loadFactor),
    _intermediateStopCount,
  };
}

export async function planJourney(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
  arriveBy?: boolean,
  numItineraries?: number,
): Promise<TripPlan | null> {
  try {
    const dt = new Date(`${date}T${time}Z`);
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.journeys(
      { type: "location", address: "Origin", latitude: fromLat, longitude: fromLng },
      { type: "location", address: "Destination", latitude: toLat, longitude: toLng },
      {
        // db-vendo-client expects a Date, not a string
        ...(arriveBy ? { arrival: dt } : { departure: dt }),
        results: numItineraries ?? 3,
        stopovers: true,
        remarks: true,
        // polylines are not supported in journeys() for db-vendo-client; only
        // refreshJourney() accepts the option, but the DB vendo API no longer
        // returns polylineGroup data there either. We use stopover coordinates
        // as a multi-point fallback (see legToTripLeg), and refine per-leg via
        // getLegGeometry() when the user selects an itinerary.
      },
    );
    if (!data.journeys?.length) return null;

    const itineraries: TripItinerary[] = data.journeys.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (j: any): TripItinerary => {
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        const rawLegs: any[] = j.legs ?? [];
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        const legs: TripLeg[] = rawLegs.map((l: any) => legToTripLeg(l));
        const startTime = legs[0]?.startTime ?? "";
        const endTime = legs[legs.length - 1]?.endTime ?? "";
        const durationMs =
          startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
        const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);
        // FPTF walking legs include a `distance` field in meters — use it directly
        const walkDistance = rawLegs
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .filter((l: any) => l.walking === true)
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          .reduce((sum: number, l: any) => sum + (l.distance ?? 0), 0);

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
}

// Leg Geometry

/** Return the index in `coords` closest to `[lng, lat]` (squared equirectangular distance). */
function closestIndex(coords: [number, number][], lng: number, lat: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = (coords[i][0] - lng) ** 2 + (coords[i][1] - lat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Fetch the exact track shape for a single transit leg.
 *
 * Uses the bahn.de web client whose /reiseloesung/fahrt endpoint supports
 * poly=true and returns the full polyline as a FeatureCollection of Points.
 * The result is clipped to the user's boarding/alighting stops. Falls back to
 * stopover coordinates if the polyline is not available.
 */
export async function getLegGeometry(
  tripId: string,
  fromStopId?: string,
  toStopId?: string,
): Promise<GeoJSONLineString | null> {
  const rawId = stripPrefix(tripId);
  const rawFrom = fromStopId ? stripPrefix(fromStopId) : undefined;
  const rawTo = toStopId ? stripPrefix(toStopId) : undefined;
  try {
    // Use the bahn.de web client: its /reiseloesung/fahrt endpoint accepts
    // poly=true and returns the full track polyline as a FeatureCollection of
    // Point features. The HAFAS trip IDs from the db profile are compatible.
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await dbwebClient.trip(rawId, { stopovers: true, polyline: true });
    const trip = data.trip ?? data;

    // The polyline comes back as a GeoJSON FeatureCollection of Point features.
    // Convert to a LineString and clip to the boarding / alighting stops.
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const stopovers: any[] = trip.stopovers ?? [];
    const polyCollection = trip.polyline;

    if (
      polyCollection?.type === "FeatureCollection" &&
      Array.isArray(polyCollection.features) &&
      polyCollection.features.length >= 2
    ) {
      const allCoords: [number, number][] = [];
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      for (const f of polyCollection.features as any[]) {
        if (f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates)) {
          allCoords.push(f.geometry.coordinates as [number, number]);
        }
      }

      if (allCoords.length >= 2) {
        // Clip to the user's leg using the boarding/alighting stop coordinates
        // as anchor points (find the nearest polyline point to each station).
        const fromStop = rawFrom ? stopovers.find((s) => s.stop?.id === rawFrom) : null;
        const toStop = rawTo ? stopovers.find((s) => s.stop?.id === rawTo) : null;

        let startIdx = 0;
        let endIdx = allCoords.length - 1;

        if (fromStop?.stop?.location) {
          startIdx = closestIndex(
            allCoords,
            fromStop.stop.location.longitude,
            fromStop.stop.location.latitude,
          );
        }
        if (toStop?.stop?.location) {
          endIdx = closestIndex(
            allCoords,
            toStop.stop.location.longitude,
            toStop.stop.location.latitude,
          );
        }

        // Ensure correct order (trains always run origin→destination in the polyline)
        if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];

        const clipped = allCoords.slice(startIdx, endIdx + 1);
        if (clipped.length >= 2) {
          return { type: "LineString", coordinates: clipped };
        }
      }
    }

    // Fallback: use stopover coordinates clipped to the leg's stop range.
    let fromIdx = rawFrom ? stopovers.findIndex((s) => s.stop?.id === rawFrom) : -1;
    let toIdx = rawTo ? stopovers.findIndex((s) => s.stop?.id === rawTo) : -1;
    if (fromIdx === -1) fromIdx = 0;
    if (toIdx === -1) toIdx = stopovers.length - 1;

    const slice = stopovers.slice(fromIdx, toIdx + 1);
    const coords: [number, number][] = [];
    for (const s of slice) {
      const lat = s.stop?.location?.latitude;
      const lng = s.stop?.location?.longitude;
      if (typeof lat === "number" && typeof lng === "number") {
        coords.push([lng, lat]);
      }
    }
    return coords.length >= 2 ? { type: "LineString", coordinates: coords } : null;
  } catch {
    return null;
  }
}

// Trip Detail

export async function getTrip(tripId: string): Promise<VehicleJourney | null> {
  const rawId = stripPrefix(tripId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data: any = await client.trip(rawId, { stopovers: true });
    const trip = data.trip ?? data;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const stopovers: any[] = trip.stopovers ?? [];
    const stops: VehicleJourneyStop[] = stopovers.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (s: any): VehicleJourneyStop => ({
        stopId: `${PREFIX}${s.stop?.id ?? ""}`,
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

    return {
      id: `${PREFIX}${trip.id ?? rawId}`,
      name: trip.line?.name ?? trip.direction ?? "",
      provider: "db",
      remarks: normalizeRemarks(trip.remarks),
      stops,
    };
  } catch {
    return null;
  }
}
