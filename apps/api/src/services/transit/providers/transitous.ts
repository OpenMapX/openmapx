import { motisFetch, motisMode, uniqueModes } from "../../../utils/motis.js";
import { decodePolyline } from "../../../utils/polyline.js";
import type {
  BBox,
  Departure,
  GeoJSONLineString,
  TransitRoute,
  TransitStop,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "../types";

const BASE_URL = process.env.TRANSITOUS_URL ?? "https://api.transitous.org";
const TIMEOUT_MS = 8_000;
const PREFIX = "mo:";
/**
 * Attribution: Transitous is a community-maintained open-source project
 * aggregating GTFS feeds. Data is non-commercial use; see transitous.org/api/.
 * Required: User-Agent header with app name and contact.
 */
const USER_AGENT = process.env.TRANSITOUS_USER_AGENT ?? "OpenMapX/1.0 (transit@openmapx.org)";
const PROVIDER = "transitous";

// Internal helpers

function rawId(stopId: string): string {
  return stopId.startsWith(PREFIX) ? stopId.slice(PREFIX.length) : stopId;
}

// biome-ignore lint/suspicious/noExplicitAny: MOTIS API place shape
function normalizeStop(place: any): TransitStop {
  return {
    id: `${PREFIX}${(place.stopId ?? place.id ?? "") as string}`,
    name: (place.name ?? "Unknown") as string,
    lat: (place.lat ?? 0) as number,
    lng: (place.lon ?? 0) as number,
    modes: uniqueModes((place.modes ?? []) as string[]),
    parentStationId: place.parentId ? `${PREFIX}${place.parentId as string}` : undefined,
    provider: PROVIDER,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MOTIS API place shape
function motisPlaceToStop(place: any): VehicleJourneyStop {
  const scheduled = (place.scheduledArrival ?? place.scheduledDeparture) as string | undefined;
  const actual = (place.arrival ?? place.departure) as string | undefined;
  let delaySec: number | undefined;
  if (scheduled && actual && actual !== scheduled) {
    const diff = (new Date(actual).getTime() - new Date(scheduled).getTime()) / 1000;
    if (Number.isFinite(diff)) delaySec = Math.round(diff);
  }
  return {
    stopId: `${PREFIX}${(place.stopId ?? "") as string}`,
    name: (place.name ?? "") as string,
    lat: (place.lat ?? 0) as number,
    lng: (place.lon ?? 0) as number,
    platform: (place.track ?? place.scheduledTrack ?? undefined) as string | undefined,
    scheduledArrival: (place.scheduledArrival ?? undefined) as string | undefined,
    scheduledDeparture: (place.scheduledDeparture ?? undefined) as string | undefined,
    expectedArrival: (place.arrival ?? undefined) as string | undefined,
    expectedDeparture: (place.departure ?? undefined) as string | undefined,
    delaySeconds: delaySec,
    canceled: (place.cancelled ?? false) as boolean,
    departed: actual != null && new Date(actual).getTime() < Date.now(),
  };
}

/**
 * Compute a Departure from a MOTIS StopTime entry.
 * Handles both departures (arriveBy=false) and arrivals (arriveBy=true).
 */
// biome-ignore lint/suspicious/noExplicitAny: MOTIS API StopTime
function normalizeStoptime(st: any, mode: "departure" | "arrival"): Departure {
  const place = st.place ?? {};

  // Use departure or arrival timestamps depending on the query mode
  const scheduledAt =
    mode === "departure"
      ? ((place.scheduledDeparture ?? place.scheduledArrival ?? "") as string)
      : ((place.scheduledArrival ?? place.scheduledDeparture ?? "") as string);

  const actualAt =
    mode === "departure"
      ? ((place.departure ?? place.arrival ?? "") as string)
      : ((place.arrival ?? place.departure ?? "") as string);

  // Only compute delay when realtime data is available
  let delaySeconds: number | undefined;
  let expectedAt: string | undefined;
  if (st.realTime === true && scheduledAt && actualAt && actualAt !== scheduledAt) {
    const diff = (new Date(actualAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
    if (Number.isFinite(diff)) {
      delaySeconds = Math.round(diff);
      expectedAt = actualAt;
    }
  }

  // Platform: use realtime track when available, fall back to scheduled
  const platform = (place.track ?? place.scheduledTrack ?? undefined) as string | undefined;

  return {
    tripId: st.tripId ? `${PREFIX}${st.tripId as string}` : "",
    route: {
      id: `${PREFIX}${(st.routeId ?? "") as string}`,
      shortName: (st.displayName ?? st.routeShortName ?? st.tripShortName ?? "") as string,
      longName: (st.routeLongName ?? "") as string,
      mode: motisMode(st.mode as string | undefined),
      color: (st.routeColor as string | undefined)?.replace(/^#/, "") ?? undefined,
    },
    headsign: (st.headsign ?? "") as string,
    scheduledAt,
    expectedAt,
    delaySeconds,
    platform,
    canceled: (st.cancelled || st.tripCancelled || false) as boolean,
  };
}

// Stops

export async function getStops(bbox: BBox): Promise<TransitStop[]> {
  const [west, south, east, north] = bbox;
  try {
    const data = await motisFetch<
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      any[]
    >(
      BASE_URL,
      "/api/v1/map/stops",
      {
        // MOTIS bbox: min = SW corner (lower-left), max = NE corner (upper-right)
        min: `${south},${west}`,
        max: `${north},${east}`,
      },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data || !Array.isArray(data)) return [];
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    return data.map((place: any) => normalizeStop(place));
  } catch {
    return [];
  }
}

export async function getStopById(stopId: string): Promise<TransitStop | null> {
  const id = rawId(stopId);
  try {
    // MOTIS has no dedicated stop-by-ID endpoint.
    // Query stoptimes with n=0 to retrieve stop metadata from the `place` field
    // without fetching any departure data.
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      BASE_URL,
      "/api/v5/stoptimes",
      { stopId: id, n: "0", window: "0" },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data?.place) return null;
    return normalizeStop(data.place);
  } catch {
    return null;
  }
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  try {
    const data = await motisFetch<
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      any[]
    >(
      BASE_URL,
      "/api/v1/geocode",
      { text: query, type: "STOP" },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data || !Array.isArray(data)) return [];
    return (
      data
        .filter(
          // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
          (place: any) =>
            (place.type === "STOP" || place.type === "STATION") && place.stopId != null,
        )
        .slice(0, limit)
        // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
        .map((place: any) => normalizeStop(place))
    );
  } catch {
    return [];
  }
}

// Departures

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  const id = rawId(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      BASE_URL,
      "/api/v5/stoptimes",
      {
        stopId: id,
        time: new Date().toISOString(),
        n: Math.min(200, Math.max(20, minutes * 2)).toString(),
        window: String(minutes * 60),
        arriveBy: "false",
      },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data?.stopTimes) return [];
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    return (data.stopTimes as any[]).map((st) => normalizeStoptime(st, "departure"));
  } catch {
    return [];
  }
}

// Arrivals

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  const id = rawId(stopId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      BASE_URL,
      "/api/v5/stoptimes",
      {
        stopId: id,
        time: new Date().toISOString(),
        n: Math.min(200, Math.max(20, minutes * 2)).toString(),
        window: String(minutes * 60),
        arriveBy: "true",
      },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data?.stopTimes) return [];
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    return (data.stopTimes as any[]).map((st) => normalizeStoptime(st, "arrival"));
  } catch {
    return [];
  }
}

// Routes for Stop

/**
 * Derive unique routes serving a stop from a 12-hour departure window.
 * MOTIS has no dedicated routes-for-stop endpoint.
 */
export async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
  const departures = await getDepartures(stopId, 720);
  const seen = new Map<string, TransitRoute>();
  for (const dep of departures) {
    const routeId = dep.route.id;
    if (seen.has(routeId)) continue;
    seen.set(routeId, {
      id: routeId,
      shortName: dep.route.shortName,
      longName: dep.route.longName,
      mode: dep.route.mode,
      color: dep.route.color,
      operatorName: "",
    });
  }
  return Array.from(seen.values());
}

// Trip Planning

export async function planTrip(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
): Promise<TripPlan | null> {
  try {
    // MOTIS v5 /plan requires ISO 8601 with timezone (Z suffix).
    const params: Record<string, string> = {
      fromPlace: `${fromLat},${fromLng}`,
      toPlace: `${toLat},${toLng}`,
      numItineraries: "3",
    };
    if (date && time) {
      params.time = `${date}T${time}Z`;
    } else if (date) {
      params.time = `${date}T00:00:00Z`;
    }

    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(BASE_URL, "/api/v5/plan", params, {
      timeoutMs: TIMEOUT_MS,
      userAgent: USER_AGENT,
    });
    if (!data?.itineraries?.length) return null;

    const itineraries: TripItinerary[] =
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API Itinerary
      (data.itineraries as any[]).map((it): TripItinerary => {
        // biome-ignore lint/suspicious/noExplicitAny: MOTIS API Leg
        const rawLegs: any[] = it.legs ?? [];
        const legs: TripLeg[] = rawLegs.map((leg): TripLeg => {
          const mode = motisMode(leg.mode as string | undefined);
          const fromPlace = leg.from ?? {};
          const toPlace = leg.to ?? {};

          // Default straight-line geometry; overridden if polyline present
          let geometry: GeoJSONLineString = {
            type: "LineString",
            coordinates: [
              [(fromPlace.lon ?? 0) as number, (fromPlace.lat ?? 0) as number],
              [(toPlace.lon ?? 0) as number, (toPlace.lat ?? 0) as number],
            ],
          };
          if (leg.legGeometry?.points) {
            // MOTIS uses precision 6 (1e-6 degrees); pass it explicitly
            const precision = (leg.legGeometry.precision ?? 6) as number;
            const decoded = decodePolyline(leg.legGeometry.points as string, precision);
            if (decoded.length >= 2) {
              geometry = { type: "LineString", coordinates: decoded };
            }
          }

          // Transit legs have route info; walk legs do not
          const isTransit = !!(leg.routeShortName || leg.routeLongName || leg.routeId);

          return {
            mode,
            startTime: (leg.startTime ?? "") as string,
            endTime: (leg.endTime ?? "") as string,
            from: {
              name: (fromPlace.name ?? "") as string,
              lat: (fromPlace.lat ?? 0) as number,
              lng: (fromPlace.lon ?? 0) as number,
              stopId: fromPlace.stopId ? `${PREFIX}${fromPlace.stopId as string}` : undefined,
            },
            to: {
              name: (toPlace.name ?? "") as string,
              lat: (toPlace.lat ?? 0) as number,
              lng: (toPlace.lon ?? 0) as number,
              stopId: toPlace.stopId ? `${PREFIX}${toPlace.stopId as string}` : undefined,
            },
            route: isTransit
              ? {
                  shortName: (leg.displayName ??
                    leg.routeShortName ??
                    leg.tripShortName ??
                    "") as string,
                  longName: (leg.routeLongName ?? "") as string,
                  color: (leg.routeColor as string | undefined)?.replace(/^#/, "") ?? undefined,
                }
              : undefined,
            geometry,
            tripId: isTransit && leg.tripId ? `${PREFIX}${leg.tripId as string}` : undefined,
            routeId: isTransit && leg.routeId ? `${PREFIX}${leg.routeId as string}` : undefined,
            _intermediateStopCount: Array.isArray(leg.intermediateStops)
              ? (leg.intermediateStops as unknown[]).length
              : undefined,
          };
        });

        const startTime = legs[0]?.startTime ?? "";
        const endTime = legs[legs.length - 1]?.endTime ?? "";
        // Prefer the API-supplied transfer count; fall back to counting transit legs
        const transfers =
          typeof it.transfers === "number"
            ? it.transfers
            : Math.max(0, legs.filter((l) => l.route).length - 1);

        // Sum walk distances from raw leg data (walk legs expose `distance` in meters)
        const walkDistance = rawLegs
          // biome-ignore lint/suspicious/noExplicitAny: MOTIS API Leg
          .filter((l: any) => !l.routeShortName && !l.routeLongName && !l.routeId)
          // biome-ignore lint/suspicious/noExplicitAny: MOTIS API Leg
          .reduce((sum: number, l: any) => sum + ((l.distance ?? 0) as number), 0);

        return {
          duration: (it.duration ?? 0) as number,
          startTime,
          endTime,
          transfers,
          walkDistance: Math.round(walkDistance),
          legs,
        };
      });

    const from = data.from ?? {};
    const to = data.to ?? {};

    return {
      from: {
        name: (from.name ?? "") as string,
        lat: (from.lat ?? fromLat) as number,
        lng: (from.lon ?? fromLng) as number,
      },
      to: {
        name: (to.name ?? "") as string,
        lat: (to.lat ?? toLat) as number,
        lng: (to.lon ?? toLng) as number,
      },
      itineraries,
    };
  } catch {
    return null;
  }
}

// Vehicle Radar

/**
 * Fetch live vehicle positions from the MOTIS map/trips endpoint.
 *
 * The endpoint returns trip segments (from→to pairs with a departure time
 * and polyline). Each segment corresponds to a transit vehicle currently
 * operating in the bbox. Since MOTIS does not provide explicit GPS coordinates,
 * we use the departure stop location as an approximation of the current position.
 *
 * Attribution: data comes from the same GTFS/GTFS-RT feeds as other Transitous data.
 */
export async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
  const [west, south, east, north] = bbox;
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 5 * 60 * 1000);

    const data = await motisFetch<
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      any[]
    >(
      BASE_URL,
      "/api/v5/map/trips",
      {
        min: `${south},${west}`,
        max: `${north},${east}`,
        startTime: now.toISOString(),
        endTime: windowEnd.toISOString(),
        zoom: "12",
      },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data || !Array.isArray(data)) return [];

    return (
      data
        // biome-ignore lint/suspicious/noExplicitAny: MOTIS API TripSegment
        .map((seg: any, idx: number): VehiclePosition | null => {
          // Each segment has a trips[] array; the first entry is the vehicle we care about
          const trip = seg.trips?.[0];
          const from = seg.from ?? {};

          if (!from.lat || !from.lon) return null;

          return {
            // Use trip ID if available; fall back to index-based ID
            id: `${PREFIX}${(trip?.tripId ?? `seg-${idx}`) as string}`,
            provider: PROVIDER,
            tripId: trip?.tripId ? `${PREFIX}${trip.tripId as string}` : undefined,
            // MOTIS map/trips does not include an explicit route ID on segments
            lat: from.lat as number,
            lng: from.lon as number,
            // Direction label from the trip entry
            label: ((trip?.displayName ?? "") as string) || undefined,
            currentStopId: from.stopId ? `${PREFIX}${from.stopId as string}` : undefined,
            // Use actual departure time as the "updated at" timestamp
            updatedAt: (seg.departure ?? now.toISOString()) as string,
          };
        })
        .filter((v): v is VehiclePosition => v !== null)
    );
  } catch {
    return [];
  }
}

// Trip Detail

export async function getTrip(tripId: string): Promise<VehicleJourney | null> {
  const id = rawId(tripId);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const data = await motisFetch<any>(
      BASE_URL,
      "/api/v5/trip",
      { tripId: id },
      { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT },
    );
    if (!data?.legs) return null;
    // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
    const legs: any[] = data.legs;
    const stops: VehicleJourneyStop[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (i === 0) stops.push(motisPlaceToStop(leg.from));
      // biome-ignore lint/suspicious/noExplicitAny: MOTIS API response
      for (const place of (leg.intermediateStops ?? []) as any[]) {
        stops.push(motisPlaceToStop(place));
      }
      stops.push(motisPlaceToStop(leg.to));
    }
    const firstLeg = legs[0];
    return {
      id: `${PREFIX}${id}`,
      name: (firstLeg?.routeShortName ?? firstLeg?.headsign ?? id) as string,
      provider: PROVIDER,
      stops,
    };
  } catch {
    return null;
  }
}
