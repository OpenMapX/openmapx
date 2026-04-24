import {
  type Departure,
  decodePolyline,
  type GeoJSONLineString,
  otpMode,
  type TransitStop,
  type TripItinerary,
  type TripLeg,
  type TripPlan,
} from "@openmapx/core";
import type { ProtocolAdapter } from "./adapter-types";
import type { RegistryEntry } from "./registry-types";

const TIMEOUT_MS = 8_000;
const ENTUR_CLIENT_NAME = "openmapx-server";

// GraphQL fetch

async function graphqlFetch(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    return json.data ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// Queries

const NEARBY_QUERY = `
query NearbyStops($lat: Float!, $lon: Float!, $maxDistance: Int!, $first: Int!) {
  nearest(lat: $lat, lon: $lon, maxDistance: $maxDistance, filterByPlaceTypes: [STOP], first: $first) {
    edges {
      node {
        place {
          ... on Stop {
            gtfsId
            name
            lat
            lon
            vehicleMode
            parentStation { gtfsId }
            platformCode
          }
        }
        distance
      }
    }
  }
}`;

/**
 * Shared stoptime fragment for both departures and arrivals.
 * We request both arrival and departure seconds so we can use the right one.
 * realtimeState is used to detect cancellations (no `canceled` field on Stoptime).
 */
const STOPTIME_FIELDS = `
  scheduledArrival
  scheduledDeparture
  realtimeArrival
  realtimeDeparture
  realtime
  realtimeState
  arrivalDelay
  departureDelay
  serviceDay
  headsign
  trip {
    gtfsId
    route {
      gtfsId
      shortName
      longName
      mode
      color
    }
  }
`;

const DEPARTURES_QUERY = `
query StopDepartures($id: String!, $numberOfDepartures: Int!, $timeRange: Int!) {
  stop(id: $id) {
    stoptimesWithoutPatterns(
      numberOfDepartures: $numberOfDepartures
      timeRange: $timeRange
      omitCanceled: false
    ) {
      ${STOPTIME_FIELDS}
    }
  }
}`;

const STOP_SEARCH_QUERY = `
query StopSearch($name: String!) {
  stops(name: $name) {
    gtfsId
    name
    lat
    lon
    vehicleMode
    parentStation { gtfsId }
    platformCode
  }
}`;

const STOP_BY_ID_QUERY = `
query StopById($id: String!) {
  stop(id: $id) {
    gtfsId
    name
    lat
    lon
    vehicleMode
    parentStation { gtfsId }
    platformCode
  }
}`;

/**
 * Alert fields confirmed in OTP 2 schema.
 * alertSeverityLevel: INFO | WARNING | SEVERE | UNKNOWN_SEVERITY
 * effectiveStartDate / effectiveEndDate: Unix timestamps (Long).
 */
const ALERT_FIELDS = `
  id
  alertSeverityLevel
  alertEffect
  alertHeaderText
  alertDescriptionText
  effectiveStartDate
  effectiveEndDate
`;

const STOP_ALERTS_QUERY = `
query StopAlerts($id: String!) {
  stop(id: $id) {
    alerts {
      ${ALERT_FIELDS}
    }
  }
}`;

const ROUTE_ALERTS_QUERY = `
query RouteAlerts($id: String!) {
  route(id: $id) {
    alerts {
      ${ALERT_FIELDS}
    }
  }
}`;

const PLAN_QUERY = `
query PlanTrip($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!, $date: String!, $time: String!, $numItineraries: Int!, $arriveBy: Boolean!) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    numItineraries: $numItineraries
    arriveBy: $arriveBy
    transportModes: [
      { mode: TRANSIT }
      { mode: WALK }
    ]
  ) {
    from { name lat lon }
    to { name lat lon }
    itineraries {
      duration
      startTime
      endTime
      walkDistance
      legs {
        mode
        transitLeg
        startTime
        endTime
        distance
        from { name lat lon stop { gtfsId } }
        to { name lat lon stop { gtfsId } }
        route { shortName longName color }
        trip { gtfsId }
        legGeometry { points }
        intermediateStops { gtfsId }
      }
    }
  }
}`;

// Helpers

/** OTP serviceDay (local midnight, Unix) + seconds-from-midnight → ISO 8601 UTC */
function secondsToIso(serviceDay: number, seconds: number): string {
  return new Date((serviceDay + seconds) * 1000).toISOString();
}

function getEndpoint(entry: RegistryEntry): string {
  return (entry.options.endpoint as string) ?? "";
}

function getHeaders(entry: RegistryEntry): Record<string, string> {
  const headers: Record<string, string> = {
    // Entur (Norwegian OTP instances) uses ET-Client-Name for rate limiting
    "ET-Client-Name": ENTUR_CLIENT_NAME,
  };
  if (entry.options.apiKey) {
    headers.Authorization = `Bearer ${entry.options.apiKey as string}`;
  }
  return headers;
}

// biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL Stop shape
function normalizeStop(stop: any, entry: RegistryEntry): TransitStop {
  return {
    id: `${entry.prefix}${stop.gtfsId as string}`,
    name: (stop.name ?? "Unknown") as string,
    lat: (stop.lat ?? 0) as number,
    lng: (stop.lon ?? 0) as number,
    modes: [otpMode(stop.vehicleMode as string)],
    platformCode: (stop.platformCode ?? undefined) as string | undefined,
    parentStationId: stop.parentStation?.gtfsId
      ? `${entry.prefix}${stop.parentStation.gtfsId as string}`
      : undefined,
    provider: entry.slug,
  };
}

/**
 * Map OTP alertSeverityLevel to our AlertSeverity.
 * OTP: UNKNOWN_SEVERITY | INFO | WARNING | SEVERE
 */
function mapAlertSeverity(level: string | undefined): "info" | "warning" | "severe" | "critical" {
  switch (level) {
    case "SEVERE":
      return "severe";
    case "WARNING":
      return "warning";
    case "INFO":
      return "info";
    default:
      return "info";
  }
}

// Stoptime normalisation (shared for departures & arrivals)

type StoptimeMode = "departure" | "arrival";

// biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL Stoptime
function normalizeStoptime(st: any, entry: RegistryEntry, mode: StoptimeMode): Departure {
  const route = st.trip?.route ?? {};
  const serviceDay = (st.serviceDay ?? 0) as number;

  // Choose the right time fields depending on whether we're listing departures or arrivals
  const scheduledSeconds =
    mode === "departure" ? (st.scheduledDeparture ?? 0) : (st.scheduledArrival ?? 0);
  const realtimeSeconds =
    mode === "departure"
      ? (st.realtimeDeparture ?? st.scheduledDeparture ?? 0)
      : (st.realtimeArrival ?? st.scheduledArrival ?? 0);
  const delaySeconds =
    st.realtime === true
      ? ((mode === "departure" ? st.departureDelay : st.arrivalDelay) ?? 0)
      : undefined;

  const scheduledAt = secondsToIso(serviceDay, scheduledSeconds as number);
  const expectedAt =
    delaySeconds !== undefined ? secondsToIso(serviceDay, realtimeSeconds as number) : undefined;

  // OTP exposes cancellation via realtimeState rather than a boolean field
  const canceled = (st.realtimeState as string) === "CANCELED";

  return {
    tripId: st.trip?.gtfsId ? `${entry.prefix}${st.trip.gtfsId as string}` : "",
    route: {
      id: `${entry.prefix}${(route.gtfsId ?? "") as string}`,
      shortName: (route.shortName ?? "") as string,
      longName: (route.longName ?? "") as string,
      mode: otpMode(route.mode as string),
      color: route.color ? (route.color as string).replace(/^#/, "") : undefined,
    },
    headsign: (st.headsign ?? "") as string,
    scheduledAt,
    expectedAt,
    delaySeconds,
    canceled,
  };
}

// Adapter

export const otpGraphQlAdapter: ProtocolAdapter = {
  async getStopsNearby(entry, lat, lng, radiusMeters) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return [];

      const data = (await graphqlFetch(
        endpoint,
        NEARBY_QUERY,
        { lat, lon: lng, maxDistance: Math.round(radiusMeters), first: 30 },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!data?.nearest?.edges) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      return (data.nearest.edges as any[])
        .map((edge) => edge.node?.place)
        .filter((place) => place?.gtfsId)
        .map((stop) => normalizeStop(stop, entry));
    } catch {
      return [];
    }
  },

  async getStopById(entry, stopId) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return null;

      const rawId = stopId.startsWith(entry.prefix) ? stopId.slice(entry.prefix.length) : stopId;

      const data = (await graphqlFetch(
        endpoint,
        STOP_BY_ID_QUERY,
        { id: rawId },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!data?.stop) return null;
      return normalizeStop(data.stop, entry);
    } catch {
      return null;
    }
  },

  async getDepartures(entry, stopId, minutes) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return [];

      const rawId = stopId.startsWith(entry.prefix) ? stopId.slice(entry.prefix.length) : stopId;
      const numberOfDepartures = Math.min(200, Math.max(20, minutes * 2));
      const timeRange = minutes * 60;

      const data = (await graphqlFetch(
        endpoint,
        DEPARTURES_QUERY,
        { id: rawId, numberOfDepartures, timeRange },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!data?.stop?.stoptimesWithoutPatterns) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      return (data.stop.stoptimesWithoutPatterns as any[]).map((st) =>
        normalizeStoptime(st, entry, "departure"),
      );
    } catch {
      return [];
    }
  },

  async getArrivals(entry, stopId, minutes) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return [];

      // OTP's stoptimesWithoutPatterns returns both arrival and departure seconds.
      // We reuse the same query but map scheduledArrival / realtimeArrival / arrivalDelay.
      const rawId = stopId.startsWith(entry.prefix) ? stopId.slice(entry.prefix.length) : stopId;
      const numberOfDepartures = Math.min(200, Math.max(20, minutes * 2));
      const timeRange = minutes * 60;

      const data = (await graphqlFetch(
        endpoint,
        DEPARTURES_QUERY,
        { id: rawId, numberOfDepartures, timeRange },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!data?.stop?.stoptimesWithoutPatterns) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      return (data.stop.stoptimesWithoutPatterns as any[]).map((st) =>
        normalizeStoptime(st, entry, "arrival"),
      );
    } catch {
      return [];
    }
  },

  async searchByName(entry, query, limit) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return [];

      // OTP's stops(name:) returns all matching stops (no server-side limit param).
      // We slice to `limit` client-side.
      const data = (await graphqlFetch(
        endpoint,
        STOP_SEARCH_QUERY,
        { name: query },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!Array.isArray(data?.stops)) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      return (data.stops as any[])
        .filter((s) => s?.gtfsId)
        .slice(0, limit)
        .map((s) => normalizeStop(s, entry));
    } catch {
      return [];
    }
  },

  async getAlerts(entry, params) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      let rawAlerts: any[] = [];

      if (params?.routeId) {
        const rawRouteId = params.routeId.startsWith(entry.prefix)
          ? params.routeId.slice(entry.prefix.length)
          : params.routeId;
        const data = (await graphqlFetch(
          endpoint,
          ROUTE_ALERTS_QUERY,
          { id: rawRouteId },
          getHeaders(entry),
          // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
        )) as any;
        rawAlerts = data?.route?.alerts ?? [];
      } else if (params?.stopId) {
        const rawStopId = params.stopId.startsWith(entry.prefix)
          ? params.stopId.slice(entry.prefix.length)
          : params.stopId;
        const data = (await graphqlFetch(
          endpoint,
          STOP_ALERTS_QUERY,
          { id: rawStopId },
          getHeaders(entry),
          // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
        )) as any;
        rawAlerts = data?.stop?.alerts ?? [];
      }

      if (!rawAlerts.length) return [];

      // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL Alert
      return rawAlerts.map((a: any) => ({
        id: (a.id ?? `${entry.slug}:${a.alertHeaderText ?? Math.random()}`) as string,
        providers: [entry.slug],
        severity: mapAlertSeverity(a.alertSeverityLevel as string | undefined),
        effect: (a.alertEffect as string | undefined)?.toLowerCase().replace(/_/g, "-"),
        title: (a.alertHeaderText ?? "") as string,
        description: (a.alertDescriptionText ?? undefined) as string | undefined,
        affectedRouteIds: [],
        affectedStopIds: [],
        activePeriods:
          a.effectiveStartDate != null
            ? [
                {
                  start: new Date((a.effectiveStartDate as number) * 1000).toISOString(),
                  end:
                    a.effectiveEndDate != null
                      ? new Date((a.effectiveEndDate as number) * 1000).toISOString()
                      : undefined,
                },
              ]
            : [],
      }));
    } catch {
      return [];
    }
  },

  // OTP does not expose a vehicle radar endpoint — method intentionally absent.
  // Consumers check for undefined before calling.

  async planJourney(entry, fromLat, fromLng, toLat, toLng, date, time, arriveBy, numItineraries) {
    try {
      const endpoint = getEndpoint(entry);
      if (!endpoint) return null;

      const data = (await graphqlFetch(
        endpoint,
        PLAN_QUERY,
        {
          fromLat,
          fromLon: fromLng,
          toLat,
          toLon: toLng,
          date, // YYYY-MM-DD
          time, // HH:MM:SS
          numItineraries: numItineraries ?? 3,
          arriveBy: arriveBy ?? false,
        },
        getHeaders(entry),
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL response
      )) as any;

      if (!data?.plan?.itineraries?.length) return null;

      const plan = data.plan;
      const itineraries: TripItinerary[] =
        // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL Itinerary
        (plan.itineraries as any[]).map((it): TripItinerary => {
          // biome-ignore lint/suspicious/noExplicitAny: OTP GraphQL Leg
          const legs: TripLeg[] = (it.legs as any[]).map((leg): TripLeg => {
            const mode = otpMode(leg.mode as string);

            // leg.startTime / endTime are millisecond epoch timestamps
            const startTime = new Date(leg.startTime as number).toISOString();
            const endTime = new Date(leg.endTime as number).toISOString();

            let geometry: GeoJSONLineString = {
              type: "LineString",
              coordinates: [
                [leg.from?.lon ?? 0, leg.from?.lat ?? 0],
                [leg.to?.lon ?? 0, leg.to?.lat ?? 0],
              ],
            };
            if (leg.legGeometry?.points) {
              const decoded = decodePolyline(leg.legGeometry.points as string);
              if (decoded.length >= 2) {
                geometry = { type: "LineString", coordinates: decoded };
              }
            }

            // Intermediate stop count for bus-leg road-snapping heuristic
            const _intermediateStopCount = Array.isArray(leg.intermediateStops)
              ? (leg.intermediateStops as unknown[]).length
              : 0;

            return {
              mode,
              startTime,
              endTime,
              from: {
                name: (leg.from?.name ?? "") as string,
                lat: (leg.from?.lat ?? 0) as number,
                lng: (leg.from?.lon ?? 0) as number,
                stopId: leg.from?.stop?.gtfsId
                  ? `${entry.prefix}${leg.from.stop.gtfsId as string}`
                  : undefined,
              },
              to: {
                name: (leg.to?.name ?? "") as string,
                lat: (leg.to?.lat ?? 0) as number,
                lng: (leg.to?.lon ?? 0) as number,
                stopId: leg.to?.stop?.gtfsId
                  ? `${entry.prefix}${leg.to.stop.gtfsId as string}`
                  : undefined,
              },
              // leg.transitLeg is a confirmed OTP 2 boolean field
              route: leg.transitLeg
                ? {
                    shortName: (leg.route?.shortName ?? "") as string,
                    longName: (leg.route?.longName ?? "") as string,
                    color: leg.route?.color
                      ? (leg.route.color as string).replace(/^#/, "")
                      : undefined,
                  }
                : undefined,
              geometry,
              // OTP 2 GraphQL: leg.trip.gtfsId is the prefixed trip ID
              tripId:
                leg.transitLeg && leg.trip?.gtfsId
                  ? `${entry.prefix}${leg.trip.gtfsId as string}`
                  : undefined,
              _intermediateStopCount,
            };
          });

          const startTime = legs[0]?.startTime ?? "";
          const endTime = legs[legs.length - 1]?.endTime ?? "";
          const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);

          return {
            duration: (it.duration ?? 0) as number,
            startTime,
            endTime,
            transfers,
            walkDistance: Math.round((it.walkDistance ?? 0) as number),
            legs,
          };
        });

      return {
        from: {
          name: (plan.from?.name ?? "") as string,
          lat: (plan.from?.lat ?? fromLat) as number,
          lng: (plan.from?.lon ?? fromLng) as number,
        },
        to: {
          name: (plan.to?.name ?? "") as string,
          lat: (plan.to?.lat ?? toLat) as number,
          lng: (plan.to?.lon ?? toLng) as number,
        },
        itineraries,
      } satisfies TripPlan;
    } catch {
      return null;
    }
  },
};
