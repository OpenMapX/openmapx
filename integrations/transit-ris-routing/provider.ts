/**
 * RIS::Routing provider — Deutsche Bahn's official journey planner.
 * The backend powering bahn.de and DB Navigator.
 *
 * Slots into the planTrip chain as a regional provider for Germany.
 * Uses the shared DB RIS client for authentication.
 */

import { decodePolyline } from "@openmapx/core";
import type {
  GeoJSONLineString,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
} from "@openmapx/mobility-core/transit";
import { isRisConfigured, risPost } from "./ris-client.js";

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
  duration?: string; // ISO-8601 PT duration
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

// ISO-8601 duration parsing (PT1H23M40S → seconds)

export function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
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

function makeGeometry(
  polyline?: string,
  from?: RisStopEvent,
  to?: RisStopEvent,
): GeoJSONLineString {
  if (polyline) {
    const coords = decodePolyline(polyline, 5);
    if (coords.length >= 2) return { type: "LineString", coordinates: coords };
  }
  // Straight line fallback
  const fromPos = from?.position ?? { latitude: 0, longitude: 0 };
  const toPos = to?.position ?? { latitude: 0, longitude: 0 };
  return {
    type: "LineString",
    coordinates: [
      [fromPos.longitude, fromPos.latitude],
      [toPos.longitude, toPos.latitude],
    ],
  };
}

function resolveStopEvent(event?: RisStopEvent): {
  name: string;
  lat: number;
  lng: number;
  stopId?: string;
} {
  return {
    name: event?.name ?? "",
    lat: event?.position?.latitude ?? 0,
    lng: event?.position?.longitude ?? 0,
    stopId: event?.evaNumber ? `${PREFIX}${event.evaNumber}` : undefined,
  };
}

export function mapLeg(leg: RisLeg): TripLeg | null {
  // Skip CONNECT legs (transfer evaluation entries, not visual legs)
  if (leg.type === "CONNECT") return null;

  const isTransit = leg.type === "JOURNEY";
  const origin = leg.departure ?? leg.origin;
  const dest = leg.arrival ?? leg.destination;
  const mode: TransportMode = isTransit
    ? (CATEGORY_MODE[leg.transport?.category ?? ""] ?? "rail")
    : "walking";

  const result: TripLeg = {
    mode,
    startTime: origin?.time ?? origin?.timeSchedule ?? "",
    endTime: dest?.time ?? dest?.timeSchedule ?? "",
    from: resolveStopEvent(origin),
    to: resolveStopEvent(dest),
    geometry: makeGeometry(leg.polyline, origin, dest),
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

export function mapTrip(trip: RisTrip): TripItinerary {
  const legs = (trip.legs ?? []).map(mapLeg).filter((l): l is TripLeg => l !== null);
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

export function isConfigured(): boolean {
  return isRisConfigured();
}

/**
 * RIS::Routing's request schema for a mode allow-list or the Deutschlandticket
 * filter is undocumented, so the provider can't enforce either constraint. When
 * a request carries one, RIS must step aside so a provider that can honour it
 * (db-vendo's native filter, MOTIS's mode intersection) serves instead — RIS is
 * priority 1, so otherwise it would preempt them and return non-compliant trips.
 */
export function risCanHonor(params: {
  modes?: string[];
  deutschlandticketOnly?: boolean;
}): boolean {
  return !(params.modes && params.modes.length > 0) && !params.deutschlandticketOnly;
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
  lang?: string,
): Promise<TripPlan | null> {
  if (!isConfigured()) return null;

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
      const res = await risPost<RisRoutingResponse>("routing", "/multimodal", body);
      const trips = res.trips ?? [];
      if (trips.length === 0) break;

      for (const trip of trips) {
        allItineraries.push(mapTrip(trip));
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
