/**
 * RIS::Routing provider — Deutsche Bahn's official journey planner.
 * The backend powering bahn.de and DB Navigator.
 *
 * Slots into the planTrip chain as a regional provider for Germany.
 * Uses the shared DB RIS client for authentication.
 */

import { decodePolyline, isoWithOffsetInZone } from "@openmapx/core";
import { type LatLng, latLngOrNull } from "@openmapx/core/coordinates";
import { isTransitModeRestriction } from "@openmapx/integration-framework";
import { parseElapsedDurationSeconds } from "@openmapx/mobility-core/duration";
import type { RisClient } from "@openmapx/mobility-core/ris-client";
import type {
  GeoJSONLineString,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
} from "@openmapx/mobility-core/transit";

const PREFIX = "ris:";

// RIS API types (internal)

interface RisLocation {
  type: "COORDINATE" | "STOP_PLACE";
  latitude?: number;
  longitude?: number;
  evaNumber?: string;
  name?: string;
}

interface RisTransport {
  category?: string;
  line?: string;
  number?: string;
  direction?: string;
}

interface RisStopEvent {
  time?: string;
  timeSchedule?: string;
  timeType?: string;
  platform?: string;
  platformSchedule?: string;
  name?: string;
  position?: { latitude: number; longitude: number };
  evaNumber?: string;
}

interface RisLeg {
  type: string; // WALK, BIKE, TAXI, JOURNEY, CONNECT
  origin?: RisStopEvent;
  destination?: RisStopEvent;
  departure?: RisStopEvent;
  arrival?: RisStopEvent;
  duration?: string; // Fixed elapsed ISO-8601 day/time duration
  transport?: RisTransport;
  polyline?: string; // Google Encoded Polyline
  journeyID?: string;
  viaStops?: RisStopEvent[];
}

interface RisConnectionEvaluation {
  persona?: string;
  connectionResult?: string; // SAFE, CRITICAL, IMPOSSIBLE
}

interface RisTrip {
  duration?: string;
  startDate?: string;
  extTripID?: string;
  legs?: RisLeg[];
  connectionStatus?: RisConnectionEvaluation[];
  navigationContext?: string;
}

interface RisRoutingResponse {
  trips?: RisTrip[];
  navigationContext?: string;
}

// Category → mode mapping

const CATEGORY_MODE: Record<string, TransportMode> = {
  HIGH_SPEED_TRAIN: "rail",
  INTERCITY_TRAIN: "rail",
  INTER_REGIONAL_TRAIN: "rail",
  REGIONAL_TRAIN: "rail",
  CITY_TRAIN: "rail",
  SUBURBAN: "rail",
  SUBWAY: "subway",
  TRAM: "tram",
  BUS: "bus",
  FERRY: "ferry",
};

// Keep the provider's zero fallback while sharing the elapsed-duration grammar.

export function parseDuration(iso: string | undefined): number {
  return parseElapsedDurationSeconds(iso) ?? 0;
}

// Language mapping

const LANG_MAP: Record<string, string> = {
  de: "DE",
  en: "EN",
  fr: "FR",
  it: "IT",
  cs: "CS",
  da: "DA",
  es: "ES",
  nl: "NL",
  pl: "PL",
};

export function mapLang(lang?: string): string {
  if (!lang) return "EN";
  return LANG_MAP[lang.toLowerCase()] ?? "EN";
}

// Leg mapping

/** An event's position, or null when RIS gave none in range. */
function eventPosition(event?: RisStopEvent): LatLng | null {
  return latLngOrNull(event?.position?.latitude, event?.position?.longitude);
}

function makeGeometry(
  polyline: string | undefined,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): GeoJSONLineString {
  if (polyline) {
    const coords = decodePolyline(polyline, 5);
    if (coords.length >= 2) return { type: "LineString", coordinates: coords };
  }
  // Straight line fallback
  return {
    type: "LineString",
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
  };
}

function resolveStopEvent(
  event: RisStopEvent | undefined,
  at: { lat: number; lng: number },
): {
  name: string;
  lat: number;
  lng: number;
  stopId?: string;
} {
  return {
    name: event?.name ?? "",
    lat: at.lat,
    lng: at.lng,
    stopId: event?.evaNumber ? `${PREFIX}${event.evaNumber}` : undefined,
  };
}

/**
 * A trip leg, or null for a CONNECT leg (a transfer evaluation, not a leg to
 * draw) and for a leg whose ends RIS did not place or time.
 */
export function mapLeg(leg: RisLeg): TripLeg | null {
  // Skip CONNECT legs (transfer evaluation entries, not visual legs)
  if (leg.type === "CONNECT") return null;

  const isTransit = leg.type === "JOURNEY";
  const origin = leg.departure ?? leg.origin;
  const dest = leg.arrival ?? leg.destination;
  const from = eventPosition(origin);
  const to = eventPosition(dest);
  const startTime = origin?.time ?? origin?.timeSchedule;
  const endTime = dest?.time ?? dest?.timeSchedule;
  if (!from || !to || !startTime || !endTime) return null;
  const mode: TransportMode = isTransit
    ? (CATEGORY_MODE[leg.transport?.category ?? ""] ?? "rail")
    : "walking";

  const result: TripLeg = {
    mode,
    startTime,
    endTime,
    from: resolveStopEvent(origin, from),
    to: resolveStopEvent(dest, to),
    geometry: makeGeometry(leg.polyline, from, to),
  };

  if (isTransit && leg.transport) {
    result.route = {
      shortName: leg.transport.line ?? leg.transport.number ?? "",
      longName: leg.transport.direction ?? "",
    };
    if (leg.journeyID) {
      result.tripId = `${PREFIX}${leg.journeyID}`;
    }
    if (leg.viaStops) {
      result._intermediateStopCount = leg.viaStops.length;
    }
  }

  return result;
}

/** An itinerary, or null when a leg other than a CONNECT cannot be placed or timed. */
export function mapTrip(trip: RisTrip): TripItinerary | null {
  const legs: TripLeg[] = [];
  for (const raw of trip.legs ?? []) {
    if (raw.type === "CONNECT") continue;
    const leg = mapLeg(raw);
    if (!leg) return null;
    legs.push(leg);
  }
  if (legs.length === 0) return null;
  const startTime = legs[0]?.startTime ?? "";
  const endTime = legs[legs.length - 1]?.endTime ?? "";
  const durationMs =
    startTime && endTime ? new Date(endTime).getTime() - new Date(startTime).getTime() : 0;
  const duration = durationMs > 0 ? Math.round(durationMs / 1000) : parseDuration(trip.duration);
  const transfers = Math.max(0, legs.filter((l) => l.route !== undefined).length - 1);
  // Estimate walk distance from walk leg durations at 5 km/h
  const walkLegs = (trip.legs ?? []).filter((l) => l.type === "WALK" || l.type === "BIKE");
  const walkDistance = walkLegs.reduce(
    (sum, l) => sum + parseDuration(l.duration) * (5000 / 3600),
    0,
  );

  return {
    duration,
    startTime,
    endTime,
    transfers,
    walkDistance: Math.round(walkDistance),
    legs,
  };
}

// Public API

/**
 * RIS::Routing's request schema for a mode allow-list or the Deutschlandticket
 * filter is undocumented, so the provider can't enforce either constraint. When
 * a request carries one (the all-transit default is not a restriction), RIS must step aside so a provider that can honour it
 * (MOTIS's mode intersection) serves instead — RIS is
 * priority 1, so otherwise it would preempt them and return non-compliant trips.
 */
export function risCanHonor(params: {
  modes?: string[];
  deutschlandticketOnly?: boolean;
}): boolean {
  return !isTransitModeRestriction(params.modes) && !params.deutschlandticketOnly;
}

const GERMAN_TIME_ZONE = "Europe/Berlin";

/**
 * RIS::Routing takes a date-time without an offset. Its public documentation
 * does not name the zone; this assumes German local time, as for the DB journey
 * planners it backs, and renders the planning instant on the Berlin wall clock,
 * including across daylight-saving changes. Confirm with a keyed request.
 */
export function germanWallClock(instant: Date): { date: string; time: string } {
  if (!Number.isFinite(instant.getTime()))
    throw Object.assign(new Error("invalid planning time"), { code: "invalid_request" });
  const local = isoWithOffsetInZone(instant, GERMAN_TIME_ZONE);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

export async function planJourney(
  risClient: RisClient,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
  arriveBy?: boolean,
  numItineraries?: number,
  lang?: string,
): Promise<TripPlan | null> {
  if (!risClient.isConfigured()) return null;

  const origin: RisLocation = { type: "COORDINATE", latitude: fromLat, longitude: fromLng };
  const destination: RisLocation = { type: "COORDINATE", latitude: toLat, longitude: toLng };
  const dt = `${date}T${time}`;
  const target = Math.min(numItineraries ?? 3, 5);

  const allItineraries: TripItinerary[] = [];
  let navContext: string | undefined;
  const deadline = Date.now() + 15_000;

  for (let i = 0; i < target; i++) {
    if (Date.now() > deadline) break;

    const body: Record<string, unknown> = {
      origin,
      destination,
      provider: "HAFAS",
      includePolyLines: true,
      includeViaStops: true,
      language: mapLang(lang),
    };

    if (arriveBy) {
      body.arrivalTime = dt;
    } else {
      body.departureTime = dt;
    }

    if (navContext) {
      body.navigationContext = navContext;
    }

    try {
      const res = await risClient.post<RisRoutingResponse>("routing", "/multimodal", body);
      const trips = res.trips ?? [];
      if (trips.length === 0) break;

      for (const trip of trips) {
        const itinerary = mapTrip(trip);
        if (itinerary) allItineraries.push(itinerary);
      }

      navContext = res.navigationContext;
      if (!navContext) break;
    } catch {
      break;
    }
  }

  if (allItineraries.length === 0) return null;

  const first = allItineraries[0].legs[0];
  const lastIt = allItineraries[0];
  const last = lastIt.legs[lastIt.legs.length - 1];

  return {
    from: {
      name: first?.from.name ?? "",
      lat: first?.from.lat ?? fromLat,
      lng: first?.from.lng ?? fromLng,
    },
    to: {
      name: last?.to.name ?? "",
      lat: last?.to.lat ?? toLat,
      lng: last?.to.lng ?? toLng,
    },
    itineraries: allItineraries,
  };
}
