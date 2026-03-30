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
} from "@openmapx/core";
import {
  mapProducts,
  normalizeFptfDeparture,
  normalizeRemarks,
  productToMode,
} from "@openmapx/core";
import { createClient } from "db-vendo-client";
import { profile as dbProfile } from "db-vendo-client/p/db/index.js";

const PREFIX = "db:";

// biome-ignore lint/suspicious/noExplicitAny: external untyped package
const client: any = createClient(
  dbProfile,
  process.env.DB_USER_AGENT ?? "OpenMapX/1.0 (transit@openmapx.org)",
  { enrichStations: true },
);

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
  const polyFeature = leg.polyline?.features?.[0]?.geometry;
  if (polyFeature?.type === "LineString" && Array.isArray(polyFeature.coordinates)) {
    geometry = polyFeature as GeoJSONLineString;
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
    const dt = new Date(`${date}T${time}`);
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
        // Note: polylines are NOT supported in journeys() for db-vendo-client;
        // only in refreshJourney() and trip(). Geometry falls back to straight lines.
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
